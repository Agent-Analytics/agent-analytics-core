/**
 * Database adapter interface
 * 
 * All adapters must implement these methods. SQL lives here,
 * not in the handlers. Handlers call semantic methods like
 * db.trackEvent(), db.getStats(), etc.
 */

// Shared date helpers

/** Convert a Date, epoch-ms number, or ISO string to YYYY-MM-DD. */
export function formatDate(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString().split('T')[0];
}

export function today() {
  return formatDate(new Date());
}

export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDate(d);
}

/**
 * Parse `since` ISO timestamp into a date string (YYYY-MM-DD).
 * Falls back to 7 days ago if missing/invalid.
 */
export function parseSince(since) {
  if (!since) return daysAgo(7);
  const d = new Date(since);
  if (isNaN(d.getTime())) return daysAgo(7);
  return formatDate(d);
}

/**
 * Parse `since` into epoch ms (for timestamp-based queries like hourly).
 */
export function parseSinceMs(since) {
  if (!since) return Date.now() - 7 * 86400000;
  const d = new Date(since);
  if (isNaN(d.getTime())) return Date.now() - 7 * 86400000;
  return d.getTime();
}

/**
 * @typedef {Object} DbAdapter
 * @property {function} trackEvent - Insert a single event
 * @property {function} trackBatch - Insert multiple events
 * @property {function} getStats - Aggregated stats for a project
 * @property {function} getEvents - Raw event query
 * @property {function} query - Flexible analytics query
 * @property {function} getProperties - Discover event names and property keys
 * @property {function} upsertSession - Upsert a session row
 * @property {function} getSessions - List sessions with filters
 * @property {function} getSessionStats - Aggregate session metrics
 * @property {function} cleanupSessions - Delete sessions older than date
 * @property {function} listProjects - List all projects (returns array of {id, name, token, created})
 */
