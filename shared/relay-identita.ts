/**
 * The machine's name on the relay, and the proof that it is the machine.
 *
 * The name is a digest of the public half of a signing key the machine generates and keeps. The
 * private half never leaves it: on `/agent/:id` the machine sends a signature over the name and the
 * current time, and the Worker checks that the key digests to the name, that the signature holds and
 * that the time is recent. A captured proof stops working after `HOST_PROOF_TTL_MS`.
 *
 * Both sides import the formats from here: the machine signs with `node:crypto` (its connect loop is
 * synchronous), the Worker verifies with WebCrypto. Two copies of the payload would one day disagree,
 * and that day the machine stops attaching (RELAY-E2E-12).
 */

export const HOST_PROOF_HEADER = "x-topics-agent-proof";
export const HOST_PROOF_TTL_MS = 60_000;
/** A host clock ahead of the Worker's: NTP keeps a Mac within a second, a laptop waking up within a few. */
export const HOST_PROOF_MAX_SKEW_MS = 30_000;
export const LUNGHEZZA_RELAY_ID = 24;
export const FORMA_RELAY_ID = /^[A-Za-z0-9_-]{8,64}$/;

const SIGNING_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function daBase64url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

/** The name a public key answers to, from the SHA-256 of its SPKI encoding. */
export function relayIdFromDigest(sha256: Uint8Array): string {
  return base64url(sha256).slice(0, LUNGHEZZA_RELAY_ID);
}

/** What the host signs: bound to one name and one instant. */
export function hostProofPayload(relayId: string, timestamp: number): Uint8Array {
  return new TextEncoder().encode(`topics-agent-proof-v1\n${relayId}\n${timestamp}`);
}

/** The header value: when, which public key, and the signature over `hostProofPayload`. */
export function encodeHostProof(timestamp: number, publicKeyBytes: Uint8Array, signature: Uint8Array): string {
  return `${timestamp}.${base64url(publicKeyBytes)}.${base64url(signature)}`;
}

/** Generates a local private key and a relay ID derived from its public key. */
export async function createRelayIdentity(): Promise<{ relayId: string; segreto: string }> {
  const pair = await crypto.subtle.generateKey(SIGNING_ALGORITHM, true, ["sign", "verify"]);
  const privateKeyBytes = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const publicKeyBytes = await crypto.subtle.exportKey("spki", pair.publicKey);
  return {
    relayId: relayIdFromDigest(new Uint8Array(await crypto.subtle.digest("SHA-256", publicKeyBytes))),
    segreto: base64url(new Uint8Array(privateKeyBytes)),
  };
}

/** Signs a proof with WebCrypto. The tests use it to play the host; the machine uses the sync twin in `relay-client.ts`. */
export async function createHostProof(segreto: string, relayId: string, timestamp = Date.now()): Promise<string> {
  const privateKeyBytes = toArrayBuffer(daBase64url(segreto));
  const signingKey = await crypto.subtle.importKey("pkcs8", privateKeyBytes, SIGNING_ALGORITHM, true, ["sign"]);
  // WebCrypto has no "public key of this private key": the JWK export carries the point.
  const { x, y } = await crypto.subtle.exportKey("jwk", signingKey);
  if (!x || !y) throw new Error("Host key has no public component");
  const verifyKey = await crypto.subtle.importKey(
    "jwk", { kty: "EC", crv: "P-256", x, y, ext: true }, SIGNING_ALGORITHM, true, ["verify"],
  );
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("spki", verifyKey));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, signingKey, toArrayBuffer(hostProofPayload(relayId, timestamp)),
  );
  return encodeHostProof(timestamp, publicKeyBytes, new Uint8Array(signature));
}

/** Verifies identity, signature, and expiry before routing the host to its Durable Object. */
export async function verifyHostProof(
  proof: string | null | undefined,
  relayId: string,
  now = Date.now(),
): Promise<boolean> {
  if (typeof proof !== "string") return false;
  const parts = /^(0|[1-9][0-9]{0,15})\.([A-Za-z0-9_-]{100,200})\.([A-Za-z0-9_-]{80,100})$/.exec(proof);
  if (!parts || !FORMA_RELAY_ID.test(relayId)) return false;
  const timestamp = Number(parts[1]);
  if (!Number.isSafeInteger(timestamp) || timestamp > now + HOST_PROOF_MAX_SKEW_MS || now - timestamp > HOST_PROOF_TTL_MS) return false;

  try {
    const publicKeyBytes = daBase64url(parts[2]!);
    const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(publicKeyBytes));
    if (relayIdFromDigest(new Uint8Array(digest)) !== relayId) return false;
    const key = await crypto.subtle.importKey("spki", toArrayBuffer(publicKeyBytes), SIGNING_ALGORITHM, false, ["verify"]);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, toArrayBuffer(daBase64url(parts[3]!)),
      toArrayBuffer(hostProofPayload(relayId, timestamp)),
    );
  } catch {
    return false;
  }
}
