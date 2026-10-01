/**
 * Application error model. Every error that reaches the client is mapped to a
 * stable machine-readable `code`; messages are localized from the catalog in
 * `i18n.ts`. Internal details (stack traces, SQL, provider payloads) are never
 * serialized to the client.
 */
export type ErrorCode =
  | 'bad_request'
  | 'validation_error'
  | 'unauthenticated'
  | 'forbidden'
  | 'csrf_failed'
  | 'not_found'
  | 'conflict'
  | 'idempotency_conflict'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'entitlement_required'
  | 'input_too_long'
  | 'empty_input'
  | 'feature_disabled'
  | 'account_inactive'
  | 'organization_suspended'
  | 'reauthentication_required'
  | 'invalid_credentials'
  | 'invalid_token'
  | 'email_not_verified'
  | 'registration_closed'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'invalid_signature'
  | 'provider_not_configured'
  | 'provider_error'
  | 'queue_unavailable'
  | 'job_not_ready'
  | 'job_not_cancellable'
  | 'service_unavailable'
  | 'internal_error';

export type ErrorClass = 'client' | 'auth' | 'limit' | 'dependency' | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_error: 422,
  unauthenticated: 401,
  forbidden: 403,
  csrf_failed: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  rate_limited: 429,
  quota_exceeded: 429,
  entitlement_required: 403,
  input_too_long: 413,
  empty_input: 422,
  feature_disabled: 403,
  account_inactive: 403,
  organization_suspended: 403,
  reauthentication_required: 401,
  invalid_credentials: 401,
  invalid_token: 400,
  email_not_verified: 403,
  registration_closed: 403,
  payload_too_large: 413,
  unsupported_media_type: 415,
  invalid_signature: 400,
  provider_not_configured: 501,
  provider_error: 502,
  queue_unavailable: 503,
  job_not_ready: 409,
  job_not_cancellable: 409,
  service_unavailable: 503,
  internal_error: 500,
};

export function classifyError(code: ErrorCode): ErrorClass {
  switch (code) {
    case 'unauthenticated':
    case 'forbidden':
    case 'csrf_failed':
    case 'invalid_credentials':
    case 'reauthentication_required':
    case 'account_inactive':
      return 'auth';
    case 'rate_limited':
    case 'quota_exceeded':
    case 'entitlement_required':
      return 'limit';
    case 'provider_error':
    case 'provider_not_configured':
    case 'queue_unavailable':
    case 'service_unavailable':
      return 'dependency';
    case 'internal_error':
      return 'internal';
    default:
      return 'client';
  }
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(
    code: ErrorCode,
    options: { details?: Record<string, unknown>; headers?: Record<string, string>; message?: string } = {},
  ) {
    // The message is for server-side diagnostics only and must not contain user content.
    super(options.message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = options.details;
    this.headers = options.headers;
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
