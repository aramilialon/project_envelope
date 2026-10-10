/**
 * `PushManager.subscribe`'s own `applicationServerKey` wants the VAPID public key as a raw byte
 * array, not the base64url string the server hands it as (#61) — the standard conversion every
 * Web Push how-to repeats, factored out once here instead of inlined where it's used.
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}
