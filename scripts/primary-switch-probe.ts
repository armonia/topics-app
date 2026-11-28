#!/usr/bin/env bun
/**
 * The bar of track T4 on a COPY of a real DB, never the live one:
 *
 *   bun scripts/primary-switch-probe.ts --db <copy of a topics.db> [--projects <CLI projects dir>] [--model <model>] [--no-cli]
 *
 * The copy must be a single file (`sqlite3 <live> ".backup '<copy>'"`, then
 * `PRAGMA journal_mode=DELETE` on the copy alone): it is opened read-only and
 * copied with `VACUUM INTO` into a temp folder, where the REAL `initDatabase`
 * opens it as the old primary. The old primary and the new one are two temp
 * folders in this process, the transport is the receiver's own staging code.
 * It checks:
 *
 *  - row counts of tasks, messages and topics equal before and after, and a
 *    message written during the drain is in the new DB;
 *  - the fence is the real one (`setPrimaryFence`, which turns the live handle
 *    `query_only`): a write attempted on the old DB afterwards is refused with
 *    SQLITE_READONLY and changes nothing, and the front door answers 409
 *    `primary_moved` to a write over a real HTTP request (a listener on a free
 *    loopback port, the real access gate and `gatedRefusal` wired the way
 *    `server/routes/front-door.ts` wires them) while a read goes through;
 *  - after the old primary restarts, its DB is set aside, no file exists at the
 *    live DB path (nothing for a replica to publish), and it still refuses;
 *  - a session is resumed on the new side with its context, the way Topics
 *    resumes one (`claude -p --resume <sessionId>` run with the project folder as
 *    cwd, `server/providers/claude/args.ts`): the REAL `claude -p` (the cheapest
 *    non-Haiku model, `sonnet`) memorizes a random word in a temp project, the
 *    switch ships its transcript, the origin copy is deleted, a resume by id
 *    without the shipped copy fails, then the receiver's own restore puts the
 *    transcript back under the CLI projects folder, where the CLI looks for it,
 *    and the resume by id answers with the word. Without `claude` in PATH, or with
 *    `--no-cli`, it falls back to Topics' own reader (find the transcript by id,
 *    read its messages) and says so in `resume.mode`. The CLI's configuration
 *    and credentials are never touched; its own transcript folder gets one temp
 *    project folder that is removed at the end.
 *
 * Other transcripts are READ from `--projects` (default `~/.claude/projects`)
 * and written only under temp. Prints one JSON line; exit 0 only when every
 * check holds. Temp folders go.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase, initDatabase, isFencedWriteError } from "../server/db";
import { createAccessGate } from "../server/routes/access-gate";
import { RETIRED_DB_NAME } from "../server/lib/data-dir";
import { createPrimaryRole } from "../server/lib/primary-role";
import { bootPrimaryChange, gatedRefusal, setPrimaryFence } from "../server/lib/primary-fence";
import { localReceiver } from "../server/lib/primary-switch-test-support";
import {
  applyPendingPrimaryChange, collectTranscripts, commitIncoming, countRows, DB_NAME, MOVED_CODE,
  snapshotDatabase, writeIncomingChunk,
} from "../server/lib/primary-switch";
import { cliTranscriptSummary, findCliTranscript } from "../server/lib/subagent-migration";
import { runPrimarySwitch } from "../server/services/primary-switch-run";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const source = arg("--db");
const projectsDir = arg("--projects") ?? join(homedir(), ".claude", "projects");
const model = arg("--model") ?? "sonnet";
if (!source) {
  console.error("usage: bun scripts/primary-switch-probe.ts --db <copy of a topics.db> [--projects <dir>] [--model <model>] [--no-cli]");
  process.exit(64);
}

const root = mkdtempSync(join(tmpdir(), "primary-switch-probe-"));
const side = (label: string) => {
  const stateDir = join(root, label, "state");
  const appDataDir = join(root, label, "app-data");
  mkdirSync(join(stateDir, "data"), { recursive: true });
  mkdirSync(appDataDir, { recursive: true });
  return { stateDir, appDataDir, secretsDir: join(stateDir, ".topics-secrets"), dbPath: join(stateDir, "data", DB_NAME) };
};
const old = side("old");
const receiver = { ...side("new"), projectsDir: join(root, "new", "claude-projects") };
const checks: Record<string, boolean> = {};
const t0 = Date.now();
const repoRoot = join(import.meta.dir, "..");

/** A copy of the newest message under a fresh id: a real write with the real schema. */
function writeOneMessage(db: Database): string {
  const cols = db.query("PRAGMA table_info(messages)").all() as Array<{ name: string; type: string; pk: number }>;
  const pk = cols.find((c) => c.pk === 1);
  const marker = `probe-${randomUUID()}`;
  const names = cols.map((c) => c.name);
  const select = cols.map((c) => (c === pk ? (/INT/i.test(c.type) ? "NULL" : `'${marker}'`) : c.name)).join(", ");
  db.query(`INSERT INTO messages (${names.join(", ")}) SELECT ${select} FROM messages ORDER BY rowid DESC LIMIT 1`).run();
  return String((db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

/** The CLI keeps a project's transcripts in a folder named after its path. */
const cliProjectFolder = (cwd: string) => join(projectsDir, realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-"));

/** One `claude -p` call, no configuration of ours: the login and settings are the ones the CLI already has. */
async function claude(cwd: string, args: string[]): Promise<{ exitCode: number; result: string; sessionId: string | null }> {
  const proc = Bun.spawn(["claude", "-p", "--model", model, "--output-format", "json", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  try {
    const parsed = JSON.parse(out) as { result?: string; session_id?: string };
    return { exitCode, result: parsed.result ?? "", sessionId: parsed.session_id ?? null };
  } catch {
    return { exitCode, result: `${out}${err}`.trim(), sessionId: null };
  }
}

/**
 * One request through the real door: a listener on a free loopback port whose handler is the
 * access gate and `gatedRefusal` wired as `server/routes/front-door.ts` wires them. `through` is
 * what a request the door lets pass gets; a refusal is the door's own answer.
 */
async function askDoor(method: string, pathname: string): Promise<{ status: number; body: { code?: string } | null }> {
  const gate = createAccessGate({ corsAllowOrigin: () => "", ctx: { db: getDatabase() } as never, identityByRequest: new WeakMap() });
  const door = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, server) => {
      const url = new URL(req.url);
      const refused = gatedRefusal(() => gate(req, server as never, url.pathname, req.method, url.pathname.startsWith("/api/")) ?? null, url.pathname, req.method);
      return refused ?? new Response(JSON.stringify({ code: "through" }), { headers: { "content-type": "application/json" } });
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${door.port}${pathname}`, { method });
    return { status: res.status, body: (await res.json().catch(() => null)) as { code?: string } | null };
  } finally {
    door.stop(true);
  }
}

const useCli = !process.argv.includes("--no-cli") && Bun.which("claude") !== null;
const word = `kiwi-${randomUUID().slice(0, 8)}`;
const projectCwd = join(root, "project");
mkdirSync(projectCwd, { recursive: true });
let cliFolder = null as string | null;

/** The session the switch will carry: made by the real CLI, or a transcript the reader can open. */
async function makeSession(): Promise<string> {
  if (useCli) {
    const made = await claude(projectCwd, [`Remember this secret word: ${word}. Reply only OK.`]);
    if (made.exitCode !== 0 || !made.sessionId) throw new Error(`claude could not make the session: ${made.result.slice(0, 300)}`);
    cliFolder = cliProjectFolder(projectCwd);
    return made.sessionId;
  }
  const id = randomUUID();
  cliFolder = cliProjectFolder(projectCwd);
  mkdirSync(cliFolder, { recursive: true });
  const line = { type: "user", message: { role: "user", content: `Remember this secret word: ${word}.` } };
  writeFileSync(join(cliFolder, `${id}.jsonl`), `${JSON.stringify(line)}\n`);
  return id;
}

try {
  const live = new Database(source, { readonly: true });
  const copied = snapshotDatabase(live, old.dbPath);
  live.close();
  // The old primary is the REAL database layer on the copy: the fence below goes through its functions.
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dirname(old.dbPath);
  initDatabase(repoRoot, old.stateDir);
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  const db = getDatabase();
  checks.copyMatchesSource = JSON.stringify(countRows(db)) === JSON.stringify(copied);

  // A topic with a real session, linked the way the app links it.
  const sessionId = await makeSession();
  const stamp = new Date().toISOString();
  const sessionKey = `probe-${randomUUID()}`;
  db.run("INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?, 'probe session', ?, ?, ?, ?)", [randomUUID(), sessionKey, sessionKey, stamp, stamp]);
  db.run("INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?)", [sessionKey, sessionId, stamp, stamp]);
  const before = countRows(db);

  const local = (db.query("SELECT id FROM machines WHERE hostname = ?").get(hostname()) as { id: string } | null)?.id ?? "probe-old";
  const role = createPrimaryRole({ db, stateFile: join(old.appDataDir, "primary-state.json"), localMachineId: () => local, log: () => {} });
  role.adopt({ primaryMachineId: local, epoch: role.epoch() + 1 });
  const transcripts = collectTranscripts(db, projectsDir);
  let busy = true;
  let drainRow = "";
  // The origin copy of the session goes BEFORE the receiver restores: only what the switch shipped can answer.
  let originBytes: Buffer | null = null;
  const resume: { mode: "cli" | "reader"; model?: string; answer: string; withoutCopyRefused?: boolean } = { mode: useCli ? "cli" : "reader", answer: "" };
  const dropOriginCopy = async () => {
    const origin = findCliTranscript(sessionId, projectsDir);
    originBytes = origin ? readFileSync(origin) : null;
    if (cliFolder) rmSync(cliFolder, { recursive: true, force: true });
    checks.originGone = findCliTranscript(sessionId, projectsDir) === null;
    if (useCli) {
      const without = await claude(projectCwd, ["--resume", sessionId, "What was the secret word?"]);
      resume.withoutCopyRefused = without.exitCode !== 0 && !without.result.includes(word);
      checks.resumeNeedsTheShippedCopy = resume.withoutCopyRefused;
    }
  };
  const report = await runPrimarySwitch({
    db, stateDir: old.stateDir, secretsDir: old.secretsDir, appDataDir: old.appDataDir, projectsDir, role, localMachineId: local,
    target: { id: "probe-new", hostname: "probe-new-host", name: "probe" },
    drain: () => {}, undrain: () => {},
    stillWorking: () => {
      if (busy) { drainRow = writeOneMessage(db); busy = false; return [{ taskId: "probe", sessionKey: "probe" }]; }
      return [];
    },
    park: async () => {},
    setFence: setPrimaryFence,
    upload: async (name, offset, bytes) => { writeIncomingChunk(receiver.stateDir, name, offset, bytes); },
    // The receiver's own commit and boot restore, onto the CLI projects folder: the transcript lands where the CLI looks for it.
    ...localReceiver({ ...receiver, projectsDir }, {
      hostname: "probe-new-host",
      beforeBoot: dropOriginCopy,
      onBoot: (outcome) => { checks.restored = outcome === "restored"; },
    }),
    restartSelf: () => {}, sleep: async () => {}, pollMs: 0, log: () => {},
  });
  checks.switched = report.outcome === "switched";
  checks.sessionTranscriptShipped = transcripts.some((t) => t.name.endsWith(`${sessionId}.jsonl`));
  const restored = new Database(receiver.dbPath, { readonly: true });
  const after = countRows(restored);
  checks.countsEqual = after.tasks === before.tasks && after.topics === before.topics && after.messages === before.messages + 1;
  checks.drainWritePresent = restored.query("SELECT 1 FROM messages WHERE rowid = ?").get(drainRow) !== null;
  restored.close();

  // The old one now: the fence is up on the real handle, so a real write is refused by SQLite itself.
  let writeError: unknown = null;
  try { writeOneMessage(db); } catch (err) { writeError = err; }
  checks.oldWriteRefusedByDb = isFencedWriteError(writeError) && countRows(db).messages === before.messages + 1;
  const write = await askDoor("POST", "/api/tasks");
  checks.oldWriteRefusedByDoor = write.status === 409 && write.body?.code === MOVED_CODE;
  const read = await askDoor("GET", "/api/topics");
  checks.oldReadGoesThroughDoor = read.status === 200 && read.body?.code === "through";
  checks.oldIsNotPrimary = !role.isPrimary();

  // The old one restarts: the boot alone sets its DB aside; it opens a service DB, never a file at the live path.
  closeDatabase();
  bootPrimaryChange("", { ...old, projectsDir });
  checks.oldSetAside = existsSync(`${old.dbPath}.prima-${report.epoch}`) && !existsSync(old.dbPath);
  process.env.DATA_DIR = dirname(old.dbPath);
  initDatabase(repoRoot, old.stateDir);
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  checks.oldLivePathStaysEmpty = !existsSync(old.dbPath) && existsSync(join(dirname(old.dbPath), RETIRED_DB_NAME));
  checks.oldRefusesAfterRestart = (await askDoor("POST", "/api/tasks")).status === 409;
  closeDatabase();
  setPrimaryFence(null);

  // The session on the new side, resumed by id with the project folder as cwd, the way Topics does.
  const shipped = findCliTranscript(sessionId, projectsDir);
  checks.transcriptRestored = !!originBytes && !!shipped && readFileSync(shipped).equals(originBytes);
  if (useCli && shipped) {
    const answered = await claude(projectCwd, ["--resume", sessionId, "What was the secret word? Answer with the word only."]);
    resume.model = model;
    resume.answer = answered.result;
    checks.sessionResumedWithItsContext = answered.exitCode === 0 && answered.result.toLowerCase().includes(word);
  } else if (shipped) {
    resume.answer = cliTranscriptSummary(readFileSync(shipped, "utf-8")).task ?? "";
    checks.sessionResumedWithItsContext = resume.answer.includes(word);
  } else {
    checks.sessionResumedWithItsContext = false;
  }
  const ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ ok, checks, switch: { outcome: report.outcome, step: report.step, error: report.error }, before, after, resume, transcriptFiles: transcripts.length, bytes: report.bytes, seconds: (Date.now() - t0) / 1000 }));
  writeFileSync(join(tmpdir(), "primary-switch-probe-last.json"), JSON.stringify({ ok, checks, before, after, resume }));
  process.exitCode = ok ? 0 : 1;
} finally {
  closeDatabase();
  setPrimaryFence(null);
  if (cliFolder && cliFolder.includes(root.split("/").pop()!.replace(/[^a-zA-Z0-9]/g, "-"))) rmSync(cliFolder, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
