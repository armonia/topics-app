/** Public installation identity and host transport proof. */

export const INTESTAZIONE_PROVA_HOST = "x-topics-agent-proof";
export const PROVA_HOST_VALIDITA_MS = 60_000;
/** A host clock ahead of the Worker's: NTP keeps a Mac within a second, a laptop waking up within a few. */
export const PROVA_HOST_ANTICIPO_MS = 30_000;
export const LUNGHEZZA_RELAY_ID = 24;
export const FORMA_RELAY_ID = /^[A-Za-z0-9_-]{8,64}$/;

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function daBase64url(value: string): Uint8Array {
  const normalizzato = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(normalizzato), (char) => char.charCodeAt(0));
}

function sorgente(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function datiProva(relayId: string, timestamp: number): Uint8Array {
  return new TextEncoder().encode(`topics-agent-proof-v1\n${relayId}\n${timestamp}`);
}

/** Generates a local private key and a relay ID derived from its public key. */
export async function creaIdentitaRelay(): Promise<{ relayId: string; segreto: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  );
  const privata = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const pubblica = await crypto.subtle.exportKey("spki", pair.publicKey);
  const digest = await crypto.subtle.digest("SHA-256", sorgente(new Uint8Array(pubblica)));
  return {
    relayId: base64url(new Uint8Array(digest)).slice(0, LUNGHEZZA_RELAY_ID),
    segreto: base64url(new Uint8Array(privata)),
  };
}

/** Signs the request without sending the private key to the Worker. */
export async function creaProvaHost(segreto: string, relayId: string, timestamp = Date.now()): Promise<string> {
  const privata = await crypto.subtle.importKey(
    "pkcs8", sorgente(daBase64url(segreto)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const publicKey = await estraePubblica(segreto);
  const firma = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, privata, sorgente(datiProva(relayId, timestamp)),
  );
  return `${timestamp}.${base64url(publicKey)}.${base64url(new Uint8Array(firma))}`;
}

async function estraePubblica(segreto: string): Promise<Uint8Array> {
  const privata = await crypto.subtle.importKey(
    "pkcs8", sorgente(daBase64url(segreto)), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", privata);
  if (!jwk.x || !jwk.y) throw new Error("Host key has no public component");
  const pubblica = await crypto.subtle.importKey(
    "jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"],
  );
  return new Uint8Array(await crypto.subtle.exportKey("spki", pubblica));
}

/** Verifies identity, signature, and expiry before routing the host to its Durable Object. */
export async function verificaProvaHost(
  prova: string | null | undefined,
  relayId: string,
  now = Date.now(),
): Promise<boolean> {
  if (typeof prova !== "string") return false;
  const parti = /^(0|[1-9][0-9]{0,15})\.([A-Za-z0-9_-]{100,200})\.([A-Za-z0-9_-]{80,100})$/.exec(prova);
  if (!parti || !FORMA_RELAY_ID.test(relayId)) return false;
  const timestamp = Number(parti[1]);
  if (!Number.isSafeInteger(timestamp) || timestamp > now + PROVA_HOST_ANTICIPO_MS || now - timestamp > PROVA_HOST_VALIDITA_MS) return false;

  try {
    const pubblica = daBase64url(parti[2]!);
    const digest = await crypto.subtle.digest("SHA-256", sorgente(pubblica));
    if (base64url(new Uint8Array(digest)).slice(0, LUNGHEZZA_RELAY_ID) !== relayId) return false;
    const key = await crypto.subtle.importKey(
      "spki", sorgente(pubblica), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    return await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, key, sorgente(daBase64url(parti[3]!)), sorgente(datiProva(relayId, timestamp)),
    );
  } catch {
    return false;
  }
}
