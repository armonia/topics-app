/**
 * Plays the host in the relay tests: signs a proof with WebCrypto only, so it runs wherever the
 * Worker does. The machine signs with the sync twin `createHostProofSync` in `server/services/relay-client.ts`.
 */
import { encodeHostProof, hostProofPayload } from "../shared/relay-identita";

const SIGNING_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;

function fromBase64url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).buffer;
}

export async function createHostProof(secret: string, relayId: string, timestamp = Date.now()): Promise<string> {
  const signingKey = await crypto.subtle.importKey("pkcs8", fromBase64url(secret), SIGNING_ALGORITHM, true, ["sign"]);
  // WebCrypto has no "public key of this private key": the JWK export carries the point.
  const { x, y } = await crypto.subtle.exportKey("jwk", signingKey);
  if (!x || !y) throw new Error("Host key has no public component");
  const verifyKey = await crypto.subtle.importKey(
    "jwk", { kty: "EC", crv: "P-256", x, y, ext: true }, SIGNING_ALGORITHM, true, ["verify"],
  );
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("spki", verifyKey));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, signingKey, Uint8Array.from(hostProofPayload(relayId, timestamp)).buffer,
  );
  return encodeHostProof(timestamp, publicKeyBytes, new Uint8Array(signature));
}
