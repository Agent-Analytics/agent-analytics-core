/**
 * Delete analytics rows for one subject, by primary key, inside one project.
 *
 * OSS databases have events, sessions, and identity_map. Hosted databases also
 * have resolved_user_id, identity_aliases, user_profiles, email_lookup_index,
 * and project_identity_scopes. Pass includeHostedIdentity for that schema.
 * Every statement binds the project name. The identity graph is walked once
 * from the seed ids, not followed into a second hop.
 * User mode deletes events by that id set. A session row is deleted only when
 * every event in it belongs to the set. A shared session stays.
 * Deletes are set based (user_id IN / session_id IN), not one call per event.
 *
 * Stable exports (also re-exported from the package root and ./erasure):
 *   ERASURE_BATCH_SIZE
 *   ERASURE_LARGE_EVENT_THRESHOLD
 *   emptyErasureCounts
 *   hashErasureSubject
 *   collectIdentityGraph
 *   countSubjectEvents
 *   userIdsForEmailLookup
 *   eraseSubjectRows
 *   reapplyErasureReceipt
 */

export const ERASURE_BATCH_SIZE = 80;
export const ERASURE_LARGE_EVENT_THRESHOLD = 100_000;

const PREDICATE_BATCH = 40;
const PAGE_SIZE = 500;

function placeholders(count) {
  return new Array(count).fill('?').join(', ');
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function batches(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

function changeCount(result, fallback) {
  const changes = Number(result?.changes);
  return Number.isFinite(changes) ? changes : fallback;
}

export function emptyErasureCounts() {
  return {
    events: 0,
    sessions: 0,
    identity_rows: 0,
    profiles: 0,
    email_lookups: 0,
  };
}

export async function hashErasureSubject(value) {
  const encoded = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requireProject(project) {
  if (typeof project !== 'string' || project.length === 0) {
    throw new Error('project name is required');
  }
}

async function expandIdentityMap(db, project, seedIds) {
  const found = new Set();
  for (const batch of batches(seedIds, PREDICATE_BATCH)) {
    const marks = placeholders(batch.length);
    const rows = await db.queryAll(
      `SELECT previous_id, canonical_id
         FROM identity_map
        WHERE project_id = ?
          AND (previous_id IN (${marks}) OR canonical_id IN (${marks}))`,
      [project, ...batch, ...batch],
    );
    for (const row of rows) {
      if (row.previous_id) found.add(row.previous_id);
      if (row.canonical_id) found.add(row.canonical_id);
    }
  }
  return found;
}

async function expandAliases(db, project, scopeId, seedIds) {
  const found = new Set();
  const projectScope = `project:${project}`;
  for (const batch of batches(seedIds, PREDICATE_BATCH)) {
    const marks = placeholders(batch.length);
    const rows = await db.queryAll(
      `SELECT alias_id, canonical_id
         FROM identity_aliases
        WHERE scope_id = ?
          AND (alias_id IN (${marks}) OR canonical_id IN (${marks}))
          AND (
            scope_id = ?
            OR EXISTS (
              SELECT 1 FROM project_identity_scopes
               WHERE project_id = ?
                 AND scope_id = identity_aliases.scope_id
            )
          )`,
      [scopeId, ...batch, ...batch, projectScope, project],
    );
    for (const row of rows) {
      if (row.alias_id) found.add(row.alias_id);
      if (row.canonical_id) found.add(row.canonical_id);
    }
  }
  return found;
}

async function scopesForProject(db, project, explicit) {
  const scopes = new Set(uniqueStrings(explicit));
  scopes.add(`project:${project}`);
  const rows = await db.queryAll(
    'SELECT scope_id FROM project_identity_scopes WHERE project_id = ?',
    [project],
  );
  for (const row of rows) {
    if (row.scope_id) scopes.add(row.scope_id);
  }
  return [...scopes];
}

/**
 * One hop from seedIds through identity_map and, when includeHostedIdentity
 * is set, identity_aliases. Newly discovered ids are not used as further seeds.
 */
export async function collectIdentityGraph(db, {
  project,
  seedIds,
  includeHostedIdentity = false,
  aliasScopeIds = [],
} = {}) {
  requireProject(project);
  const seeds = uniqueStrings(seedIds);
  const expanded = new Set(seeds);
  if (seeds.length === 0) return [];

  for (const id of await expandIdentityMap(db, project, seeds)) expanded.add(id);
  if (includeHostedIdentity) {
    const scopes = await scopesForProject(db, project, aliasScopeIds);
    for (const scopeId of scopes) {
      for (const id of await expandAliases(db, project, scopeId, seeds)) expanded.add(id);
    }
  }
  return [...expanded];
}

function insideSql(includeHostedIdentity, marks) {
  const resolved = includeHostedIdentity ? ` OR resolved_user_id IN (${marks})` : '';
  return `(user_id IN (${marks})${resolved})`;
}

function outsideSql(includeHostedIdentity, marks) {
  const resolved = includeHostedIdentity
    ? ` OR (resolved_user_id IS NOT NULL AND resolved_user_id NOT IN (${marks}))`
    : '';
  return `(user_id IS NULL OR user_id NOT IN (${marks})${resolved})`;
}

function idListParams(batch, includeHostedIdentity) {
  return includeHostedIdentity ? [...batch, ...batch] : [...batch];
}

async function countUserEvents(db, project, userIds, includeHostedIdentity) {
  const ids = uniqueStrings(userIds);
  if (ids.length === 0) return 0;
  let total = 0;
  const size = includeHostedIdentity ? PREDICATE_BATCH : ERASURE_BATCH_SIZE;
  for (const batch of batches(ids, size)) {
    const marks = placeholders(batch.length);
    const row = await db.queryOne(
      `SELECT COUNT(*) AS n FROM events
        WHERE project_id = ? AND ${insideSql(includeHostedIdentity, marks)}`,
      [project, ...idListParams(batch, includeHostedIdentity)],
    );
    total += Number(row?.n) || 0;
  }
  return total;
}

export async function countSubjectEvents(db, {
  project,
  userIds = [],
  sessionId = null,
  includeHostedIdentity = false,
} = {}) {
  requireProject(project);
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const row = await db.queryOne(
      'SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND session_id = ?',
      [project, sessionId],
    );
    return Number(row?.n) || 0;
  }
  return countUserEvents(db, project, userIds, includeHostedIdentity);
}

export async function userIdsForEmailLookup(db, { project, scopeId, lookupIndex } = {}) {
  requireProject(project);
  if (!scopeId || !lookupIndex) return [];
  const rows = await db.queryAll(
    `SELECT user_id FROM email_lookup_index
      WHERE project_id = ? AND scope_id = ? AND lookup_index = ?`,
    [project, scopeId, lookupIndex],
  );
  return uniqueStrings(rows.map((row) => row.user_id));
}

async function classifyTouchedSessions(db, project, userIds, includeHostedIdentity) {
  const exclusive = new Set();
  const shared = new Set();
  const repeats = includeHostedIdentity ? 4 : 2;
  const size = Math.max(1, Math.min(PREDICATE_BATCH, Math.floor(90 / repeats)));
  for (const batch of batches(userIds, size)) {
    const marks = placeholders(batch.length);
    const rows = await db.queryAll(
      `SELECT session_id,
              SUM(CASE WHEN ${outsideSql(includeHostedIdentity, marks)} THEN 1 ELSE 0 END) AS outside_events
         FROM events
        WHERE project_id = ? AND session_id IS NOT NULL
        GROUP BY session_id
       HAVING SUM(CASE WHEN ${insideSql(includeHostedIdentity, marks)} THEN 1 ELSE 0 END) > 0`,
      [
        ...idListParams(batch, includeHostedIdentity),
        project,
        ...idListParams(batch, includeHostedIdentity),
      ],
    );
    for (const row of rows) {
      if (Number(row.outside_events) > 0) shared.add(row.session_id);
      else exclusive.add(row.session_id);
    }
  }
  return { exclusive, shared };
}

async function exclusiveSessionRows(db, project, userIds, includeHostedIdentity) {
  const found = new Set();
  const repeats = includeHostedIdentity ? 4 : 2;
  const size = Math.max(1, Math.min(PREDICATE_BATCH, Math.floor(90 / repeats)));
  for (const batch of batches(userIds, size)) {
    const marks = placeholders(batch.length);
    const resolvedOwner = includeHostedIdentity ? ` OR resolved_user_id IN (${marks})` : '';
    const rows = await db.queryAll(
      `SELECT session_id FROM sessions
        WHERE project_id = ?
          AND (user_id IN (${marks})${resolvedOwner})
          AND NOT EXISTS (
            SELECT 1 FROM events
             WHERE events.project_id = sessions.project_id
               AND events.session_id = sessions.session_id
               AND ${outsideSql(includeHostedIdentity, marks)}
          )`,
      [
        project,
        ...idListParams(batch, includeHostedIdentity),
        ...idListParams(batch, includeHostedIdentity),
      ],
    );
    for (const row of rows) found.add(row.session_id);
  }
  return found;
}

async function deleteEventsForUsers(db, project, userIds, includeHostedIdentity) {
  let deleted = 0;
  const size = includeHostedIdentity ? PREDICATE_BATCH : ERASURE_BATCH_SIZE;
  for (const batch of batches(userIds, size)) {
    const marks = placeholders(batch.length);
    const result = await db.run(
      `DELETE FROM events
        WHERE project_id = ? AND ${insideSql(includeHostedIdentity, marks)}`,
      [project, ...idListParams(batch, includeHostedIdentity)],
    );
    deleted += changeCount(result, 0);
  }
  return deleted;
}

async function deleteEventsForSession(db, project, sessionId) {
  const result = await db.run(
    'DELETE FROM events WHERE project_id = ? AND session_id = ?',
    [project, sessionId],
  );
  return changeCount(result, 0);
}

async function deleteSessions(db, project, sessionIds) {
  let deleted = 0;
  for (const batch of batches([...sessionIds], ERASURE_BATCH_SIZE)) {
    const result = await db.run(
      `DELETE FROM sessions
        WHERE project_id = ? AND session_id IN (${placeholders(batch.length)})`,
      [project, ...batch],
    );
    deleted += changeCount(result, batch.length);
  }
  return deleted;
}

async function deleteIdentityMap(db, project, userIds) {
  let deleted = 0;
  for (const batch of batches(userIds, PREDICATE_BATCH)) {
    const marks = placeholders(batch.length);
    const result = await db.run(
      `DELETE FROM identity_map
        WHERE project_id = ?
          AND (previous_id IN (${marks}) OR canonical_id IN (${marks}))`,
      [project, ...batch, ...batch],
    );
    deleted += changeCount(result, 0);
  }
  return deleted;
}

async function deleteAliases(db, project, scopeId, userIds) {
  let deleted = 0;
  const projectScope = `project:${project}`;
  for (const batch of batches(userIds, PREDICATE_BATCH)) {
    const marks = placeholders(batch.length);
    const result = await db.run(
      `DELETE FROM identity_aliases
        WHERE scope_id = ?
          AND (alias_id IN (${marks}) OR canonical_id IN (${marks}))
          AND (
            scope_id = ?
            OR EXISTS (
              SELECT 1 FROM project_identity_scopes
               WHERE project_id = ?
                 AND scope_id = identity_aliases.scope_id
            )
          )`,
      [scopeId, ...batch, ...batch, projectScope, project],
    );
    deleted += changeCount(result, 0);
  }
  return deleted;
}

async function deleteProfiles(db, project, userIds) {
  let deleted = 0;
  for (const batch of batches(userIds, ERASURE_BATCH_SIZE)) {
    const result = await db.run(
      `DELETE FROM user_profiles
        WHERE project_id = ? AND user_id IN (${placeholders(batch.length)})`,
      [project, ...batch],
    );
    deleted += changeCount(result, batch.length);
  }
  return deleted;
}

function normalizeEmailLookup(lookup) {
  if (!lookup || typeof lookup !== 'object') return null;
  const scopeId = lookup.scopeId || lookup.scope_id;
  const lookupIndex = lookup.lookupIndex || lookup.lookup_index;
  if (!scopeId || !lookupIndex) return null;
  return { scopeId, lookupIndex };
}

async function deleteEmailLookups(db, project, userIds, emailLookups) {
  let deleted = 0;
  for (const batch of batches(userIds, ERASURE_BATCH_SIZE)) {
    const result = await db.run(
      `DELETE FROM email_lookup_index
        WHERE project_id = ? AND user_id IN (${placeholders(batch.length)})`,
      [project, ...batch],
    );
    deleted += changeCount(result, 0);
  }
  for (const lookup of (emailLookups || []).map(normalizeEmailLookup).filter(Boolean)) {
    const result = await db.run(
      `DELETE FROM email_lookup_index
        WHERE project_id = ? AND scope_id = ? AND lookup_index = ?`,
      [project, lookup.scopeId, lookup.lookupIndex],
    );
    deleted += changeCount(result, 0);
  }
  return deleted;
}

async function recomputeSharedSessions(db, project, userIds, sharedIds, includeHostedIdentity) {
  if (userIds.length === 0) return;
  const sessionList = uniqueStrings(sharedIds);
  const sessionBatches = sessionList.length > 0 ? batches(sessionList, 40) : [[]];
  for (const idBatch of batches(userIds, includeHostedIdentity ? 8 : 12)) {
    for (const sessionBatch of sessionBatches) {
      const idMarks = placeholders(idBatch.length);
      const resolvedSet = includeHostedIdentity
        ? `, resolved_user_id = CASE
              WHEN resolved_user_id IN (${idMarks}) THEN (
                SELECT resolved_user_id FROM events
                 WHERE project_id = sessions.project_id
                   AND session_id = sessions.session_id
                   AND resolved_user_id IS NOT NULL
                   AND resolved_user_id NOT IN (${idMarks})
                 LIMIT 1
              )
              ELSE resolved_user_id
            END`
        : '';
      const resolvedWhere = includeHostedIdentity ? ` OR resolved_user_id IN (${idMarks})` : '';
      const sessionClause = sessionBatch.length > 0
        ? ` OR session_id IN (${placeholders(sessionBatch.length)})`
        : '';
      const params = [...idBatch, ...idBatch];
      if (includeHostedIdentity) params.push(...idBatch, ...idBatch);
      params.push(project, ...idBatch);
      if (includeHostedIdentity) params.push(...idBatch);
      if (sessionBatch.length > 0) params.push(...sessionBatch);
      await db.run(
        `UPDATE sessions
            SET event_count = (
                  SELECT COUNT(*) FROM events
                   WHERE project_id = sessions.project_id AND session_id = sessions.session_id
                ),
                start_time = COALESCE((
                  SELECT MIN(timestamp) FROM events
                   WHERE project_id = sessions.project_id AND session_id = sessions.session_id
                ), start_time),
                end_time = COALESCE((
                  SELECT MAX(timestamp) FROM events
                   WHERE project_id = sessions.project_id AND session_id = sessions.session_id
                ), end_time),
                duration = COALESCE((
                  SELECT MAX(timestamp) - MIN(timestamp) FROM events
                   WHERE project_id = sessions.project_id AND session_id = sessions.session_id
                ), 0),
                is_bounce = CASE WHEN (
                  SELECT COUNT(*) FROM events
                   WHERE project_id = sessions.project_id AND session_id = sessions.session_id
                ) > 1 THEN 0 ELSE 1 END,
                user_id = CASE
                  WHEN user_id IN (${idMarks}) THEN (
                    SELECT user_id FROM events
                     WHERE project_id = sessions.project_id
                       AND session_id = sessions.session_id
                       AND user_id IS NOT NULL
                       AND user_id NOT IN (${idMarks})
                     LIMIT 1
                  )
                  ELSE user_id
                END
                ${resolvedSet}
          WHERE project_id = ?
            AND (
              user_id IN (${idMarks})${resolvedWhere}${sessionClause}
            )`,
        params,
      );
    }
  }
}

/**
 * Delete rows for a user-id set or one session id.
 * mode 'user_ids' walks the identity graph once unless expandGraph is false.
 * mode 'session_id' does not walk.
 * In user mode, sessionIds are the sessions whose every event belongs to the
 * id set. Shared sessions are kept and are not returned for tombstones.
 * Callers must not log the returned ids.
 */
export async function eraseSubjectRows(db, {
  project,
  mode = 'user_ids',
  userIds = [],
  sessionId = null,
  includeHostedIdentity = false,
  aliasScopeIds = [],
  emailLookups = [],
  beforeDelete = null,
  expandGraph = true,
} = {}) {
  requireProject(project);
  const counts = emptyErasureCounts();

  if (mode === 'session_id') {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('session id is required');
    }
    if (beforeDelete) await beforeDelete({ userIds: [], sessionIds: [sessionId] });
    counts.events = await deleteEventsForSession(db, project, sessionId);
    counts.sessions = await deleteSessions(db, project, [sessionId]);
    return { counts, userIds: [], sessionIds: [sessionId] };
  }

  if (mode !== 'user_ids') throw new Error('unsupported erasure mode');

  const seeds = uniqueStrings(userIds);
  const expanded = seeds.length === 0
    ? []
    : expandGraph
      ? await collectIdentityGraph(db, {
        project,
        seedIds: seeds,
        includeHostedIdentity,
        aliasScopeIds,
      })
      : seeds;

  let exclusiveIds = [];
  let sharedIds = [];
  if (expanded.length > 0) {
    const classified = await classifyTouchedSessions(db, project, expanded, includeHostedIdentity);
    const fromRows = await exclusiveSessionRows(db, project, expanded, includeHostedIdentity);
    const exclusive = new Set([...classified.exclusive, ...fromRows]);
    for (const id of classified.shared) exclusive.delete(id);
    exclusiveIds = [...exclusive];
    sharedIds = [...classified.shared];
  }

  if (beforeDelete) {
    await beforeDelete({ userIds: expanded, sessionIds: exclusiveIds });
  }

  if (expanded.length > 0) {
    counts.events = await deleteEventsForUsers(db, project, expanded, includeHostedIdentity);
    counts.sessions = await deleteSessions(db, project, exclusiveIds);
    await recomputeSharedSessions(db, project, expanded, sharedIds, includeHostedIdentity);
    counts.identity_rows += await deleteIdentityMap(db, project, expanded);
  }
  if (includeHostedIdentity) {
    const scopes = await scopesForProject(db, project, aliasScopeIds);
    if (expanded.length > 0) {
      for (const scopeId of scopes) {
        counts.identity_rows += await deleteAliases(db, project, scopeId, expanded);
      }
      counts.profiles = await deleteProfiles(db, project, expanded);
    }
    counts.email_lookups = await deleteEmailLookups(db, project, expanded, emailLookups);
  }

  return { counts, userIds: expanded, sessionIds: exclusiveIds };
}

async function rememberHashed(set, hashes, value) {
  if (!value || hashes.size === 0) return;
  if (hashes.has(await hashErasureSubject(value))) set.add(value);
}

async function scanMatchingIds(db, { project, userHashes, sessionHashes, includeHostedIdentity }) {
  const userIds = new Set();
  const sessionIds = new Set();

  let lastEvent = '';
  for (;;) {
    const resolved = includeHostedIdentity ? ', resolved_user_id' : '';
    const rows = await db.queryAll(
      `SELECT id, user_id, session_id${resolved}
         FROM events
        WHERE project_id = ? AND id > ?
        ORDER BY id
        LIMIT ${PAGE_SIZE}`,
      [project, lastEvent],
    );
    for (const row of rows) {
      await rememberHashed(userIds, userHashes, row.user_id);
      if (includeHostedIdentity) await rememberHashed(userIds, userHashes, row.resolved_user_id);
      await rememberHashed(sessionIds, sessionHashes, row.session_id);
    }
    if (rows.length < PAGE_SIZE) break;
    lastEvent = rows[rows.length - 1].id;
  }

  let lastSession = '';
  for (;;) {
    const resolved = includeHostedIdentity ? ', resolved_user_id' : '';
    const rows = await db.queryAll(
      `SELECT session_id, user_id${resolved}
         FROM sessions
        WHERE project_id = ? AND session_id > ?
        ORDER BY session_id
        LIMIT ${PAGE_SIZE}`,
      [project, lastSession],
    );
    for (const row of rows) {
      await rememberHashed(sessionIds, sessionHashes, row.session_id);
      await rememberHashed(userIds, userHashes, row.user_id);
      if (includeHostedIdentity) await rememberHashed(userIds, userHashes, row.resolved_user_id);
    }
    if (rows.length < PAGE_SIZE) break;
    lastSession = rows[rows.length - 1].session_id;
  }

  let lastPrevious = '';
  for (;;) {
    const rows = await db.queryAll(
      `SELECT previous_id, canonical_id FROM identity_map
        WHERE project_id = ? AND previous_id > ?
        ORDER BY previous_id
        LIMIT ${PAGE_SIZE}`,
      [project, lastPrevious],
    );
    for (const row of rows) {
      await rememberHashed(userIds, userHashes, row.previous_id);
      await rememberHashed(userIds, userHashes, row.canonical_id);
    }
    if (rows.length < PAGE_SIZE) break;
    lastPrevious = rows[rows.length - 1].previous_id;
  }

  if (includeHostedIdentity && userHashes.size > 0) {
    let lastProfile = '';
    for (;;) {
      const rows = await db.queryAll(
        `SELECT user_id FROM user_profiles
          WHERE project_id = ? AND user_id > ?
          ORDER BY user_id
          LIMIT ${PAGE_SIZE}`,
        [project, lastProfile],
      );
      for (const row of rows) await rememberHashed(userIds, userHashes, row.user_id);
      if (rows.length < PAGE_SIZE) break;
      lastProfile = rows[rows.length - 1].user_id;
    }
  }

  return { userIds: [...userIds], sessionIds: [...sessionIds] };
}

function addCounts(target, extra) {
  target.events += extra.events;
  target.sessions += extra.sessions;
  target.identity_rows += extra.identity_rows;
  target.profiles += extra.profiles;
  target.email_lookups += extra.email_lookups;
}

/**
 * Re-apply a receipt that stores hashes, not raw subjects.
 * User and email receipts delete by the user id set only.
 * Session receipts delete that session only.
 * The returned object is counts only.
 */
export async function reapplyErasureReceipt(db, receipt, { includeHostedIdentity = false } = {}) {
  const project = receipt?.project_name;
  requireProject(project);
  const counts = emptyErasureCounts();
  const lookups = (Array.isArray(receipt.email_lookups) ? receipt.email_lookups : [])
    .map(normalizeEmailLookup)
    .filter(Boolean);

  if (receipt?.subject_type === 'session_id') {
    const found = await scanMatchingIds(db, {
      project,
      userHashes: new Set(),
      sessionHashes: new Set(receipt.session_id_hashes || []),
      includeHostedIdentity,
    });
    for (const sessionId of found.sessionIds) {
      const erased = await eraseSubjectRows(db, {
        project,
        mode: 'session_id',
        sessionId,
        includeHostedIdentity,
      });
      addCounts(counts, erased.counts);
    }
    return { counts };
  }

  const found = await scanMatchingIds(db, {
    project,
    userHashes: new Set(receipt.user_id_hashes || []),
    sessionHashes: new Set(),
    includeHostedIdentity,
  });
  if (found.userIds.length > 0 || lookups.length > 0) {
    const erased = await eraseSubjectRows(db, {
      project,
      mode: 'user_ids',
      userIds: found.userIds,
      includeHostedIdentity,
      emailLookups: lookups,
      expandGraph: false,
    });
    addCounts(counts, erased.counts);
  }
  return { counts };
}
