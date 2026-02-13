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

// Numeric limits
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;
export const DEFAULT_DAYS = 7;
export const MS_PER_DAY = 86_400_000;
export const TOP_EVENTS_LIMIT = 20;
export const MAX_BATCH_SIZE = 100;
export const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
