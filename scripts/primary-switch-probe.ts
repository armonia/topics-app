#!/usr/bin/env bun
/**
 * The bar of track T4 on a COPY of a real DB, never the live one:
 *
 *   bun scripts/primary-switch-probe.ts --db <path to a topics.db> [--projects <CLI projects dir>]
 *
 * The DB is opened read-only and copied with `VACUUM INTO` into a temp folder;
 * the old primary and the new one are two temp folders in this process, the
 * transport is the receiver's own staging code. It checks: row counts of
 * tasks, messages and topics equal before and after; a message written during
 * the drain is in the new DB; the old one refuses writes and sets its DB aside;
 * a topic session's transcript is found by id on the new side with the same
 * bytes. Transcripts are READ from `--projects` and written only under temp.
 * Prints one JSON line; exit 0 only when every check holds. Temp folders go.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createPrimaryRole } from "../server/lib/primary-role";
import {
  applyPendingPrimaryChange, collectTranscripts, commitIncoming, countRows, DB_NAME, isRefusedWhenRetired,
  readRetired, snapshotDatabase, writeIncomingChunk,
} from "../server/lib/primary-switch";
import { findCliTranscript } from "../server/lib/subagent-migration";
import { runPrimarySwitch } from "../server/services/primary-switch-run";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const source = arg("--db");
const projectsDir = arg("--projects") ?? join(homedir(), ".claude", "projects");
if (!source) {
  console.error("usage: bun scripts/primary-switch-probe.ts --db <path to a copy-able topics.db> [--projects <dir>]");
  process.exit(64);
}

const root = mkdtempSync(join(tmpdir(), "primary-switch-probe-"));
const side = (label: string) => {
  const stateDir = join(root, label, "state");
  const appDataDir = join(root, label, "app-data");
  mkdirSync(join(stateDir, "data"), { recursive: true });
  mkdirSync(appDataDir, { recursive: true });
  return { stateDir, appDataDir, dbPath: join(stateDir, "data", DB_NAME) };
};
const old = side("old");
const neu = { ...side("new"), projectsDir: join(root, "new", "claude-projects") };
const checks: Record<string, boolean> = {};
const t0 = Date.now();

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

try {
  const live = new Database(source, { readonly: true });
  const copied = snapshotDatabase(live, old.dbPath);
  live.close();
  const db = new Database(old.dbPath);
  const before = countRows(db);
  checks.copyMatchesSource = JSON.stringify(before) === JSON.stringify(copied);
  const local = (db.query("SELECT id FROM machines WHERE hostname = ?").get(hostname()) as { id: string } | null)?.id ?? "probe-old";
  const role = createPrimaryRole({ db, stateFile: join(old.appDataDir, "primary-state.json"), localMachineId: () => local, log: () => {} });
  role.adopt({ primaryMachineId: local, epoch: role.epoch() + 1 });
  const transcripts = collectTranscripts(db, projectsDir);
  let busy = true;
  let drainRow = "";
  let fence: unknown = null;
  const report = await runPrimarySwitch({
    db, stateDir: old.stateDir, appDataDir: old.appDataDir, projectsDir, role, localMachineId: local,
    target: { id: "probe-new", hostname: "probe-new-host", name: "probe" },
    drain: () => {}, undrain: () => {},
    stillWorking: () => {
      if (busy) { drainRow = writeOneMessage(db); busy = false; return [{ taskId: "probe", sessionKey: "probe" }]; }
      return [];
    },
    park: async () => {},
    setFence: (s) => { fence = s; },
    upload: async (name, offset, bytes) => { writeIncomingChunk(neu.stateDir, name, offset, bytes); },
    commit: async (manifest) => {
      const v = await commitIncoming(neu.stateDir, manifest, { hostname: "probe-new-host", epoch: 0 });
      return v.ok ? { kind: "accepted", counts: v.counts } : { kind: "refused", code: v.code, error: v.error };
    },
    restartSelf: () => {}, sleep: async () => {}, pollMs: 0, log: () => {},
  });
  checks.switched = report.outcome === "switched";
  checks.restored = applyPendingPrimaryChange({ ...neu, log: () => {} }) === "restored";
  const restored = new Database(neu.dbPath, { readonly: true });
  const after = countRows(restored);
  checks.countsEqual = after.tasks === before.tasks && after.topics === before.topics && after.messages === before.messages + 1;
  checks.drainWritePresent = restored.query("SELECT 1 FROM messages WHERE rowid = ?").get(drainRow) !== null;
  restored.close();
  checks.oldRefusesWrites = fence !== null && isRefusedWhenRetired("/api/tasks", "POST") && !role.isPrimary();
  db.close();
  checks.oldSetAside = applyPendingPrimaryChange({ ...old, projectsDir, log: () => {} }) === "set-aside" && readRetired(old.appDataDir) !== null;
  const sample = transcripts.find((t) => t.name.endsWith(".jsonl") && !t.name.includes("/subagents/"));
  const id = sample?.name.split("/").pop()!.replace(/\.jsonl$/, "");
  const found = id ? findCliTranscript(id, neu.projectsDir) : null;
  checks.transcriptResumes = !!sample && !!found && readFileSync(found).equals(readFileSync(sample.source));
  const ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ ok, checks, before, after, transcriptFiles: transcripts.length, bytes: report.bytes, seconds: (Date.now() - t0) / 1000 }));
  writeFileSync(join(tmpdir(), "primary-switch-probe-last.json"), JSON.stringify({ ok, checks, before, after }));
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
