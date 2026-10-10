/** The Web Push opt-in endpoints (#61): `apps/api/src/routes/device-tokens.ts`'s own shapes, mirrored. */
const API_URL: string = import.meta.env.VITE_API_URL;

function authHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
}

export async function getPushPublicKey(accessToken: string): Promise<string> {
  const response = await fetch(`${API_URL}/me/push-public-key`, { headers: authHeaders(accessToken) });
  if (!response.ok) {
    throw new Error(`GET /me/push-public-key failed: ${response.status}`);
  }
  const body = (await response.json()) as { publicKey: string };
  return body.publicKey;
}

export async function registerDeviceToken(accessToken: string, token: string): Promise<void> {
  const response = await fetch(`${API_URL}/me/device-tokens`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "web", token }),
  });
  if (!response.ok) {
    throw new Error(`POST /me/device-tokens failed: ${response.status}`);
  }
}

export async function removeDeviceToken(accessToken: string, token: string): Promise<void> {
  const response = await fetch(`${API_URL}/me/device-tokens`, {
    method: "DELETE",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "web", token }),
  });
  if (!response.ok) {
    throw new Error(`DELETE /me/device-tokens failed: ${response.status}`);
  }
}
