const API_URL: string = import.meta.env.VITE_API_URL;

/** The bearer token header every endpoint needs, plus `Content-Type` once a JSON body is sent. */
export function authHeaders(accessToken: string, hasBody = false): HeadersInit {
  return hasBody ? { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } : { Authorization: `Bearer ${accessToken}` };
}

/**
 * fetch against the API with the bearer token attached, throwing the same "METHOD path failed:
 * status" message every api.ts module's own fetch call already built by hand on a non-ok
 * response. Returns the raw `Response` — callers still parse/unwrap the JSON body themselves,
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
    throw new Error(`${method} ${path} failed: ${response.status}`);
  }
  return response;
}
