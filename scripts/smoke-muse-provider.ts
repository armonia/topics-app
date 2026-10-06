/**
 * BAR-5 smoke: one live MuseProvider turn against the real meta backend.
 *
 * Usage: bun run scripts/smoke-muse-provider.ts ["rispondi con esattamente: dattero"]
 *
 * Asserts: text deltas arrive, onDone carries the expected word, the muse
 * session id is persisted in `muse_sessions`, and a second turn on the same
 * session key reuses that sid WITHOUT resending history (the CLI resumes its
 * native context, so the model still knows the previous word). Costs 2 meta
 * calls. Never in CI.
 *
 * The database is a throwaway in a temp dir (same setup as
 * `server/providers/muse-integration.test.ts`); the only real things touched
 * are the muse CLI session log and the meta backend.
 */
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../server/db";
import { MuseProvider } from "../server/providers/muse";
import type { StreamHandler, ProviderDoneMessage } from "../server/providers/types";

const TURN_TIMEOUT_MS = 180_000;

const prompt = process.argv[2] ?? "rispondi con esattamente: dattero";
const EXPECTED = "dattero";

function fail(msg: string): never {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

function timed<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${TURN_TIMEOUT_MS}ms`)), TURN_TIMEOUT_MS);
    t.unref?.();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

interface Recording {
  handler: StreamHandler;
  deltas: string[];
  errors: string[];
  done: Promise<ProviderDoneMessage | undefined>;
}

function recorder(): Recording {
  const deltas: string[] = [];
  const errors: string[] = [];
  let resolveDone!: (m: ProviderDoneMessage | undefined) => void;
  const done = new Promise<ProviderDoneMessage | undefined>((r) => { resolveDone = r; });
  const handler: StreamHandler = {
    onTextDelta: (text) => { deltas.push(text); },
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: (m) => resolveDone(m),
    onError: (e) => { errors.push(e); resolveDone(undefined); },
  };
  return { handler, deltas, errors, done };
}

function storedSid(sessionKey: string): string | null {
  const row = getDatabase()
    .prepare(`SELECT muse_session_id FROM muse_sessions WHERE session_key = ?`)
    .get(sessionKey) as { muse_session_id?: string } | null;
  return row?.muse_session_id ?? null;
}

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "topics-smoke-muse-")));
initDatabase(join(import.meta.dir, ".."), tempRoot);
const sessionKey = `topic:smoke-muse-${Date.now()}`;
const now = new Date().toISOString();
getDatabase().prepare(`INSERT INTO topics
  (id, name, slug, session_key, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)`).run(sessionKey, "Smoke", sessionKey, sessionKey, now, now);

const provider = new MuseProvider({ type: "muse", defaultWorkspace: tempRoot });
provider.start();

try {
  // Turn 1: fresh session, prompt from argv.
  const first = recorder();
  await provider.sendChat(sessionKey, prompt, first.handler);
  const firstDone = await timed(first.done, "turn 1 onDone");
  if (first.errors.length > 0) fail(`turn 1 onError: ${first.errors.join("; ")}`);
  if (first.deltas.length === 0) fail("turn 1 produced no text deltas");
  const firstText = firstDone?.result ?? first.deltas.join("");
  if (!firstText.toLowerCase().includes(EXPECTED)) {
    fail(`turn 1 answer does not contain "${EXPECTED}": ${JSON.stringify(firstText.slice(0, 200))}`);
  }
  const sid = storedSid(sessionKey);
  if (!sid) fail("turn 1 stored no sid in muse_sessions");
  console.log(`turn 1 ok: ${first.deltas.length} deltas, onDone contains "${EXPECTED}", sid=${sid}`);

  // Turn 2: same session key, NO history passed — the resumed CLI session
  // must still know the previous word from its native context.
  const second = recorder();
  await provider.sendChat(
    sessionKey,
    "ripeti esattamente la parola che hai appena scritto, solo quella, niente altro",
    second.handler,
  );
  const secondDone = await timed(second.done, "turn 2 onDone");
  if (second.errors.length > 0) fail(`turn 2 onError: ${second.errors.join("; ")}`);
  const sid2 = storedSid(sessionKey);
  if (sid2 !== sid) fail(`turn 2 changed sid: ${sid} -> ${sid2}`);
  const secondText = secondDone?.result ?? second.deltas.join("");
  if (!secondText.toLowerCase().includes(EXPECTED)) {
    fail(`turn 2 forgot the word (resume broken?): ${JSON.stringify(secondText.slice(0, 200))}`);
  }
  console.log(`turn 2 ok: same sid reused, no history sent, model recalled "${EXPECTED}"`);

  console.log("SMOKE PASS: muse provider live turn + resume");
} finally {
  provider.stop();
  closeDatabase();
  rmSync(tempRoot, { recursive: true, force: true });
}
