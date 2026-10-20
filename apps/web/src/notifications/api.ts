/** The Web Push opt-in endpoints (#61): `apps/api/src/routes/device-tokens.ts`'s own shapes, mirrored. */
import { apiFetch } from "../apiFetch.ts";

export async function getPushPublicKey(accessToken: string): Promise<string> {
  const response = await apiFetch(accessToken, "GET", "/me/push-public-key");
  const body = (await response.json()) as { publicKey: string };
  return body.publicKey;
}

export async function registerDeviceToken(accessToken: string, token: string): Promise<void> {
  await apiFetch(accessToken, "POST", "/me/device-tokens", { platform: "web", token });
}

export async function removeDeviceToken(accessToken: string, token: string): Promise<void> {
  await apiFetch(accessToken, "DELETE", "/me/device-tokens", { platform: "web", token });
}
