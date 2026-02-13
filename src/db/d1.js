/**
 * Cloudflare D1 database adapter
 * 
 * Wraps D1 bindings with the standard adapter interface.
 * All SQL queries live here — handlers never touch SQL directly.
 */

import { today, parseSince, parseSinceMs } from './adapter.js';
import { ulid } from '../ulid.js';

export function validatePropertyKey(key) {
  if (!key || key.length > 128 || !/^[a-zA-Z0-9_]+$/.test(key)) {
    throw new Error('Invalid property filter key');
  }
}

export class D1Adapter {
  constructor(db) {
    /** @type {import('@cloudflare/workers-types').D1Database} */
    this.db = db;
  }

  /**
   * Build a session upsert statement for a given event.
   * @private
   */
  _sessionUpsertStmt(project, event_data) {
    const ts = event_data.timestamp || Date.now();
    const date = new Date(ts).toISOString().split('T')[0];
    const page = (event_data.properties && typeof event_data.properties === 'object')
      ? (event_data.properties.path || event_data.properties.url || null)
      : null;
    const count = event_data._count || 1;
    return this.db.prepare(
      `INSERT INTO sessions (session_id, user_id, project_id, start_time, end_time, duration, entry_page, exit_page, event_count, is_bounce, date)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         start_time = MIN(sessions.start_time, excluded.start_time),
         end_time = MAX(sessions.end_time, excluded.end_time),
         duration = MAX(sessions.end_time, excluded.end_time) - MIN(sessions.start_time, excluded.start_time),
         entry_page = CASE WHEN excluded.start_time < sessions.start_time THEN excluded.entry_page ELSE sessions.entry_page END,
         exit_page = CASE WHEN excluded.end_time >= sessions.end_time THEN excluded.exit_page ELSE sessions.exit_page END,
         event_count = sessions.event_count + excluded.event_count,
         is_bounce = CASE WHEN sessions.event_count + excluded.event_count > 1 THEN 0 ELSE 1 END`
    ).bind(
      event_data.session_id,
      event_data.user_id || null,
      project,
      ts, ts,
      page, page,
      count,
      date
    );
  }

  /**
   * Insert a single event + upsert session atomically.
   */
  trackEvent({ project, event, properties, user_id, session_id, timestamp }) {
    const ts = timestamp || Date.now();
    const date = new Date(ts).toISOString().split('T')[0];
    const eventStmt = this.db.prepare(
      `INSERT INTO events (id, project_id, event, properties, user_id, session_id, timestamp, date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      ulid(),
      project,
      event,
      properties ? JSON.stringify(properties) : null,
      user_id || null,
      session_id || null,
      ts,
      date
    );

    if (!session_id) {
      return eventStmt.run();
    }

    const sessionStmt = this._sessionUpsertStmt(project, { session_id, user_id, timestamp: ts, properties });
    return this.db.batch([eventStmt, sessionStmt]);
  }

  /**
   * Batch insert events + upsert sessions atomically.
   */
  trackBatch(events) {
    const stmts = [];
    const eventInsert = this.db.prepare(
      `INSERT INTO events (id, project_id, event, properties, user_id, session_id, timestamp, date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    // Insert all events
    for (const e of events) {
      const ts = e.timestamp || Date.now();
      const date = new Date(ts).toISOString().split('T')[0];
      stmts.push(eventInsert.bind(
        ulid(),
        e.project,
        e.event,
        e.properties ? JSON.stringify(e.properties) : null,
        e.user_id || null,
        e.session_id || null,
        ts,
        date
      ));
    }

    // Upsert sessions for each event that has session_id
    for (const e of events) {
      if (!e.session_id) continue;
      const ts = e.timestamp || Date.now();
      stmts.push(this._sessionUpsertStmt(e.project, {
        session_id: e.session_id,
        user_id: e.user_id,
        timestamp: ts,
        properties: e.properties,
      }));
    }

    return this.db.batch(stmts);
  }

  /**
   * Upsert a session row directly.
   */
  upsertSession(sessionData) {
    return this._sessionUpsertStmt(sessionData.project_id || sessionData.project, sessionData).run();
  }

  /**
   * List sessions with optional filters.
   */
  async getSessions({ project, since, user_id, is_bounce, limit = 100 }) {
    const fromDate = parseSince(since);
    const safeLimit = Math.min(limit, 1000);

    let query = `SELECT * FROM sessions WHERE project_id = ? AND date >= ?`;
    const params = [project, fromDate];

    if (user_id) {
      query += ` AND user_id = ?`;
      params.push(user_id);
    }
    if (is_bounce !== undefined && is_bounce !== null) {
      query += ` AND is_bounce = ?`;
      params.push(Number(is_bounce));
    }

    query += ` ORDER BY start_time DESC LIMIT ?`;
    params.push(safeLimit);

    const result = await this.db.prepare(query).bind(...params).all();
    return result.results;
  }

  /**
   * Aggregate session metrics for stats endpoint.
   */
  async getSessionStats({ project, since }) {
    const fromDate = parseSince(since);
    const row = await this.db.prepare(
      `SELECT COUNT(*) as total_sessions,
              SUM(CASE WHEN is_bounce = 1 THEN 1 ELSE 0 END) as bounced_sessions,
              SUM(duration) as total_duration,
              SUM(event_count) as total_events,
              COUNT(DISTINCT user_id) as unique_users
       FROM sessions WHERE project_id = ? AND date >= ?`
    ).bind(project, fromDate).first();

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

  /**
   * Delete sessions older than a given date.
   */
  cleanupSessions({ project, before_date }) {
    return this.db.prepare(
      `DELETE FROM sessions WHERE project_id = ? AND date < ?`
    ).bind(project, before_date).run();
  }

  /**
   * Aggregated stats with configurable time granularity.
   * @param {Object} opts
   * @param {string} opts.project
   * @param {string} [opts.since] - ISO timestamp (default: 7 days ago)
   * @param {string} [opts.groupBy] - hour | day | week | month (default: day)
   */
  async getStats({ project, since, groupBy = 'day' }) {
    const fromDate = parseSince(since);
    const fromMs = parseSinceMs(since);
    const VALID_GROUP = ['hour', 'day', 'week', 'month'];
    if (!VALID_GROUP.includes(groupBy)) groupBy = 'day';

    // Build the time bucket expression
    let bucketExpr;
    if (groupBy === 'hour') {
      // Use timestamp (epoch ms) for hourly — gives YYYY-MM-DDTHH:00
      bucketExpr = `strftime('%Y-%m-%dT%H:00', timestamp / 1000, 'unixepoch')`;
    } else if (groupBy === 'week') {
      // ISO week start (Monday)
      bucketExpr = `date(date, 'weekday 0', '-6 days')`;
    } else if (groupBy === 'month') {
      bucketExpr = `strftime('%Y-%m', date)`;
    } else {
      bucketExpr = `date`;
    }

    const timeSeriesQuery = groupBy === 'hour'
      ? `SELECT ${bucketExpr} as bucket, COUNT(DISTINCT user_id) as unique_users, COUNT(*) as total_events
         FROM events WHERE project_id = ? AND timestamp >= ?
         GROUP BY bucket ORDER BY bucket`
      : `SELECT ${bucketExpr} as bucket, COUNT(DISTINCT user_id) as unique_users, COUNT(*) as total_events
         FROM events WHERE project_id = ? AND date >= ?
         GROUP BY bucket ORDER BY bucket`;

    const bindVal = groupBy === 'hour' ? fromMs : fromDate;

    const [timeSeries, eventCounts, totals, sessions] = await Promise.all([
      this.db.prepare(timeSeriesQuery).bind(project, bindVal).all(),

      this.db.prepare(
        `SELECT event, COUNT(*) as count, COUNT(DISTINCT user_id) as unique_users
         FROM events WHERE project_id = ? AND date >= ?
         GROUP BY event ORDER BY count DESC LIMIT 20`
      ).bind(project, fromDate).all(),

      this.db.prepare(
        `SELECT COUNT(DISTINCT user_id) as unique_users, COUNT(*) as total_events
         FROM events WHERE project_id = ? AND date >= ?`
      ).bind(project, fromDate).first(),

      this.getSessionStats({ project, since }),
    ]);

    return {
      period: { from: fromDate, to: today(), groupBy },
      totals,
      timeSeries: timeSeries.results,
      events: eventCounts.results,
      sessions,
    };
  }

  /**
   * Raw events query with optional event filter.
   */
  async getEvents({ project, event, session_id, since, limit = 100 }) {
    const fromDate = parseSince(since);
    const safeLimit = Math.min(limit, 1000);

    let query = `SELECT * FROM events WHERE project_id = ? AND date >= ?`;
    const params = [project, fromDate];

    if (event) {
      query += ` AND event = ?`;
      params.push(event);
    }

    if (session_id) {
      query += ` AND session_id = ?`;
      params.push(session_id);
    }

    query += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(safeLimit);

    const result = await this.db.prepare(query).bind(...params).all();

    return result.results.map(e => ({
      ...e,
      properties: e.properties ? JSON.parse(e.properties) : null,
    }));
  }

  /**
   * Flexible analytics query with metrics, filters, grouping.
   */
  async query({ project, metrics = ['event_count'], filters, date_from, date_to, group_by = [], order_by, order, limit = 100 }) {
    const ALLOWED_METRICS = ['event_count', 'unique_users', 'session_count', 'bounce_rate', 'avg_duration'];
    const ALLOWED_GROUP_BY = ['event', 'date', 'user_id', 'session_id'];

    for (const m of metrics) {
      if (!ALLOWED_METRICS.includes(m)) throw new Error(`invalid metric: ${m}. allowed: ${ALLOWED_METRICS.join(', ')}`);
    }
    for (const g of group_by) {
      if (!ALLOWED_GROUP_BY.includes(g)) throw new Error(`invalid group_by: ${g}. allowed: ${ALLOWED_GROUP_BY.join(', ')}`);
    }

    // SELECT
    const selectParts = [...group_by];
    for (const m of metrics) {
      if (m === 'event_count') selectParts.push('COUNT(*) as event_count');
      if (m === 'unique_users') selectParts.push('COUNT(DISTINCT user_id) as unique_users');
      if (m === 'session_count') selectParts.push('COUNT(DISTINCT session_id) as session_count');
      if (m === 'bounce_rate') selectParts.push('COUNT(DISTINCT session_id) as _session_count_for_bounce');
      if (m === 'avg_duration') selectParts.push('COUNT(DISTINCT session_id) as _session_count_for_duration');
    }
    if (selectParts.length === 0) selectParts.push('COUNT(*) as event_count');

    // WHERE
    const fromDate = date_from || parseSince(null);
    const toDate = date_to || today();
    const whereParts = ['project_id = ?', 'date >= ?', 'date <= ?'];
    const params = [project, fromDate, toDate];

    // Filters
    if (filters && Array.isArray(filters)) {
      const FILTER_OPS = { eq: '=', neq: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=' };
      const FILTERABLE_FIELDS = ['event', 'user_id', 'date'];

      for (const f of filters) {
        if (!f.field || !f.op || f.value === undefined) continue;
        const sqlOp = FILTER_OPS[f.op];
        if (!sqlOp) throw new Error(`invalid filter op: ${f.op}. allowed: ${Object.keys(FILTER_OPS).join(', ')}`);

        if (FILTERABLE_FIELDS.includes(f.field)) {
          whereParts.push(`${f.field} ${sqlOp} ?`);
          params.push(f.value);
        } else if (f.field.startsWith('properties.')) {
          const propKey = f.field.replace('properties.', '');
          validatePropertyKey(propKey);
          whereParts.push(`json_extract(properties, '$.${propKey}') ${sqlOp} ?`);
          params.push(f.value);
        }
      }
    }

    let sql = `SELECT ${selectParts.join(', ')} FROM events WHERE ${whereParts.join(' AND ')}`;

    if (group_by.length > 0) sql += ` GROUP BY ${group_by.join(', ')}`;

    // ORDER
    const ALLOWED_ORDER = ['event_count', 'unique_users', 'date', 'event'];
    const orderField = order_by && ALLOWED_ORDER.includes(order_by) ? order_by : (group_by.includes('date') ? 'date' : 'event_count');
    const orderDir = order === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${orderField} ${orderDir}`;

    const maxLimit = Math.min(limit, 1000);
    sql += ` LIMIT ?`;
    params.push(maxLimit);

    const result = await this.db.prepare(sql).bind(...params).all();

    return {
      period: { from: fromDate, to: toDate },
      metrics,
      group_by,
      rows: result.results,
      count: result.results.length,
    };
  }

  /**
   * Discover event names and property keys for a project.
   */
  /**
   * List all projects (distinct project_ids from events table).
   */
  async listProjects() {
    const result = await this.db.prepare(
      `SELECT project_id as id, MIN(date) as created, MAX(date) as last_active, COUNT(*) as event_count
       FROM events GROUP BY project_id ORDER BY last_active DESC`
    ).all();
    return result.results;
  }

  async getProperties({ project, since }) {
    const fromDate = parseSince(since);

    const [events, sample] = await Promise.all([
      this.db.prepare(
        `SELECT event, COUNT(*) as count, COUNT(DISTINCT user_id) as unique_users,
                MIN(date) as first_seen, MAX(date) as last_seen
         FROM events WHERE project_id = ? AND date >= ?
         GROUP BY event ORDER BY count DESC`
      ).bind(project, fromDate).all(),

      this.db.prepare(
        `SELECT DISTINCT properties FROM events 
         WHERE project_id = ? AND properties IS NOT NULL AND date >= ?
         ORDER BY timestamp DESC LIMIT 100`
      ).bind(project, fromDate).all(),
    ]);

    const propKeys = new Set();
    for (const row of sample.results) {
      try {
        const props = JSON.parse(row.properties);
        Object.keys(props).forEach(k => propKeys.add(k));
      } catch { /* skip malformed JSON */ }
    }

    return {
      events: events.results,
      property_keys: [...propKeys].sort(),
    };
  }

  /**
   * Discover property keys mapped to their event types.
   * Uses json_each on a bounded sample for predictable performance.
   */
  async getPropertiesReceived({ project, since, sample = 5000 }) {
    const fromDate = parseSince(since);
    const safeSample = Math.min(Math.max(sample, 100), 10000);

    const result = await this.db.prepare(
      `SELECT DISTINCT j.key as key, e.event
       FROM (
         SELECT event, properties
         FROM events
         WHERE project_id = ? AND date >= ? AND properties IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?
       ) e, json_each(e.properties) j
       ORDER BY j.key, e.event`
    ).bind(project, fromDate, safeSample).all();

    return {
      sample_size: safeSample,
      since: fromDate,
      properties: result.results,
    };
  }
}
