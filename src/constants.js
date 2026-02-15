export const GRANULARITY = Object.freeze({
  HOUR: 'hour', DAY: 'day', WEEK: 'week', MONTH: 'month',
});
export const VALID_GRANULARITIES = Object.freeze(Object.values(GRANULARITY));

export const METRICS = Object.freeze({
  EVENT_COUNT: 'event_count',
  UNIQUE_USERS: 'unique_users',
  SESSION_COUNT: 'session_count',
  BOUNCE_RATE: 'bounce_rate',
  AVG_DURATION: 'avg_duration',
});
export const ALLOWED_METRICS = Object.freeze(Object.values(METRICS));

export const GROUP_BY_FIELDS = Object.freeze({
  EVENT: 'event', DATE: 'date', USER_ID: 'user_id', SESSION_ID: 'session_id',
});
export const ALLOWED_GROUP_BY = Object.freeze(Object.values(GROUP_BY_FIELDS));

export const FILTER_OPS = Object.freeze({
  eq: '=', neq: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=',
});

export const FILTERABLE_FIELDS = Object.freeze(['event', 'user_id', 'date']);

export const ALLOWED_ORDER_BY = Object.freeze(['event_count', 'unique_users', 'date', 'event']);

// Analytics endpoint constants
export const DURATION_BUCKETS = Object.freeze([
  { key: '0s',     min: 0,      max: 0 },
  { key: '1-10s',  min: 1,      max: 9999 },
  { key: '10-30s', min: 10000,  max: 29999 },
  { key: '30-60s', min: 30000,  max: 59999 },
  { key: '1-3m',   min: 60000,  max: 179999 },
  { key: '3-10m',  min: 180000, max: 599999 },
  { key: '10m+',   min: 600000, max: Infinity },
]);

export const VALID_PERIODS = Object.freeze(['1d', '7d', '14d', '30d', '90d']);
export const VALID_PAGE_TYPES = Object.freeze(['entry', 'exit', 'both']);

export const DAY_NAMES = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

// Numeric limits
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;
export const DEFAULT_DAYS = 7;
export const MS_PER_DAY = 86_400_000;
export const TOP_EVENTS_LIMIT = 20;
export const MAX_BATCH_SIZE = 100;
export const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
