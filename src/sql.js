/**
 * Read-only SQL parser and project CTE wrapper shared by hosted and OSS.
 *
 * validateReadOnlySql(sql) -> { ok: true } | { ok: false, error: string }
 * resolveSqlWindow(window, now?) -> { date_from, date_to }
 * wrapProjectSql(sql, projectName, window) -> { sql, params, returnLimit, probeTruncation, window }
 *
 * params is [projectName, date_from, date_to, projectName, date_from, date_to].
 * The wrapper reads main.events and main.sessions. SQLite treats a CTE that selects
 * from its own name as a circular reference, so the base table has to be schema-qualified
 * inside the server wrapper. User SQL cannot use schema qualifiers.
 *
 * The window predicate is events.date and sessions.date. Those are the columns covered by
 * idx_events_project_date (project_id, date) and idx_sessions_project_date (project_id, date).
 * timestamp and start_time do not have a project-scoped range index, so they are not the
 * window predicate.
 */

import { AnalyticsError, ERROR_CODES } from './errors.js';

export const SQL_MAX_BYTES = 20 * 1024;
export const SQL_ROW_CAP = 1000;
export const SQL_FETCH_CAP = 1001;
export const SQL_MAX_TABLE_REFS = 2;
export const SQL_WINDOW_DEFAULT_DAYS = 7;
export const SQL_WINDOW_MAX_DAYS = 90;
const MS_PER_DAY = 86_400_000;

export const READ_ONLY_SQL_COLUMNS = Object.freeze({
  events: Object.freeze([
    'id',
    'event',
    'properties',
    'user_id',
    'session_id',
    'timestamp',
    'date',
    'country',
  ]),
  sessions: Object.freeze([
    'session_id',
    'user_id',
    'project_id',
    'start_time',
    'end_time',
    'duration',
    'entry_page',
    'exit_page',
    'event_count',
    'is_bounce',
    'date',
  ]),
});

const FORBIDDEN_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'ALTER', 'DROP', 'CREATE',
  'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX',
]);

const FORBIDDEN_IDENTIFIERS = new Set([
  'SQLITE_MASTER',
  'SQLITE_SCHEMA',
  'SQLITE_TEMP_MASTER',
  'SQLITE_TEMP_SCHEMA',
]);

const SCHEMA_NAMES = new Set(['MAIN', 'TEMP']);
const ALLOWED_TABLES = new Set(['EVENTS', 'SESSIONS']);

const ALIAS_STOP = new Set([
  'WHERE', 'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'LIMIT', 'OFFSET',
  'UNION', 'EXCEPT', 'INTERSECT', 'JOIN', 'ON', 'USING',
  'LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'NATURAL', 'OUTER',
  'RETURNING', 'SET', 'AND', 'OR',
]);

function fail(error) {
  return { ok: false, error };
}

function scanWords(text) {
  return text.toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) || [];
}

function commentError(text) {
  for (const word of scanWords(text)) {
    if (FORBIDDEN_KEYWORDS.has(word)) {
      return `write keyword ${word} is not allowed`;
    }
    if (FORBIDDEN_IDENTIFIERS.has(word)) {
      return `${word.toLowerCase()} is not allowed`;
    }
  }
  return null;
}

function tokenize(sql) {
  const tokens = [];
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      i += 1;
      continue;
    }
    if (ch.charCodeAt(0) > 127) return fail('unsupported character');

    if (ch === '-' && sql[i + 1] === '-') {
      const start = i;
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      const error = commentError(sql.slice(start, i));
      if (error) return fail(error);
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return fail('unterminated comment');
      const error = commentError(sql.slice(i, end + 2));
      if (error) return fail(error);
      i = end + 2;
      continue;
    }

    if (ch === "'") {
      const start = i;
      i += 1;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return fail('unterminated string');
      tokens.push({ type: 'string', text: sql.slice(start, i), start, end: i });
      continue;
    }

    if ((ch === 'X' || ch === 'x') && sql[i + 1] === "'") {
      const start = i;
      i += 2;
      while (i < sql.length && sql[i] !== "'") i += 1;
      if (sql[i] !== "'") return fail('unterminated string');
      i += 1;
      tokens.push({ type: 'string', text: sql.slice(start, i), start, end: i });
      continue;
    }

    if (ch === '"' || ch === '`' || ch === '[') {
      const start = i;
      const closer = ch === '[' ? ']' : ch;
      i += 1;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === closer) {
          if (closer !== ']' && sql[i + 1] === closer) {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return fail('unterminated identifier');
      const raw = sql.slice(start + 1, i - 1).replaceAll(closer + closer, closer);
      tokens.push({
        type: 'quoted',
        text: raw,
        upper: raw.toUpperCase(),
        start,
        end: i,
      });
      continue;
    }

    if (ch === '?' || ch === ':' || ch === '@' || ch === '$') {
      const start = i;
      i += 1;
      if (ch === '?') {
        while (i < sql.length && sql[i] >= '0' && sql[i] <= '9') i += 1;
      } else if (i < sql.length && /[A-Za-z_]/.test(sql[i])) {
        while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i += 1;
      } else {
        return fail('invalid bind parameter');
      }
      tokens.push({ type: 'param', text: sql.slice(start, i), start, end: i });
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      const start = i;
      while (i < sql.length && sql[i] >= '0' && sql[i] <= '9') i += 1;
      if (i < sql.length && /[A-Za-z_]/.test(sql[i])) return fail('invalid number');
      tokens.push({ type: 'number', text: sql.slice(start, i), start, end: i });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i += 1;
      const text = sql.slice(start, i);
      tokens.push({ type: 'word', text, upper: text.toUpperCase(), start, end: i });
      continue;
    }

    tokens.push({ type: 'punct', text: ch, start: i, end: i + 1 });
    i += 1;
  }

  return { ok: true, tokens };
}

function isName(token) {
  return token && (token.type === 'word' || token.type === 'quoted');
}

function collectTableRefs(tokens, ctes = new Set()) {
  const tables = [];
  let i = 0;
  let scope = ctes;

  function peek() {
    return tokens[i];
  }

  function readName() {
    const token = peek();
    if (!isName(token)) return null;
    i += 1;
    return token;
  }

  function skipBalancedParens() {
    if (peek()?.text !== '(') return true;
    let depth = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      i += 1;
      if (token.text === '(') depth += 1;
      else if (token.text === ')') {
        depth -= 1;
        if (depth === 0) return true;
      }
    }
    return false;
  }

  function collectInsideParens() {
    const start = i + 1;
    if (!skipBalancedParens()) return fail('unterminated parenthesis');
    const nested = collectTableRefs(tokens.slice(start, i - 1), scope);
    if (nested.ok === false) return nested;
    tables.push(...nested.tables);
    return null;
  }

  function skipTableTail() {
    const token = peek();
    if (token?.upper === 'NOT' && tokens[i + 1]?.upper === 'INDEXED') {
      i += 2;
    } else if (token?.upper === 'INDEXED' && tokens[i + 1]?.upper === 'BY') {
      i += 2;
      if (!readName()) return fail('invalid INDEXED BY clause');
    }

    if (peek()?.upper === 'AS') {
      i += 1;
      if (!readName()) return fail('missing table alias');
    } else if (isName(peek()) && !ALIAS_STOP.has(peek().upper)) {
      i += 1;
    }

    if (peek()?.text === '(') {
      const nested = collectInsideParens();
      if (nested) return nested;
    }
    return null;
  }

  function parseTableFactor() {
    const token = peek();
    if (!token) return fail('missing table name');
    if (token.text === '(') {
      const nested = collectInsideParens();
      if (nested) return nested;
      return skipTableTail();
    }

    if (!isName(token)) return fail('table reference is not allowed');
    if (tokens[i + 1]?.text === '(') return fail('table-valued functions are not allowed');

    const first = readName();
    if (peek()?.text === '.') {
      i += 1;
      const second = readName();
      if (!second) return fail('schema-qualified names are not allowed');
      tables.push({ schema: first, name: second, dotted: true });
      return skipTableTail();
    }
    if (scope.has(first.upper)) return skipTableTail();
    if (!ALLOWED_TABLES.has(first.upper)) return fail(`table ${first.text} is not allowed`);
    tables.push({ schema: null, name: first, dotted: false });
    return skipTableTail();
  }

  function parseWith() {
    const local = new Set(scope);
    while (i < tokens.length) {
      const name = readName();
      if (!name) return fail('missing CTE name');
      if (peek()?.upper !== 'AS' || tokens[i + 1]?.text !== '(') return fail('invalid CTE');
      i += 2;
      const bodyStart = i;
      let depth = 1;
      while (i < tokens.length && depth > 0) {
        if (tokens[i].text === '(') depth += 1;
        else if (tokens[i].text === ')') depth -= 1;
        if (depth > 0) i += 1;
      }
      if (depth !== 0) return fail('unterminated parenthesis');
      const nested = collectTableRefs(tokens.slice(bodyStart, i), local);
      i += 1;
      if (nested.ok === false) return nested;
      tables.push(...nested.tables);
      local.add(name.upper);
      if (peek()?.text === ',') {
        i += 1;
        continue;
      }
      break;
    }
    scope = local;
    return null;
  }

  while (i < tokens.length) {
    const token = tokens[i];
    if (token.upper === 'WITH') {
      i += 1;
      const error = parseWith();
      if (error) return error;
      continue;
    }
    if (token.upper === 'FROM' || token.upper === 'JOIN' || token.upper === 'IN') {
      const fromList = token.upper === 'FROM';
      i += 1;
      const error = parseTableFactor();
      if (error) return error;
      if (fromList) {
        while (peek()?.text === ',') {
          i += 1;
          const commaError = parseTableFactor();
          if (commaError) return commaError;
        }
      }
      continue;
    }
    i += 1;
  }

  return { tables };
}

function validateTokens(tokens) {
  if (tokens.length === 0) return fail('SQL is required');

  let semis = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.text === ';') {
      semis += 1;
      if (semis > 1) return fail('multiple statements are not allowed');
      continue;
    }
    if (semis > 0) return fail('multiple statements are not allowed');
    if (token.type === 'param') return fail('bind parameters are not accepted');
    if (token.upper === 'RECURSIVE') return fail('recursive CTE is not allowed');
    if (token.upper === 'RANDOMBLOB' || token.upper === 'ZEROBLOB') {
      return fail(`${token.text.toLowerCase()} is not allowed`);
    }
    if (token.type === 'word' && FORBIDDEN_KEYWORDS.has(token.upper)) {
      return fail(`write keyword ${token.upper} is not allowed`);
    }
    if (isName(token) && FORBIDDEN_IDENTIFIERS.has(token.upper)) {
      return fail(`${token.text.toLowerCase()} is not allowed`);
    }
    if (isName(token) && SCHEMA_NAMES.has(token.upper) && tokens[i + 1]?.text === '.') {
      return fail('schema-qualified names are not allowed');
    }
  }

  const first = tokens.find((token) => token.text !== ';');
  if (!first || first.upper !== 'SELECT') {
    return fail('only a single SELECT statement is accepted');
  }

  const collected = collectTableRefs(tokens);
  if (collected.error || collected.ok === false) return collected;
  const events = collected.tables.filter((table) => table.name.upper === 'EVENTS').length;
  const sessions = collected.tables.filter((table) => table.name.upper === 'SESSIONS').length;
  if (events > 1 || sessions > 1) {
    return fail('events and sessions may each be referenced only once');
  }
  for (const table of collected.tables) {
    if (table.dotted || table.schema) return fail('schema-qualified names are not allowed');
    if (!ALLOWED_TABLES.has(table.name.upper)) {
      return fail(`table ${table.name.text} is not allowed`);
    }
  }

  return { ok: true, tokens };
}

const LIMIT_OPERATORS = new Set(['+', '-', '*', '/', '%', '|', '&', '.']);

function plainNumber(token) {
  if (!token || token.type !== 'number') return null;
  const value = Number(token.text);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return { value, token };
}

function plainLimitAt(tokens, index) {
  const countOrOffset = plainNumber(tokens[index + 1]);
  if (!countOrOffset) return null;
  let end = index + 2;
  let count = countOrOffset;
  if (tokens[end]?.text === ',') {
    const second = plainNumber(tokens[end + 1]);
    if (!second) return null;
    count = second;
    end += 2;
  } else if (tokens[end]?.upper === 'OFFSET') {
    const second = plainNumber(tokens[end + 1]);
    if (!second) return null;
    end += 2;
  }
  if (LIMIT_OPERATORS.has(tokens[end]?.text)) return null;
  return { count: count.value, countToken: count.token, end };
}

function rejectUnsafeLimits(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].upper !== 'LIMIT') continue;
    if (!plainLimitAt(tokens, i)) return fail('LIMIT must be a plain non-negative integer');
  }
  return null;
}

function applyRowCap(sql, tokens) {
  let depth = 0;
  const limits = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.text === '(') depth += 1;
    else if (token.text === ')') depth -= 1;
    else if (token.upper === 'LIMIT' && depth === 0) limits.push(i);
  }
  if (limits.length > 1) return fail('multiple LIMIT clauses are not allowed');

  const unsafe = rejectUnsafeLimits(tokens);
  if (unsafe) return unsafe;

  if (limits.length === 0) {
    const semi = tokens.find((token) => token.text === ';');
    const at = semi ? semi.start : sql.length;
    const head = sql.slice(0, at).replace(/\s*$/, '');
    const tail = sql.slice(at);
    return {
      ok: true,
      sql: `${head}\nLIMIT ${SQL_FETCH_CAP}${tail}`,
      returnLimit: SQL_ROW_CAP,
      probeTruncation: true,
    };
  }

  const parsed = plainLimitAt(tokens, limits[0]);
  if (!parsed) return fail('LIMIT must be a plain non-negative integer');
  if (parsed.count <= SQL_ROW_CAP) {
    return { ok: true, sql, returnLimit: parsed.count, probeTruncation: false };
  }
  const token = parsed.countToken;
  return {
    ok: true,
    sql: `${sql.slice(0, token.start)}${SQL_FETCH_CAP}${sql.slice(token.end)}`,
    returnLimit: SQL_ROW_CAP,
    probeTruncation: true,
  };
}

function parseReadOnlySql(sql) {
  if (typeof sql !== 'string') return fail('SQL must be a string');
  if (new TextEncoder().encode(sql).length > SQL_MAX_BYTES) return fail('SQL exceeds 20 KB');
  if (sql.includes('\0')) return fail('SQL contains a NUL byte');
  const lexed = tokenize(sql);
  if (!lexed.ok) return lexed;
  return validateTokens(lexed.tokens);
}

export function validateReadOnlySql(sql) {
  const parsed = parseReadOnlySql(sql);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const capped = applyRowCap(sql, parsed.tokens);
  if (!capped.ok) return { ok: false, error: capped.error };
  return { ok: true };
}

function utcDate(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function addUtcDays(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function inclusiveDaySpan(dateFrom, dateTo) {
  const start = Date.parse(`${dateFrom}T00:00:00.000Z`);
  const end = Date.parse(`${dateTo}T00:00:00.000Z`);
  return Math.round((end - start) / MS_PER_DAY) + 1;
}

function parseWindowDate(value) {
  if (typeof value !== 'string' || !/^(\d{4})-(\d{2})-(\d{2})$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return value;
}

function windowError(message) {
  throw new AnalyticsError(ERROR_CODES.INVALID_WINDOW, message, 400);
}

export function resolveSqlWindow(window, now = new Date()) {
  if (window == null) {
    const dateTo = utcDate(now);
    return { date_from: addUtcDays(dateTo, -(SQL_WINDOW_DEFAULT_DAYS - 1)), date_to: dateTo };
  }
  if (typeof window !== 'object' || Array.isArray(window)) windowError('window must be an object');

  const hasDays = Object.hasOwn(window, 'days');
  const hasFrom = Object.hasOwn(window, 'date_from');
  const hasTo = Object.hasOwn(window, 'date_to');
  if (hasDays && (hasFrom || hasTo)) {
    windowError('use days or date_from and date_to, not both');
  }
  if (!hasDays && !hasFrom && !hasTo) {
    const dateTo = utcDate(now);
    return { date_from: addUtcDays(dateTo, -(SQL_WINDOW_DEFAULT_DAYS - 1)), date_to: dateTo };
  }
  if (hasDays) {
    if (typeof window.days !== 'number' || !Number.isInteger(window.days) || window.days < 1 || window.days > SQL_WINDOW_MAX_DAYS) {
      windowError(`days must be an integer from 1 to ${SQL_WINDOW_MAX_DAYS}`);
    }
    const dateTo = utcDate(now);
    return { date_from: addUtcDays(dateTo, -(window.days - 1)), date_to: dateTo };
  }
  if (!hasFrom || !hasTo) windowError('date_from and date_to are both required');

  const dateFrom = parseWindowDate(window.date_from);
  const dateTo = parseWindowDate(window.date_to);
  if (!dateFrom || !dateTo) windowError('date_from and date_to must be YYYY-MM-DD');
  if (dateFrom > dateTo) windowError('date_from must be on or before date_to');
  if (inclusiveDaySpan(dateFrom, dateTo) > SQL_WINDOW_MAX_DAYS) {
    windowError(`date span must be at most ${SQL_WINDOW_MAX_DAYS} days`);
  }
  return { date_from: dateFrom, date_to: dateTo };
}

function wrapCtes(userSql) {
  const events = READ_ONLY_SQL_COLUMNS.events.join(', ');
  const sessions = READ_ONLY_SQL_COLUMNS.sessions.join(', ');
  return `WITH events AS (
  SELECT ${events}
  FROM main.events WHERE project_id = ? AND date >= ? AND date <= ?
),
sessions AS (
  SELECT ${sessions}
  FROM main.sessions WHERE project_id = ? AND date >= ? AND date <= ?
)
${userSql}`;
}

export function wrapProjectSql(sql, projectName, window) {
  const parsed = parseReadOnlySql(sql);
  if (!parsed.ok) {
    throw new AnalyticsError(ERROR_CODES.INVALID_SQL, parsed.error, 400);
  }
  if (typeof projectName !== 'string' || projectName.length === 0) {
    throw new AnalyticsError(ERROR_CODES.PROJECT_REQUIRED, 'project name is required', 400);
  }
  const resolvedWindow = resolveSqlWindow(window);
  const capped = applyRowCap(sql, parsed.tokens);
  if (!capped.ok) {
    throw new AnalyticsError(ERROR_CODES.INVALID_SQL, capped.error, 400);
  }
  return {
    sql: wrapCtes(capped.sql),
    params: [projectName, resolvedWindow.date_from, resolvedWindow.date_to, projectName, resolvedWindow.date_from, resolvedWindow.date_to],
    returnLimit: capped.returnLimit,
    probeTruncation: capped.probeTruncation,
    window: resolvedWindow,
  };
}
