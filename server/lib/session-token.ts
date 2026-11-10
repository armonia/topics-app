/**
 * WHO IS REALLY CALLING `/api/sessions/:sessionKey/...`.
 *
 * The session key in the URL says which session a request is ABOUT, not which
 * one sent it. The loopback owns the server without credentials, and the
 * daemon token opens every gated route for every bridge alike, so the shell of
 * one agent could post a comment signed `agent:<another topic>` just by putting
 * that topic's key in the path (card cedadfc6). The session token is the proof
 * that binds a caller to ONE session.
 *
 * What it is: HMAC-SHA256 of the session key under a signing key that lives in
 * `<topics home>/session-signing.key`. That key is created once and never
 * rotated at boot. This is the difference with the daemon token, which
 * `writeState` regenerates at every start: a token derived from that one turned
 * every live bridge into a 403 after a restart.
 *
 * How it travels: the server writes it into a 0600 file named after a hash of
 * the session key, when it builds the bridge for that session, and the bridge
 * reads it on every request. Not argv, where `ps` prints it.
 *
 * What it does NOT do: confine a process running as this machine's user. That
 * process can read the files of every session, as it can read the daemon token.
 * The token makes the honest path name the right session and turns a key
 * copied from somewhere else into a refusal, which is what a forged signature
 * needs to stop being one keystroke away.
 *
 * This module only imports `node:` built-ins on purpose: the bridge subprocess
 * reads the file through it, and must not pull the server in.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The request header that carries the proof. */
export const SESSION_TOKEN_HEADER = "X-Topics-Session-Token";

const SIGNING_KEY_FILE = "session-signing.key";
const TOKEN_DIR = "session-tokens";
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Signing keys already read, by home. A restart empties it, the file stays. */
const signingKeys = new Map<string, Buffer>();

/** Forget the cached signing keys, which is what a server restart does. */
export function resetSessionSigningCache(): void {
  signingKeys.clear();
}

function signingKey(home: string): Buffer {
  const cached = signingKeys.get(home);
  if (cached) return cached;
  const path = join(home, SIGNING_KEY_FILE);
  let hex = "";
  try { hex = readFileSync(path, "utf-8").trim(); } catch { /* first use: created below */ }
  if (!TOKEN_RE.test(hex)) {
    mkdirSync(home, { recursive: true });
    hex = randomBytes(32).toString("hex");
    // `wx` so two servers racing on the same home keep ONE key: the loser
    // reads the winner's file instead of overwriting it.
    try {
      writeFileSync(path, hex, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    } catch {
      const winner = readFileSync(path, "utf-8").trim();
      if (!TOKEN_RE.test(winner)) {
        writeFileSync(path, hex, { encoding: "utf-8", mode: 0o600 });
      } else {
        hex = winner;
      }
    }
    try { chmodSync(path, 0o600); } catch { /* best-effort on Windows */ }
  }
  const key = Buffer.from(hex, "hex");
  signingKeys.set(home, key);
  return key;
}

/** The token of one session. Stable across restarts while the key file stays. */
export function mintSessionToken(home: string, sessionKey: string): string {
  return createHmac("sha256", signingKey(home)).update(sessionKey, "utf-8").digest("hex");
}

/** Where the bridge of `sessionKey` finds its token. The key is hashed: it may hold any character. */
export function sessionTokenPath(home: string, sessionKey: string): string {
  const name = createHash("sha256").update(sessionKey, "utf-8").digest("hex").slice(0, 32);
  return join(home, TOKEN_DIR, `${name}.token`);
}

/** Server side: mint the token of a session and leave it where its bridge reads it. */
export function issueSessionTokenFile(home: string, sessionKey: string): void {
  const dir = join(home, TOKEN_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = sessionTokenPath(home, sessionKey);
  writeFileSync(path, mintSessionToken(home, sessionKey), { encoding: "utf-8", mode: 0o600 });
  // `mode` only applies on create: a re-launch rewrites the same path.
  try { chmodSync(path, 0o600); } catch { /* best-effort on Windows */ }
}

/** Bridge side: the token of this session, or undefined when none was issued. */
export function readSessionToken(home: string, sessionKey: string): string | undefined {
  try {
    const token = readFileSync(sessionTokenPath(home, sessionKey), "utf-8").trim();
    return TOKEN_RE.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a request proves about `sessionKey`.
 *  - `valid`: it carries this session's token, so it speaks AS this session.
 *  - `invalid`: it carries a token, and not this session's one.
 *  - `absent`: it proves nothing, so it speaks as an anonymous agent.
 */
export type SessionProof = "valid" | "invalid" | "absent";

export function sessionProof(req: Request, home: string, sessionKey: string): SessionProof {
  const presented = req.headers.get(SESSION_TOKEN_HEADER)?.trim() ?? "";
  if (!presented) return "absent";
  if (!TOKEN_RE.test(presented)) return "invalid";
  const expected = Buffer.from(mintSessionToken(home, sessionKey), "hex");
  return timingSafeEqual(Buffer.from(presented, "hex"), expected) ? "valid" : "invalid";
}
