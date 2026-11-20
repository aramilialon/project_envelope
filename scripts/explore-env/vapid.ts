import { generateKeyPairSync } from "node:crypto";

/**
 * A fresh VAPID key pair (P-256) for one disposable environment's API, which needs one to start
 * (#39). Never used to reach a real push service: the environment has no subscribed devices.
 * The public key is the uncompressed point (0x04 || x || y), the private key the scalar, both
 * base64url, the format `web-push generate-vapid-keys` prints.
 */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  if (!pub.x || !pub.y || !priv.d) {
    throw new Error("generateVapidKeys: unexpected key export");
  }
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);
  return { publicKey: point.toString("base64url"), privateKey: priv.d };
}
