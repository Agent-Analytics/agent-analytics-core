/**
 * Delete analytics rows for one subject, by primary key, inside one project.
 *
 * OSS databases have events, sessions, and identity_map. Hosted databases also
 * have resolved_user_id, identity_aliases, user_profiles, email_lookup_index,
 * and project_identity_scopes. Pass includeHostedIdentity for that schema.
 * Every statement binds the project name. The identity graph is walked once
 * from the seed ids, not followed into a second hop.
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

async function countUserEvents(db, project, userIds, includeHostedIdentity) {
  const ids = uniqueStrings(userIds);
  if (ids.length === 0) return 0;
  if (ids.length <= PREDICATE_BATCH) {
    const marks = placeholders(ids.length);
    const resolved = includeHostedIdentity ? ` OR resolved_user_id IN (${marks})` : '';
    const params = includeHostedIdentity ? [project, ...ids, ...ids] : [project, ...ids];
    const row = await db.queryOne(
      `SELECT COUNT(*) AS n FROM events
        WHERE project_id = ? AND (user_id IN (${marks})${resolved})`,
      params,
    );
    return Number(row?.n) || 0;
  }

  const eventIds = new Set();
  for (const batch of batches(ids, PREDICATE_BATCH)) {
    const marks = placeholders(batch.length);
    const resolved = includeHostedIdentity ? ` OR resolved_user_id IN (${marks})` : '';
    const params = includeHostedIdentity
      ? [project, ...batch, ...batch]
      : [project, ...batch];
    let lastId = '';
    for (;;) {
      const rows = await db.queryAll(
        `SELECT id FROM events
          WHERE project_id = ? AND id > ? AND (user_id IN (${marks})${resolved})
          ORDER BY id
          LIMIT ${PAGE_SIZE}`,
        [project, lastId, ...params.slice(1)],
      );
      for (const row of rows) eventIds.add(row.id);
      if (rows.length < PAGE_SIZE) break;
      lastId = rows[rows.length - 1].id;
    }
  }
  return eventIds.size;
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

async function collectUserEvents(db, project, userIds, includeHostedIdentity) {
  const eventIds = new Set();
  const sessionIds = new Set();
  for (const batch of batches(userIds, PREDICATE_BATCH)) {
    const marks = placeholders(batch.length);
    const resolved = includeHostedIdentity ? ` OR resolved_user_id IN (${marks})` : '';
    let lastId = '';
    for (;;) {
      const rows = await db.queryAll(
        `SELECT id, session_id FROM events
          WHERE project_id = ? AND id > ?
            AND (user_id IN (${marks})${resolved})
          ORDER BY id
          LIMIT ${PAGE_SIZE}`,
        [project, lastId, ...batch, ...(includeHostedIdentity ? batch : [])],
      );
      for (const row of rows) {
        eventIds.add(row.id);
        if (row.session_id) sessionIds.add(row.session_id);
      }
      if (rows.length < PAGE_SIZE) break;
      lastId = rows[rows.length - 1].id;
    }
  }
  return { eventIds, sessionIds };
}

async function collectSessionEvents(db, project, sessionId) {
  const eventIds = [];
  let lastId = '';
  for (;;) {
    const rows = await db.queryAll(
      `SELECT id FROM events
        WHERE project_id = ? AND id > ? AND session_id = ?
        ORDER BY id
        LIMIT ${PAGE_SIZE}`,
      [project, lastId, sessionId],
    );
    for (const row of rows) eventIds.push(row.id);
    if (rows.length < PAGE_SIZE) break;
    lastId = rows[rows.length - 1].id;
  }
  return eventIds;
}

async function collectUserSessions(db, project, userIds, includeHostedIdentity) {
  const sessionIds = new Set();
  for (const batch of batches(userIds, PREDICATE_BATCH)) {
    const marks = placeholders(batch.length);
    const resolved = includeHostedIdentity ? ` OR resolved_user_id IN (${marks})` : '';
    let lastId = '';
    for (;;) {
      const rows = await db.queryAll(
        `SELECT session_id FROM sessions
          WHERE project_id = ? AND session_id > ?
            AND (user_id IN (${marks})${resolved})
          ORDER BY session_id
          LIMIT ${PAGE_SIZE}`,
        [project, lastId, ...batch, ...(includeHostedIdentity ? batch : [])],
      );
      for (const row of rows) sessionIds.add(row.session_id);
      if (rows.length < PAGE_SIZE) break;
      lastId = rows[rows.length - 1].session_id;
    }
  }
  return sessionIds;
}

async function deleteByIds(db, sqlPrefix, project, ids) {
  let deleted = 0;
  for (const batch of batches(ids, ERASURE_BATCH_SIZE)) {
    const result = await db.run(
      `${sqlPrefix} AND id IN (${placeholders(batch.length)})`,
      [project, ...batch],
    );
    deleted += changeCount(result, batch.length);
  }
  return deleted;
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
  const previousIds = new Set();
  for (const batch of batches(userIds, PREDICATE_BATCH)) {
    const marks = placeholders(batch.length);
    let lastId = '';
    for (;;) {
      const rows = await db.queryAll(
        `SELECT previous_id FROM identity_map
          WHERE project_id = ? AND previous_id > ?
            AND (previous_id IN (${marks}) OR canonical_id IN (${marks}))
          ORDER BY previous_id
          LIMIT ${PAGE_SIZE}`,
        [project, lastId, ...batch, ...batch],
      );
      for (const row of rows) previousIds.add(row.previous_id);
      if (rows.length < PAGE_SIZE) break;
      lastId = rows[rows.length - 1].previous_id;
    }
  }

  let deleted = 0;
  for (const batch of batches([...previousIds], ERASURE_BATCH_SIZE)) {
    const result = await db.run(
      `DELETE FROM identity_map
        WHERE project_id = ? AND previous_id IN (${placeholders(batch.length)})`,
      [project, ...batch],
    );
    deleted += changeCount(result, batch.length);
  }
  return deleted;
}

async function deleteAliases(db, project, scopeId, userIds) {
  const aliasIds = new Set();
  const projectScope = `project:${project}`;
  for (const batch of batches(userIds, PREDICATE_BATCH)) {
    const marks = placeholders(batch.length);
    let lastId = '';
    for (;;) {
      const rows = await db.queryAll(
        `SELECT alias_id FROM identity_aliases
          WHERE scope_id = ? AND alias_id > ?
            AND (alias_id IN (${marks}) OR canonical_id IN (${marks}))
            AND (
              scope_id = ?
              OR EXISTS (
                SELECT 1 FROM project_identity_scopes
                 WHERE project_id = ?
                   AND scope_id = identity_aliases.scope_id
              )
            )
          ORDER BY alias_id
          LIMIT ${PAGE_SIZE}`,
        [scopeId, lastId, ...batch, ...batch, projectScope, project],
      );
      for (const row of rows) aliasIds.add(row.alias_id);
      if (rows.length < PAGE_SIZE) break;
      lastId = rows[rows.length - 1].alias_id;
    }
  }

  let deleted = 0;
  for (const batch of batches([...aliasIds], ERASURE_BATCH_SIZE)) {
    const result = await db.run(
      `DELETE FROM identity_aliases
        WHERE scope_id = ? AND alias_id IN (${placeholders(batch.length)})
          AND (
            scope_id = ?
            OR EXISTS (
              SELECT 1 FROM project_identity_scopes
               WHERE project_id = ?
                 AND scope_id = identity_aliases.scope_id
            )
          )`,
      [scopeId, ...batch, projectScope, project],
    );
    deleted += changeCount(result, batch.length);
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
  const keys = new Map();
  const remember = (row) => {
    if (!row?.scope_id || !row?.user_id) return;
    keys.set(`${row.scope_id}\n${row.user_id}`, row);
  };

  for (const batch of batches(userIds, ERASURE_BATCH_SIZE)) {
    const rows = await db.queryAll(
      `SELECT scope_id, user_id FROM email_lookup_index
        WHERE project_id = ? AND user_id IN (${placeholders(batch.length)})`,
      [project, ...batch],
    );
    for (const row of rows) remember(row);
  }

  for (const lookup of (emailLookups || []).map(normalizeEmailLookup).filter(Boolean)) {
    const rows = await db.queryAll(
      `SELECT scope_id, user_id FROM email_lookup_index
        WHERE project_id = ? AND scope_id = ? AND lookup_index = ?`,
      [project, lookup.scopeId, lookup.lookupIndex],
    );
    for (const row of rows) remember(row);
  }

  let deleted = 0;
  for (const row of keys.values()) {
    const result = await db.run(
      `DELETE FROM email_lookup_index
        WHERE project_id = ? AND scope_id = ? AND user_id = ?`,
      [project, row.scope_id, row.user_id],
    );
    deleted += changeCount(result, 1);
  }
  return deleted;
}

/**
 * Delete rows for a user-id set or one session id.
 * mode 'user_ids' walks the identity graph once. mode 'session_id' does not.
 * Returns counts plus the ids the caller may hash into tombstones. Callers
 * must not log those ids.
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
} = {}) {
  requireProject(project);
  const counts = emptyErasureCounts();

  if (mode === 'session_id') {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('session id is required');
    }
    const eventIds = await collectSessionEvents(db, project, sessionId);
    if (beforeDelete) await beforeDelete({ userIds: [], sessionIds: [sessionId] });
    counts.events = await deleteByIds(
      db,
      'DELETE FROM events WHERE project_id = ?',
      project,
      eventIds,
    );
    counts.sessions = await deleteSessions(db, project, [sessionId]);
    return { counts, userIds: [], sessionIds: [sessionId] };
  }

  if (mode !== 'user_ids') throw new Error('unsupported erasure mode');

  const seeds = uniqueStrings(userIds);
  const expanded = seeds.length === 0
    ? []
    : await collectIdentityGraph(db, {
      project,
      seedIds: seeds,
      includeHostedIdentity,
      aliasScopeIds,
    });

  const { eventIds, sessionIds } = expanded.length === 0
    ? { eventIds: new Set(), sessionIds: new Set() }
    : await collectUserEvents(db, project, expanded, includeHostedIdentity);
  if (expanded.length > 0) {
    for (const sessionIdValue of await collectUserSessions(db, project, expanded, includeHostedIdentity)) {
      sessionIds.add(sessionIdValue);
    }
  }

  if (beforeDelete) {
    await beforeDelete({ userIds: expanded, sessionIds: [...sessionIds] });
  }

  counts.events = await deleteByIds(
    db,
    'DELETE FROM events WHERE project_id = ?',
    project,
    [...eventIds],
  );
  counts.sessions = await deleteSessions(db, project, sessionIds);
  if (expanded.length > 0) {
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

  return { counts, userIds: expanded, sessionIds: [...sessionIds] };
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
 * Re-apply a receipt that stores hashes, not raw subjects. Scans one project,
 * then deletes by primary key. The returned object is counts only.
 */
export async function reapplyErasureReceipt(db, receipt, { includeHostedIdentity = false } = {}) {
  const project = receipt?.project_name;
  requireProject(project);
  const found = await scanMatchingIds(db, {
    project,
    userHashes: new Set(receipt.user_id_hashes || []),
    sessionHashes: new Set(receipt.session_id_hashes || []),
    includeHostedIdentity,
  });
  const counts = emptyErasureCounts();
  const lookups = (Array.isArray(receipt.email_lookups) ? receipt.email_lookups : [])
    .map(normalizeEmailLookup)
    .filter(Boolean);
  if (found.userIds.length > 0 || lookups.length > 0) {
    const erased = await eraseSubjectRows(db, {
      project,
      mode: 'user_ids',
      userIds: found.userIds,
      includeHostedIdentity,
      emailLookups: lookups,
    });
    addCounts(counts, erased.counts);
  }
  for (const sessionId of found.sessionIds) {
    const erased = await eraseSubjectRows(db, {
      project,
      mode: 'session_id',
      sessionId,
    });
    addCounts(counts, erased.counts);
  }
  return { counts };
}
