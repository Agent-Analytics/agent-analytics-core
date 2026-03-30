/**
 * Base database adapter — all SQL and business logic lives here.
 *
 * Subclasses implement 4 primitive DB operations:
 *   _run(sql, params)      — execute write (INSERT/UPDATE/DELETE)
 *   _queryAll(sql, params) — execute read, return array of rows
 *   _queryOne(sql, params) — execute read, return first row or null
 *   _batch(statements)     — execute [{sql, params}, ...] atomically
 */

import { formatDate, today, parseSince, parseSinceMs } from './adapter.js';
import { ulid } from '../ulid.js';
import { AnalyticsError, ERROR_CODES } from '../errors.js';
import {
  buildEventInsertStatement,
  buildIdentifyStatements,
  buildSessionUpsertStatement,
} from './identity-aware.js';
import {
  GRANULARITY, VALID_GRANULARITIES,
  METRICS, ALLOWED_METRICS,
  COUNT_MODES, ALLOWED_COUNT_MODES,
  GROUP_BY_FIELDS, ALLOWED_GROUP_BY,
  FILTER_OPS, FILTERABLE_FIELDS,
  ALLOWED_ORDER_BY,
  DEFAULT_LIMIT, MAX_LIMIT, TOP_EVENTS_LIMIT, MS_PER_DAY,
  DEFAULT_SAMPLE_SIZE, MIN_SAMPLE_SIZE, MAX_SAMPLE_SIZE,
  DAY_NAMES, VALID_PERIODS,
} from '../constants.js';

export function validatePropertyKey(key) {
  if (!key || key.length > 128 || !/^[a-zA-Z0-9_]+$/.test(key)) {
    throw new AnalyticsError(ERROR_CODES.INVALID_PROPERTY_KEY, 'Invalid property filter key', 400);
  }
}

function resolveCountMode(metrics, count_mode) {
  if (count_mode !== undefined && !ALLOWED_COUNT_MODES.includes(count_mode)) {
    throw new AnalyticsError(
      ERROR_CODES.INVALID_COUNT_MODE,
      `invalid count_mode: ${count_mode}. allowed: ${ALLOWED_COUNT_MODES.join(', ')}`,
      400,
    );
  }

  if (count_mode !== undefined) return count_mode;
  return metrics.includes(METRICS.EVENT_COUNT) ? COUNT_MODES.SESSION_THEN_USER : COUNT_MODES.RAW;
}

function buildEventCountSelect(countMode, groupBy = []) {
  if (countMode === COUNT_MODES.RAW) return 'COUNT(*) as event_count';
  return buildSessionThenUserEventCountSelect(groupBy);
}

function buildNullSafeEquality(column, leftAlias, rightAlias) {
  return `((${leftAlias}.${column} = ${rightAlias}.${column}) OR (${leftAlias}.${column} IS NULL AND ${rightAlias}.${column} IS NULL))`;
}

function buildSessionThenUserEventCountSelect(groupBy = []) {
  const sameGroupConditions = groupBy
    .map((column) => buildNullSafeEquality(column, 'other', 'current'))
    .join(' AND ');
  const sameGroupClause = sameGroupConditions ? `\n        AND ${sameGroupConditions}` : '';

  return `COUNT(DISTINCT CASE
    WHEN current.session_id IS NOT NULL AND current.user_id IS NOT NULL THEN 'u:' || current.user_id || ':s:' || current.session_id
    WHEN current.session_id IS NOT NULL THEN 's:' || current.session_id
    WHEN current.user_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM filtered other
      WHERE other.user_id = current.user_id
        AND other.session_id IS NOT NULL${sameGroupClause}
    ) THEN NULL
    WHEN current.user_id IS NOT NULL THEN 'u:' || current.user_id
    ELSE 'e:' || current.id
  END) as event_count`;
}

export class BaseAdapter {

  // --- Abstract primitives (subclasses MUST override) ---

  async _run(sql, params) { throw new Error('_run not implemented'); }
  async _queryAll(sql, params) { throw new Error('_queryAll not implemented'); }
  async _queryOne(sql, params) { throw new Error('_queryOne not implemented'); }
  async _batch(statements) { throw new Error('_batch not implemented'); }

  _buildWhere(project, fromDate, filters = []) {
    const parts = ['project_id = ?', 'date >= ?'];
    const params = [project, fromDate];
    for (const [cond, val] of filters) {
      if (val != null) { parts.push(cond); params.push(val); }
    }
    return { clause: parts.join(' AND '), params };
  }

  // --- Session upsert SQL builder ---

  _sessionUpsertSqlAndParams(project, event_data) {
    return buildSessionUpsertStatement({
      project,
      session_id: event_data.session_id,
      user_id: event_data.user_id,
      timestamp: event_data.timestamp,
      properties: event_data.properties,
      count: event_data._count || 1,
    });
  }

  // --- Write methods ---

  async trackEvent({ project, event, properties, user_id, session_id, timestamp }) {
    const eventStatement = buildEventInsertStatement({
      id: ulid(),
      project,
      event,
      properties,
      user_id,
      session_id,
      timestamp,
    });

    if (!session_id) {
      return this._run(eventStatement.sql, eventStatement.params);
    }

    const session = this._sessionUpsertSqlAndParams(project, { session_id, user_id, timestamp, properties });
    return this._batch([
      eventStatement,
      { sql: session.sql, params: session.params },
    ]);
  }

  async trackBatch(events) {
    const stmts = [];

    for (const e of events) {
      stmts.push(buildEventInsertStatement({
        id: ulid(),
        ...e,
      }));
    }

    for (const e of events) {
      if (!e.session_id) continue;
      const ts = e.timestamp || Date.now();
      stmts.push(this._sessionUpsertSqlAndParams(e.project, {
        session_id: e.session_id,
        user_id: e.user_id,
        timestamp: ts,
        properties: e.properties,
      }));
    }

    return this._batch(stmts);
  }

  async upsertSession(sessionData) {
    const { sql, params } = this._sessionUpsertSqlAndParams(
      sessionData.project_id || sessionData.project, sessionData,
    );
    return this._run(sql, params);
  }

  // --- Read methods ---

  async getSessions({ project, since, user_id, is_bounce, limit = DEFAULT_LIMIT }) {
    const fromDate = parseSince(since);
    const safeLimit = Math.min(limit, MAX_LIMIT);
    const { clause, params } = this._buildWhere(project, fromDate, [
      ['user_id = ?', user_id],
      ['is_bounce = ?', is_bounce != null ? Number(is_bounce) : undefined],
    ]);
    params.push(safeLimit);
    return this._queryAll(
      `SELECT * FROM sessions WHERE ${clause} ORDER BY start_time DESC LIMIT ?`, params,
    );
  }

  async getSessionStats({ project, since }) {
    const fromDate = parseSince(since);
    const row = await this._queryOne(
      `SELECT COUNT(*) as total_sessions,
              SUM(CASE WHEN is_bounce = 1 THEN 1 ELSE 0 END) as bounced_sessions,
              SUM(duration) as total_duration,
              SUM(event_count) as total_events,
              COUNT(DISTINCT user_id) as unique_users
       FROM sessions WHERE project_id = ? AND date >= ?`,
      [project, fromDate],
    );

    const total = row?.total_sessions || 0;
    if (total === 0) {
      return { total_sessions: 0, bounce_rate: 0, avg_duration: 0, pages_per_session: 0, sessions_per_user: 0 };
    }

    const uniqueUsers = row.unique_users || 1;
    return {
      total_sessions: total,
      bounce_rate: (row.bounced_sessions || 0) / total,
      avg_duration: Math.round((row.total_duration || 0) / total),
      pages_per_session: Math.round(((row.total_events || 0) / total) * 10) / 10,
      sessions_per_user: Math.round((total / uniqueUsers) * 10) / 10,
    };
  }

  async cleanupSessions({ project, before_date }) {
    return this._run(
      `DELETE FROM sessions WHERE project_id = ? AND date < ?`,
      [project, before_date],
    );
  }

  async getStats({ project, since, groupBy = GRANULARITY.DAY }) {
    const fromDate = parseSince(since);
    const fromMs = parseSinceMs(since);
    if (!VALID_GRANULARITIES.includes(groupBy)) groupBy = GRANULARITY.DAY;

    let bucketExpr;
    if (groupBy === GRANULARITY.HOUR) {
      bucketExpr = `strftime('%Y-%m-%dT%H:00', timestamp / 1000, 'unixepoch')`;
    } else if (groupBy === GRANULARITY.WEEK) {
      bucketExpr = `date(date, 'weekday 0', '-6 days')`;
    } else if (groupBy === GRANULARITY.MONTH) {
      bucketExpr = `strftime('%Y-%m', date)`;
    } else {
      bucketExpr = `date`;
    }

    const dateCol = groupBy === GRANULARITY.HOUR ? 'timestamp' : 'date';
    const bindVal = groupBy === GRANULARITY.HOUR ? fromMs : fromDate;

    const timeSeriesQuery = `SELECT ${bucketExpr} as bucket, COUNT(DISTINCT user_id) as unique_users, COUNT(*) as total_events
       FROM events WHERE project_id = ? AND ${dateCol} >= ?
       GROUP BY bucket ORDER BY bucket`;

    const [timeSeries, eventCounts, totals, sessions] = await Promise.all([
      this._queryAll(timeSeriesQuery, [project, bindVal]),

      this._queryAll(
        `SELECT event, COUNT(*) as count, COUNT(DISTINCT user_id) as unique_users
         FROM events WHERE project_id = ? AND date >= ?
         GROUP BY event ORDER BY count DESC LIMIT ${TOP_EVENTS_LIMIT}`,
        [project, fromDate],
      ),

      this._queryOne(
        `SELECT COUNT(DISTINCT user_id) as unique_users, COUNT(*) as total_events
         FROM events WHERE project_id = ? AND date >= ?`,
        [project, fromDate],
      ),

      this.getSessionStats({ project, since }),
    ]);

    return {
      period: { from: fromDate, to: today(), groupBy },
      totals,
      timeSeries,
      events: eventCounts,
      sessions,
    };
  }

  async getEvents({ project, event, session_id, since, limit = DEFAULT_LIMIT }) {
    const fromDate = parseSince(since);
    const safeLimit = Math.min(limit, MAX_LIMIT);
    const { clause, params } = this._buildWhere(project, fromDate, [
      ['event = ?', event],
      ['session_id = ?', session_id],
    ]);
    params.push(safeLimit);
    const rows = await this._queryAll(
      `SELECT * FROM events WHERE ${clause} ORDER BY timestamp DESC LIMIT ?`, params,
    );
    return rows.map(e => ({ ...e, properties: e.properties ? JSON.parse(e.properties) : null }));
  }

  async query({ project, metrics = [METRICS.EVENT_COUNT], filters, date_from, date_to, group_by = [], order_by, order, limit = DEFAULT_LIMIT, count_mode }) {
    for (const m of metrics) {
      if (!ALLOWED_METRICS.includes(m)) throw new AnalyticsError(ERROR_CODES.INVALID_METRIC, `invalid metric: ${m}. allowed: ${ALLOWED_METRICS.join(', ')}`, 400);
    }
    for (const g of group_by) {
      if (!ALLOWED_GROUP_BY.includes(g)) throw new AnalyticsError(ERROR_CODES.INVALID_GROUP_BY, `invalid group_by: ${g}. allowed: ${ALLOWED_GROUP_BY.join(', ')}`, 400);
    }
    const resolvedCountMode = resolveCountMode(metrics, count_mode);

    const selectParts = group_by.map((column) => `current.${column} as ${column}`);
    for (const m of metrics) {
      if (m === METRICS.EVENT_COUNT) selectParts.push(buildEventCountSelect(resolvedCountMode, group_by));
      if (m === METRICS.UNIQUE_USERS) selectParts.push('COUNT(DISTINCT current.user_id) as unique_users');
      if (m === METRICS.SESSION_COUNT) selectParts.push('COUNT(DISTINCT current.session_id) as session_count');
      if (m === METRICS.BOUNCE_RATE) selectParts.push('COUNT(DISTINCT current.session_id) as _session_count_for_bounce');
      if (m === METRICS.AVG_DURATION) selectParts.push('COUNT(DISTINCT current.session_id) as _session_count_for_duration');
    }
    if (selectParts.length === 0) selectParts.push(buildEventCountSelect(resolvedCountMode, group_by));

    const fromDate = parseSince(date_from);
    const toDate = date_to || today();
    const whereParts = ['project_id = ?', 'date >= ?', 'date <= ?'];
    const params = [project, fromDate, toDate];

    if (filters && Array.isArray(filters)) {
      for (const f of filters) {
        if (!f.field || !f.op || f.value === undefined) continue;
        const sqlOp = FILTER_OPS[f.op];
        if (!sqlOp) throw new AnalyticsError(ERROR_CODES.INVALID_FILTER_OP, `invalid filter op: ${f.op}. allowed: ${Object.keys(FILTER_OPS).join(', ')}`, 400);

        if (FILTERABLE_FIELDS.includes(f.field)) {
          if (f.op === 'contains') {
            whereParts.push(`${f.field} LIKE '%' || ? || '%'`);
          } else {
            whereParts.push(`${f.field} ${sqlOp} ?`);
          }
          params.push(f.value);
        } else if (f.field.startsWith('properties.')) {
          const propKey = f.field.replace('properties.', '');
          validatePropertyKey(propKey);
          if (f.op === 'contains') {
            whereParts.push(`json_extract(properties, '$.${propKey}') LIKE '%' || ? || '%'`);
          } else {
            whereParts.push(`json_extract(properties, '$.${propKey}') ${sqlOp} ?`);
          }
          params.push(f.value);
        }
      }
    }

    let sql = `WITH filtered AS (
      SELECT * FROM events WHERE ${whereParts.join(' AND ')}
    )
    SELECT ${selectParts.join(', ')} FROM filtered current`;
    if (group_by.length > 0) sql += ` GROUP BY ${group_by.map((column) => `current.${column}`).join(', ')}`;

    const defaultOrder = group_by.includes(GROUP_BY_FIELDS.DATE) ? GROUP_BY_FIELDS.DATE : metrics[0];
    const orderField = order_by && ALLOWED_ORDER_BY.includes(order_by) ? order_by : defaultOrder;
    const orderDir = order === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${orderField} ${orderDir}`;

    const maxLimit = Math.min(limit, MAX_LIMIT);
    sql += ` LIMIT ?`;
    params.push(maxLimit);

    const rows = await this._queryAll(sql, params);

    return {
      period: { from: fromDate, to: toDate },
      metrics,
      group_by,
      rows,
      count: rows.length,
    };
  }

  async listProjects() {
    return this._queryAll(
      `SELECT project_id as id, MIN(date) as created, MAX(date) as last_active, COUNT(*) as event_count
       FROM events GROUP BY project_id ORDER BY last_active DESC`,
      [],
    );
  }

  async getProperties({ project, since }) {
    const fromDate = parseSince(since);

    const [events, sample] = await Promise.all([
      this._queryAll(
        `SELECT event, COUNT(*) as count, COUNT(DISTINCT user_id) as unique_users,
                MIN(date) as first_seen, MAX(date) as last_seen
         FROM events WHERE project_id = ? AND date >= ?
         GROUP BY event ORDER BY count DESC`,
        [project, fromDate],
      ),

      this._queryAll(
        `SELECT DISTINCT properties FROM events
         WHERE project_id = ? AND properties IS NOT NULL AND date >= ?
         ORDER BY timestamp DESC LIMIT ${DEFAULT_LIMIT}`,
        [project, fromDate],
      ),
    ]);

    const propKeys = new Set();
    for (const row of sample) {
      try {
        const props = JSON.parse(row.properties);
        Object.keys(props).forEach(k => propKeys.add(k));
      } catch { /* skip malformed JSON */ }
    }

    return {
      events,
      property_keys: [...propKeys].sort(),
    };
  }

  async getPropertiesReceived({ project, since, sample = DEFAULT_SAMPLE_SIZE }) {
    const fromDate = parseSince(since);
    const safeSample = Math.min(Math.max(sample, MIN_SAMPLE_SIZE), MAX_SAMPLE_SIZE);

    const rows = await this._queryAll(
      `SELECT DISTINCT j.key as key, e.event
       FROM (
         SELECT event, properties
         FROM events
         WHERE project_id = ? AND date >= ? AND properties IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?
       ) e, json_each(e.properties) j
       ORDER BY j.key, e.event`,
      [project, fromDate, safeSample],
    );

    return {
      sample_size: safeSample,
      since: fromDate,
      properties: rows,
    };
  }

  // --- Analytics endpoints ---

  async getBreakdown({ project, property, event, since, limit = TOP_EVENTS_LIMIT }) {
    validatePropertyKey(property);
    const fromDate = parseSince(since);
    const safeLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);

    let sql = `SELECT json_extract(properties, '$.${property}') as value,
                      COUNT(*) as count,
                      COUNT(DISTINCT user_id) as unique_users
               FROM events
               WHERE project_id = ? AND date >= ?
                 AND properties IS NOT NULL
                 AND json_extract(properties, '$.${property}') IS NOT NULL`;
    const params = [project, fromDate];

    if (event) {
      sql += ` AND event = ?`;
      params.push(event);
    }

    sql += ` GROUP BY value ORDER BY count DESC LIMIT ?`;
    params.push(safeLimit);

    const values = await this._queryAll(sql, params);

    // Totals
    let totalSql = `SELECT COUNT(*) as total_events,
                           SUM(CASE WHEN json_extract(properties, '$.${property}') IS NOT NULL THEN 1 ELSE 0 END) as total_with_property
                    FROM events WHERE project_id = ? AND date >= ?`;
    const totalParams = [project, fromDate];
    if (event) {
      totalSql += ` AND event = ?`;
      totalParams.push(event);
    }
    const totals = await this._queryOne(totalSql, totalParams);

    return {
      property,
      event: event || null,
      values,
      total_events: totals?.total_events || 0,
      total_with_property: totals?.total_with_property || 0,
    };
  }

  async getInsights({ project, period = '7d' }) {
    if (!VALID_PERIODS.includes(period)) {
      throw new AnalyticsError(ERROR_CODES.MISSING_FIELDS, `invalid period: ${period}. allowed: ${VALID_PERIODS.join(', ')}`, 400);
    }
    const periodDays = parseInt(period, 10);
    const now = Date.now();
    const currentEnd = today();
    const currentStartMs = now - periodDays * MS_PER_DAY;
    const currentStart = formatDate(currentStartMs);
    const previousEndMs = currentStartMs - 1;
    const previousStartMs = previousEndMs - periodDays * MS_PER_DAY;
    const previousStart = formatDate(previousStartMs);
    const previousEnd = formatDate(previousEndMs);

    // Run 4 queries: current events, previous events, current sessions, previous sessions
    const [curEvents, prevEvents, curSessions, prevSessions] = await Promise.all([
      this._queryOne(
        `SELECT COUNT(*) as total_events, COUNT(DISTINCT user_id) as unique_users
         FROM events WHERE project_id = ? AND date >= ? AND date <= ?`,
        [project, currentStart, currentEnd],
      ),
      this._queryOne(
        `SELECT COUNT(*) as total_events, COUNT(DISTINCT user_id) as unique_users
         FROM events WHERE project_id = ? AND date >= ? AND date <= ?`,
        [project, previousStart, previousEnd],
      ),
      this._queryOne(
        `SELECT COUNT(*) as total_sessions,
                SUM(CASE WHEN is_bounce = 1 THEN 1 ELSE 0 END) as bounced,
                AVG(duration) as avg_duration
         FROM sessions WHERE project_id = ? AND date >= ? AND date <= ?`,
        [project, currentStart, currentEnd],
      ),
      this._queryOne(
        `SELECT COUNT(*) as total_sessions,
                SUM(CASE WHEN is_bounce = 1 THEN 1 ELSE 0 END) as bounced,
                AVG(duration) as avg_duration
         FROM sessions WHERE project_id = ? AND date >= ? AND date <= ?`,
        [project, previousStart, previousEnd],
      ),
    ]);

    function delta(current, previous) {
      const change = current - previous;
      const change_pct = previous > 0 ? Math.round((change / previous) * 100) : (current > 0 ? null : 0);
      return { current, previous, change, change_pct };
    }

    const curTotal = curEvents?.total_events || 0;
    const prevTotal = prevEvents?.total_events || 0;
    const curUsers = curEvents?.unique_users || 0;
    const prevUsers = prevEvents?.unique_users || 0;
    const curSessionTotal = curSessions?.total_sessions || 0;
    const prevSessionTotal = prevSessions?.total_sessions || 0;
    const curBounced = curSessions?.bounced || 0;
    const prevBounced = prevSessions?.bounced || 0;
    const curBounceRate = curSessionTotal > 0 ? Math.round((curBounced / curSessionTotal) * 1000) / 1000 : 0;
    const prevBounceRate = prevSessionTotal > 0 ? Math.round((prevBounced / prevSessionTotal) * 1000) / 1000 : 0;
    const curAvgDuration = Math.round(curSessions?.avg_duration || 0);
    const prevAvgDuration = Math.round(prevSessions?.avg_duration || 0);

    const eventsDelta = delta(curTotal, prevTotal);
    const changePct = eventsDelta.change_pct;
    const trend = changePct === null || changePct > 10 ? 'growing'
      : changePct < -10 ? 'declining'
      : 'stable';

    return {
      current_period: { from: currentStart, to: currentEnd },
      previous_period: { from: previousStart, to: previousEnd },
      metrics: {
        total_events: delta(curTotal, prevTotal),
        unique_users: delta(curUsers, prevUsers),
        total_sessions: delta(curSessionTotal, prevSessionTotal),
        bounce_rate: delta(curBounceRate, prevBounceRate),
        avg_duration: delta(curAvgDuration, prevAvgDuration),
      },
      trend,
    };
  }

  async getPages({ project, type = 'entry', since, limit = TOP_EVENTS_LIMIT }) {
    const fromDate = parseSince(since);
    const safeLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);

    const buildQuery = (pageCol) => {
      return {
        sql: `SELECT ${pageCol} as page,
                     COUNT(*) as sessions,
                     SUM(CASE WHEN is_bounce = 1 THEN 1 ELSE 0 END) as bounces,
                     ROUND(CAST(SUM(CASE WHEN is_bounce = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*), 3) as bounce_rate,
                     ROUND(AVG(duration)) as avg_duration,
                     ROUND(AVG(event_count), 1) as avg_events
              FROM sessions
              WHERE project_id = ? AND date >= ? AND ${pageCol} IS NOT NULL
              GROUP BY ${pageCol}
              ORDER BY sessions DESC
              LIMIT ?`,
        params: [project, fromDate, safeLimit],
      };
    };

    if (type === 'both') {
      const [entryRows, exitRows] = await Promise.all([
        this._queryAll(buildQuery('entry_page').sql, buildQuery('entry_page').params),
        this._queryAll(buildQuery('exit_page').sql, buildQuery('exit_page').params),
      ]);
      return { entry_pages: entryRows, exit_pages: exitRows };
    }

    const pageCol = type === 'exit' ? 'exit_page' : 'entry_page';
    const q = buildQuery(pageCol);
    const rows = await this._queryAll(q.sql, q.params);

    return type === 'exit'
      ? { exit_pages: rows }
      : { entry_pages: rows };
  }

  async getSessionDistribution({ project, since }) {
    const fromDate = parseSince(since);

    const rows = await this._queryAll(
      `SELECT
        CASE
          WHEN duration = 0 THEN '0s'
          WHEN duration < 10000 THEN '1-10s'
          WHEN duration < 30000 THEN '10-30s'
          WHEN duration < 60000 THEN '30-60s'
          WHEN duration < 180000 THEN '1-3m'
          WHEN duration < 600000 THEN '3-10m'
          ELSE '10m+'
        END as bucket,
        COUNT(*) as sessions,
        SUM(CASE WHEN is_bounce = 1 THEN 1 ELSE 0 END) as bounces,
        ROUND(AVG(event_count), 1) as avg_events
      FROM sessions
      WHERE project_id = ? AND date >= ?
      GROUP BY bucket
      ORDER BY MIN(duration)`,
      [project, fromDate],
    );

    if (rows.length === 0) {
      return { distribution: [], median_bucket: null, engaged_pct: 0 };
    }

    const totalSessions = rows.reduce((sum, r) => sum + r.sessions, 0);

    // Add pct to each row
    const distribution = rows.map(r => ({
      ...r,
      pct: Math.round((r.sessions / totalSessions) * 1000) / 10,
    }));

    // Compute median bucket (bucket containing the 50th percentile session)
    let cumulative = 0;
    let medianBucket = null;
    for (const r of distribution) {
      cumulative += r.sessions;
      if (cumulative >= totalSessions / 2) {
        medianBucket = r.bucket;
        break;
      }
    }

    // Engaged = sessions with duration >= 30000 (30s)
    const engagedBuckets = ['30-60s', '1-3m', '3-10m', '10m+'];
    const engaged = distribution
      .filter(r => engagedBuckets.includes(r.bucket))
      .reduce((sum, r) => sum + r.sessions, 0);
    const engagedPct = Math.round((engaged / totalSessions) * 1000) / 10;

    return { distribution, median_bucket: medianBucket, engaged_pct: engagedPct };
  }

  async identifyUser({ project, previous_id, canonical_id }) {
    await this._batch(buildIdentifyStatements({ project, previous_id, canonical_id }));
  }

  async getHeatmap({ project, since }) {
    const fromDate = parseSince(since);

    const rows = await this._queryAll(
      `SELECT CAST(strftime('%w', date) AS INTEGER) as day,
              CAST(strftime('%H', timestamp / 1000, 'unixepoch') AS INTEGER) as hour,
              COUNT(*) as events,
              COUNT(DISTINCT user_id) as users
       FROM events
       WHERE project_id = ? AND date >= ?
       GROUP BY day, hour
       ORDER BY day, hour`,
      [project, fromDate],
    );

    if (rows.length === 0) {
      return { heatmap: [], peak: null, busiest_day: null, busiest_hour: null };
    }

    // Add day_name
    const heatmap = rows.map(r => ({
      ...r,
      day_name: DAY_NAMES[r.day],
    }));

    // Find peak (highest events)
    const peakEntry = heatmap.reduce((best, r) => r.events > best.events ? r : best, heatmap[0]);
    const peak = { day: peakEntry.day, day_name: peakEntry.day_name, hour: peakEntry.hour, events: peakEntry.events, users: peakEntry.users };

    // Busiest day (sum events per day)
    const dayTotals = {};
    for (const r of heatmap) {
      dayTotals[r.day] = (dayTotals[r.day] || 0) + r.events;
    }
    const busiestDayNum = Object.entries(dayTotals).sort((a, b) => b[1] - a[1])[0][0];
    const busiest_day = DAY_NAMES[Number(busiestDayNum)];

    // Busiest hour (sum events per hour)
    const hourTotals = {};
    for (const r of heatmap) {
      hourTotals[r.hour] = (hourTotals[r.hour] || 0) + r.events;
    }
    const busiest_hour = Number(Object.entries(hourTotals).sort((a, b) => b[1] - a[1])[0][0]);

    return { heatmap, peak, busiest_day, busiest_hour };
  }
}
