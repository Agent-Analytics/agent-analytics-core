/**
 * Structured error types for machine-readable API responses.
 */

export const ERROR_CODES = Object.freeze({
  AUTH_REQUIRED:      'AUTH_REQUIRED',
  FORBIDDEN:          'FORBIDDEN',
  NOT_FOUND:          'NOT_FOUND',
  PROJECT_REQUIRED:   'PROJECT_REQUIRED',
  MISSING_FIELDS:     'MISSING_FIELDS',
  INVALID_BODY:       'INVALID_BODY',
  BATCH_TOO_LARGE:    'BATCH_TOO_LARGE',
  INVALID_METRIC:     'INVALID_METRIC',
  INVALID_GROUP_BY:   'INVALID_GROUP_BY',
  INVALID_FILTER_OP:  'INVALID_FILTER_OP',
  INVALID_PROPERTY_KEY: 'INVALID_PROPERTY_KEY',
  QUERY_FAILED:       'QUERY_FAILED',
  INTERNAL_ERROR:     'INTERNAL_ERROR',
});

export class AnalyticsError extends Error {
  /**
   * @param {string} code  - Machine-readable error code from ERROR_CODES
   * @param {string} message - Human-readable explanation
   * @param {number} status  - HTTP status code
   */
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function errorResponse(code, message) {
  return { error: code, message };
}
