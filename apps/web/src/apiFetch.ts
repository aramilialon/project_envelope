const API_URL: string = import.meta.env.VITE_API_URL;

/** The bearer token header every endpoint needs, plus `Content-Type` once a JSON body is sent. */
export function authHeaders(accessToken: string, hasBody = false): HeadersInit {
  return hasBody ? { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } : { Authorization: `Bearer ${accessToken}` };
}

/**
 * A non-ok response from `apiFetch`. `code` and `details` are the API's own stable error code and
 * its values when the body carries them (a 400 from a `ValidationError`, such as `text_too_long`
 * with `{ field, max }`, #507), so a form can say what was wrong in the user's language; both are
 * absent for any other body.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(message: string, status: number, code: string | undefined, details: Record<string, string | number>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function errorBody(response: Response): Promise<{ code: string | undefined; details: Record<string, string | number> }> {
  try {
    const body = (await response.json()) as { error?: unknown; details?: unknown };
    const details = typeof body.details === "object" && body.details !== null ? (body.details as Record<string, string | number>) : {};
    return { code: typeof body.error === "string" ? body.error : undefined, details };
  } catch {
    return { code: undefined, details: {} };
  }
}

/**
 * fetch against the API with the bearer token attached, throwing an `ApiError` with the same
 * "METHOD path failed: status" message every api.ts module's own fetch call already built by
 * hand on a non-ok response. Returns the raw `Response` — callers still parse/unwrap the JSON body themselves,
 * since each endpoint's own response shape differs, and a `void`-returning call simply never
 * does. An endpoint whose own meaning for a particular status (a 404 meaning "none set yet", a
 * 409 meaning "already reconciled, unlock first") is not a real error inspects `response.status`
 * on a plain `fetch` call instead, since this throws before it would get the chance.
 */
export async function apiFetch(accessToken: string, method: string, path: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: authHeaders(accessToken, body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const { code, details } = await errorBody(response);
    // A 429's wait is in the body (#566); `Retry-After` is the fallback when a body lacks it
    // (the header is only readable when the response is same-origin or CORS exposes it).
    const retryAfter = Number(response.headers.get("Retry-After"));
    if (response.status === 429 && details.retryAfterSeconds === undefined && Number.isInteger(retryAfter) && retryAfter > 0) {
      details.retryAfterSeconds = retryAfter;
    }
    throw new ApiError(`${method} ${path} failed: ${response.status}`, response.status, code, details);
  }
  return response;
}
