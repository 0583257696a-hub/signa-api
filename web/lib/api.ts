/**
 * Minimal API client. The site is served from the same origin as the API, so the
 * HttpOnly session cookie is sent automatically. The CSRF token is kept in memory
 * only (never in localStorage) and re-fetched from /auth/csrf when missing.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
  }
  get code() {
    return this.body.code;
  }
}

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';
let csrfToken: string | null = null;
let currentLocale = 'he';

export const setApiLocale = (l: string) => {
  currentLocale = l;
};
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};

async function ensureCsrf(): Promise<string | null> {
  if (csrfToken) return csrfToken;
  try {
    const r = await fetch(`${BASE}/api/v1/auth/csrf`, { credentials: 'include', headers: { 'accept-language': currentLocale } });
    if (r.ok) csrfToken = ((await r.json()) as { data: { csrfToken: string } }).data.csrfToken;
  } catch {
    /* network error: request below will surface it */
  }
  return csrfToken;
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string>; orgId?: string | null } = {},
): Promise<{ data: T; meta: Record<string, unknown> }> {
  const method = opts.method ?? 'GET';
  const unsafe = method !== 'GET' && method !== 'HEAD';
  const headers: Record<string, string> = { 'accept-language': currentLocale, ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  // Pre-login endpoints don't need (and can't get) a CSRF token.
  if (unsafe && !/^\/auth\/(login|register|password\/(forgot|reset)|email\/verify)$/.test(path)) {
    const t = await ensureCsrf();
    if (t) headers['x-csrf-token'] = t;
  }
  if (opts.orgId) headers['x-organization-id'] = opts.orgId;

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/v1${path}`, {
      method,
      credentials: 'include',
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch {
    throw new ApiError(0, { code: 'network_error', message: 'network_error' });
  }

  let json: { data?: T; meta?: Record<string, unknown>; error?: ApiErrorBody } = {};
  try {
    json = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    if (json.error?.code === 'csrf_failed') csrfToken = null;
    throw new ApiError(res.status, json.error ?? { code: 'internal_error', message: 'internal_error' });
  }
  const data = json.data as T & { csrfToken?: string };
  if (data && typeof data === 'object' && 'csrfToken' in data && typeof data.csrfToken === 'string') csrfToken = data.csrfToken;
  return { data: data as T, meta: json.meta ?? {} };
}

export const newIdempotencyKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
