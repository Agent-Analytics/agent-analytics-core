/**
 * Read-only SQL parser and project CTE wrapper shared by hosted and OSS.
 *
 * validateReadOnlySql(sql) -> { ok: true } | { ok: false, error: string }
 * wrapProjectSql(sql, projectName) -> { sql, params, returnLimit, probeTruncation }
 *
 * params is [projectName, projectName]: the events CTE filter, then the sessions CTE filter.
 * The wrapper reads main.events and main.sessions. SQLite treats a CTE that selects
 * from its own name as a circular reference, so the base table has to be schema-qualified
 * inside the server wrapper. User SQL cannot use schema qualifiers.
 */

import { AnalyticsError, ERROR_CODES } from './errors.js';

export const SQL_MAX_BYTES = 20 * 1024;
export const SQL_ROW_CAP = 1000;
export const SQL_FETCH_CAP = 1001;

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

function collectTableRefs(tokens) {
  const tables = [];
  let i = 0;

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
    const nested = collectTableRefs(tokens.slice(start, i - 1));
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

    const first = readName();
    if (!first) return fail('missing table name');
    if (peek()?.text === '.') {
      i += 1;
      const second = readName();
      if (!second) return fail('schema-qualified names are not allowed');
      tables.push({ schema: first, name: second, dotted: true });
    } else {
      tables.push({ schema: null, name: first, dotted: false });
    }
    return skipTableTail();
  }

  while (i < tokens.length) {
    const token = tokens[i];
    if (token.upper === 'FROM' || token.upper === 'JOIN') {
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
  for (const table of collected.tables) {
    if (table.dotted || table.schema) return fail('schema-qualified names are not allowed');
    if (!ALLOWED_TABLES.has(table.name.upper)) {
      return fail(`table ${table.name.text} is not allowed`);
    }
  }

  return { ok: true, tokens };
}

function parseInteger(tokens, index) {
  const token = tokens[index];
  if (!token) return null;
  if (token.type === 'number') {
    return { value: Number(token.text), token, end: index + 1 };
  }
  if (token.text === '(' && tokens[index + 1]?.type === 'number' && tokens[index + 2]?.text === ')') {
    return { value: Number(tokens[index + 1].text), token: tokens[index + 1], end: index + 3 };
  }
  return null;
}

function parseLimitClause(tokens, index) {
  const countOrOffset = parseInteger(tokens, index + 1);
  if (!countOrOffset) return null;
  const next = tokens[countOrOffset.end];
  if (next?.text === ',') {
    const count = parseInteger(tokens, countOrOffset.end + 1);
    if (!count) return null;
    return { count: count.value, countToken: count.token };
  }
  if (next?.upper === 'OFFSET') {
    const offset = parseInteger(tokens, countOrOffset.end + 1);
    if (!offset) return null;
    return { count: countOrOffset.value, countToken: countOrOffset.token };
  }
  return { count: countOrOffset.value, countToken: countOrOffset.token };
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

  if (limits.length === 0) {
    const semi = tokens.find((token) => token.text === ';');
    const at = semi ? semi.start : sql.length;
    const head = sql.slice(0, at).replace(/\s*$/, '');
    const tail = sql.slice(at);
    return {
      ok: true,
      sql: `${head} LIMIT ${SQL_FETCH_CAP}${tail}`,
      returnLimit: SQL_ROW_CAP,
      probeTruncation: true,
    };
  }

  const parsed = parseLimitClause(tokens, limits[0]);
  if (!parsed || !Number.isSafeInteger(parsed.count) || parsed.count < 0) {
    return fail('LIMIT must be a non-negative integer literal');
  }
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

function wrapCtes(userSql) {
  const events = READ_ONLY_SQL_COLUMNS.events.join(', ');
  const sessions = READ_ONLY_SQL_COLUMNS.sessions.join(', ');
  return `WITH events AS (
  SELECT ${events}
  FROM main.events WHERE project_id = ?
),
sessions AS (
  SELECT ${sessions}
  FROM main.sessions WHERE project_id = ?
)
${userSql}`;
}

export function wrapProjectSql(sql, projectName) {
  const parsed = parseReadOnlySql(sql);
  if (!parsed.ok) {
    throw new AnalyticsError(ERROR_CODES.INVALID_SQL, parsed.error, 400);
  }
  if (typeof projectName !== 'string' || projectName.length === 0) {
    throw new AnalyticsError(ERROR_CODES.PROJECT_REQUIRED, 'project name is required', 400);
  }
  const capped = applyRowCap(sql, parsed.tokens);
  if (!capped.ok) {
    throw new AnalyticsError(ERROR_CODES.INVALID_SQL, capped.error, 400);
  }
  return {
    sql: wrapCtes(capped.sql),
    params: [projectName, projectName],
    returnLimit: capped.returnLimit,
    probeTruncation: capped.probeTruncation,
  };
}
