import { parseSince, today } from './db/adapter.js';
import { AnalyticsError, ERROR_CODES } from './errors.js';

export const VALID_PATHS_SINCE = Object.freeze(['1d', '7d', '14d', '30d', '90d']);
export const PATHS_DEFAULTS = Object.freeze({
  since: '30d',
  max_steps: 5,
  entry_limit: 10,
  path_limit: 5,
  candidate_session_cap: 5000,
});
export const PATHS_LIMITS = Object.freeze({
  max_steps: { min: 1, max: 5 },
  entry_limit: { min: 1, max: 20 },
  path_limit: { min: 1, max: 10 },
  candidate_session_cap: { min: 100, max: 10000 },
});

export const PASSIVE_PATH_EVENTS = Object.freeze(new Set([
  'page_view',
  '$impression',
  '$scroll_depth',
  '$error',
  '$time_on_page',
  '$performance',
  '$web_vitals',
]));

function roundRate(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function sortNodes(nodes) {
  return [...nodes].sort((a, b) => {
    if (b.sessions !== a.sessions) return b.sessions - a.sessions;
    if (b.conversions !== a.conversions) return b.conversions - a.conversions;
    return `${a.type}:${a.value}`.localeCompare(`${b.type}:${b.value}`);
  });
}

function finalizeChildren(nodeMap, pathLimit) {
  const nodes = sortNodes([...nodeMap.values()])
    .slice(0, pathLimit)
    .map((node) => {
      const finalized = {
        type: node.type,
        value: node.value,
        sessions: node.sessions,
        conversions: node.conversions,
        conversion_rate: roundRate(node.conversions, node.sessions),
        children: finalizeChildren(node.children, pathLimit),
      };
      if (node.exit_page !== undefined) finalized.exit_page = node.exit_page;
      return finalized;
    });

  return nodes;
}

function finalizeExitPages(exitMap) {
  return [...exitMap.values()]
    .sort((a, b) => {
      if (b.sessions !== a.sessions) return b.sessions - a.sessions;
      const aDropOffs = a.sessions - a.conversions;
      const bDropOffs = b.sessions - b.conversions;
      if (bDropOffs !== aDropOffs) return bDropOffs - aDropOffs;
      if (b.conversions !== a.conversions) return b.conversions - a.conversions;
      return a.exit_page.localeCompare(b.exit_page);
    })
    .map((exit) => ({
      exit_page: exit.exit_page,
      sessions: exit.sessions,
      conversions: exit.conversions,
      conversion_rate: roundRate(exit.conversions, exit.sessions),
      drop_offs: exit.sessions - exit.conversions,
      drop_off_rate: roundRate(exit.sessions - exit.conversions, exit.sessions),
    }));
}

function normalizeNode(row, entryPage, goalEvent) {
  if (row.event === goalEvent) {
    return { type: 'goal', value: goalEvent };
  }

  if (row.event === 'page_view') {
    if (!row.path || row.path === entryPage) return null;
    return { type: 'page', value: row.path };
  }

  if (PASSIVE_PATH_EVENTS.has(row.event)) return null;
  return { type: 'event', value: row.event };
}

function buildSessionPath(rows, { goalEvent, maxSteps }) {
  const entryPage = rows[0]?.entry_page || null;
  if (!entryPage) return null;
  const exitPage = rows[0]?.exit_page || null;

  const nodes = [];
  let seenGoal = false;
  let truncated = false;

  for (const row of rows) {
    const node = normalizeNode(row, entryPage, goalEvent);
    if (!node) continue;

    const previous = nodes[nodes.length - 1];
    if (previous && previous.type === node.type && previous.value === node.value) {
      continue;
    }

    if (nodes.length >= maxSteps) {
      truncated = true;
      break;
    }

    nodes.push(node);
    if (node.type === 'goal') {
      seenGoal = true;
      break;
    }
  }

  if (!seenGoal) {
    nodes.push({
      type: truncated ? 'truncated' : 'drop_off',
      value: exitPage || 'unknown',
      exit_page: exitPage,
    });
  }

  return {
    entry_page: entryPage,
    exit_page: exitPage,
    nodes,
    converted: seenGoal,
  };
}

export function validatePathsOptions(options = {}) {
  const since = options.since ?? PATHS_DEFAULTS.since;
  if (!VALID_PATHS_SINCE.includes(since)) {
    throw new AnalyticsError(
      ERROR_CODES.MISSING_FIELDS,
      `since must be one of: ${VALID_PATHS_SINCE.join(', ')}`,
      400,
    );
  }

  const maxSteps = options.max_steps ?? options.maxSteps ?? PATHS_DEFAULTS.max_steps;
  const entryLimit = options.entry_limit ?? options.entryLimit ?? PATHS_DEFAULTS.entry_limit;
  const pathLimit = options.path_limit ?? options.pathLimit ?? PATHS_DEFAULTS.path_limit;
  const candidateSessionCap = options.candidate_session_cap ?? options.candidateSessionCap ?? PATHS_DEFAULTS.candidate_session_cap;

  if (!Number.isInteger(maxSteps) || maxSteps < PATHS_LIMITS.max_steps.min || maxSteps > PATHS_LIMITS.max_steps.max) {
    throw new AnalyticsError(ERROR_CODES.MISSING_FIELDS, `max_steps must be ${PATHS_LIMITS.max_steps.min}-${PATHS_LIMITS.max_steps.max}`, 400);
  }
  if (!Number.isInteger(entryLimit) || entryLimit < PATHS_LIMITS.entry_limit.min || entryLimit > PATHS_LIMITS.entry_limit.max) {
    throw new AnalyticsError(ERROR_CODES.MISSING_FIELDS, `entry_limit must be ${PATHS_LIMITS.entry_limit.min}-${PATHS_LIMITS.entry_limit.max}`, 400);
  }
  if (!Number.isInteger(pathLimit) || pathLimit < PATHS_LIMITS.path_limit.min || pathLimit > PATHS_LIMITS.path_limit.max) {
    throw new AnalyticsError(ERROR_CODES.MISSING_FIELDS, `path_limit must be ${PATHS_LIMITS.path_limit.min}-${PATHS_LIMITS.path_limit.max}`, 400);
  }
  if (!Number.isInteger(candidateSessionCap) || candidateSessionCap < PATHS_LIMITS.candidate_session_cap.min || candidateSessionCap > PATHS_LIMITS.candidate_session_cap.max) {
    throw new AnalyticsError(
      ERROR_CODES.MISSING_FIELDS,
      `candidate_session_cap must be ${PATHS_LIMITS.candidate_session_cap.min}-${PATHS_LIMITS.candidate_session_cap.max}`,
      400,
    );
  }

  const goalEvent = options.goal_event ?? options.goalEvent;
  if (typeof goalEvent !== 'string' || !goalEvent.trim() || goalEvent.length > 256) {
    throw new AnalyticsError(ERROR_CODES.MISSING_FIELDS, 'goal_event must be a non-empty string (max 256 chars)', 400);
  }

  return {
    since,
    fromDate: parseSince(since),
    goalEvent: goalEvent.trim(),
    maxSteps,
    entryLimit,
    pathLimit,
    candidateSessionCap,
  };
}

export function buildPathsQueries({ project, fromDate, entryLimit, candidateSessionCap }) {
  return [
    {
      sql: `SELECT entry_page,
                   COUNT(*) as sessions
            FROM sessions
            WHERE project_id = ?
              AND date >= ?
              AND entry_page IS NOT NULL
            GROUP BY entry_page
            ORDER BY sessions DESC, entry_page ASC
            LIMIT ?`,
      params: [project, fromDate, entryLimit],
    },
    {
      sql: `WITH top_entry_pages AS (
              SELECT entry_page
              FROM sessions
              WHERE project_id = ?
                AND date >= ?
                AND entry_page IS NOT NULL
              GROUP BY entry_page
              ORDER BY COUNT(*) DESC, entry_page ASC
              LIMIT ?
            ),
            candidate_sessions AS (
              SELECT session_id, entry_page, exit_page, start_time
              FROM sessions
              WHERE project_id = ?
                AND date >= ?
                AND entry_page IN (SELECT entry_page FROM top_entry_pages)
                AND session_id IS NOT NULL
              ORDER BY start_time DESC, session_id DESC
              LIMIT ?
            )
            SELECT cs.session_id,
                   cs.entry_page,
                   cs.exit_page,
                   e.event,
                   json_extract(e.properties, '$.path') as path,
                   e.timestamp
            FROM candidate_sessions cs
            JOIN events e
              ON e.project_id = ?
             AND e.session_id = cs.session_id
            ORDER BY cs.entry_page, e.session_id, e.timestamp`,
      params: [project, fromDate, entryLimit, project, fromDate, candidateSessionCap, project],
    },
  ];
}

export function buildPathsReport(rows, { goalEvent, maxSteps, pathLimit }) {
  const grouped = new Map();
  for (const row of rows || []) {
    if (!row?.session_id || !row?.entry_page) continue;
    if (!grouped.has(row.session_id)) grouped.set(row.session_id, []);
    grouped.get(row.session_id).push(row);
  }

  const entryMap = new Map();

  for (const sessionRows of grouped.values()) {
    sessionRows.sort((a, b) => a.timestamp - b.timestamp);
    const path = buildSessionPath(sessionRows, { goalEvent, maxSteps });
    if (!path) continue;

    if (!entryMap.has(path.entry_page)) {
      entryMap.set(path.entry_page, {
        entry_page: path.entry_page,
        sessions: 0,
        conversions: 0,
        exits: new Map(),
        children: new Map(),
      });
    }

    const entry = entryMap.get(path.entry_page);
    entry.sessions += 1;
    if (path.converted) entry.conversions += 1;
    const exitPage = path.exit_page || 'unknown';
    if (!entry.exits.has(exitPage)) {
      entry.exits.set(exitPage, {
        exit_page: exitPage,
        sessions: 0,
        conversions: 0,
      });
    }
    const exit = entry.exits.get(exitPage);
    exit.sessions += 1;
    if (path.converted) exit.conversions += 1;

    let cursor = entry.children;
    for (const node of path.nodes) {
      const key = `${node.type}:${node.value}:${node.exit_page || ''}`;
      if (!cursor.has(key)) {
        const newNode = {
          type: node.type,
          value: node.value,
          sessions: 0,
          conversions: 0,
          children: new Map(),
        };
        if (node.exit_page !== undefined) newNode.exit_page = node.exit_page;
        cursor.set(key, newNode);
      }
      const current = cursor.get(key);
      current.sessions += 1;
      if (path.converted) current.conversions += 1;
      cursor = current.children;
    }
  }

  const entry_paths = sortNodes([...entryMap.values()])
    .map((entry) => ({
      entry_page: entry.entry_page,
      sessions: entry.sessions,
      conversions: entry.conversions,
      conversion_rate: roundRate(entry.conversions, entry.sessions),
      exit_pages: finalizeExitPages(entry.exits),
      tree: finalizeChildren(entry.children, pathLimit),
    }));

  return { entry_paths };
}

export function buildPathsResponse(project, options, rows) {
  const period = { from: options.fromDate, to: today() };
  return {
    project,
    goal_event: options.goalEvent,
    period,
    bounds: {
      max_steps: options.maxSteps,
      entry_limit: options.entryLimit,
      path_limit: options.pathLimit,
      candidate_session_cap: options.candidateSessionCap,
    },
    ...buildPathsReport(rows, options),
  };
}
