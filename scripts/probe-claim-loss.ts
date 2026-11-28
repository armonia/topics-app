#!/usr/bin/env bun
/**
 * How much a claim loses when the primary dies without warning (track T9 of
 * `openspec/changes/nodo-principale-a-mano`), measured with the REAL tools.
 *
 * A throwaway DB in a temp folder takes one write every `intervalMs`; a real
 * `litestream replicate` copies it to a `file://` replica encrypted with a
 * throwaway age identity. At an instant T the writer stops and Litestream is
 * killed with SIGKILL, as a computer that loses power. Then the real
 * `claimPrimary` restores the replica through `TOPICS_REPLICA_RESTORE_COMMAND`
 * with the identity handed over in the command's environment, and the probe
 * reports `lost_seconds = T - newest restored write` and the rows lost.
 *
 * Run: `bun scripts/probe-claim-loss.ts [seconds] [runs]` on a computer with
 * Litestream 0.3.x (the last line with age encryption) and `age-keygen` in PATH.
 * `primary-claim-litestream.test.ts` runs one short round of it.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { claimPrimary, type ClaimReport } from "../server/lib/primary-claim";
import { createPrimaryRole } from "../server/lib/primary-role";
import { DB_NAME, INCOMING_DIR } from "../server/lib/primary-switch";

const PRIMARY_STATE_MIGRATION = join(import.meta.dir, "../server/db/migrations/20261118110000-primary-state.sql");
/** Written in every row: a replica that contains it in clear text was not encrypted. */
export const PLAINTEXT_MARKER = "claim-probe-plaintext-marker";

export interface ClaimLoss {
  report: ClaimReport;
  writtenRows: number;
  restoredRows: number;
  lostSeconds: number | null;
  /** True when some replica file carries the marker in clear text. */
  replicaInClear: boolean;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** A throwaway age identity and its recipient, from `age-keygen`. */
function throwawayIdentity(): { identity: string; recipient: string } {
  const r = spawnSync("age-keygen", [], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`age-keygen failed: ${r.stderr}`);
  const identity = r.stdout.split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-"));
  const recipient = /public key: (age1[0-9a-z]+)/.exec(r.stdout + r.stderr)?.[1];
  if (!identity || !recipient) throw new Error("age-keygen printed no identity");
  return { identity, recipient };
}

export async function measureClaimLoss(opts: { seconds: number; intervalMs?: number; keep?: boolean }): Promise<ClaimLoss> {
  const root = mkdtempSync(join(tmpdir(), "claim-loss-"));
  try {
    const liveDb = join(root, "primary", DB_NAME);
    const replicaDir = join(root, "replica");
    mkdirSync(join(root, "primary"), { recursive: true });
    const { identity, recipient } = throwawayIdentity();
    const config = join(root, "litestream.yml");
    // The identity is NOT in the file: Litestream expands the variable from the environment it runs in.
    writeFileSync(config, [
      "dbs:",
      `  - path: ${liveDb}`,
      "    replicas:",
      `      - url: file://${replicaDir}`,
      "        sync-interval: 1s",
      "        age:",
      "          identities: [\"$TOPICS_REPLICA_AGE_IDENTITY\"]",
      `          recipients: ["${recipient}"]`,
      "",
    ].join("\n"));

    // The dead primary: its DB, written at a steady pace.
    const db = new Database(liveDb);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL);
      CREATE TABLE topics (id TEXT PRIMARY KEY);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, body TEXT NOT NULL);`);
    db.exec(readFileSync(PRIMARY_STATE_MIGRATION, "utf-8"));
    const insert = db.query("INSERT INTO messages (timestamp, body) VALUES (?, ?)");
    let writtenRows = 0;
    const write = () => { insert.run(new Date().toISOString(), PLAINTEXT_MARKER); writtenRows++; };
    write();

    const replica = Bun.spawn(["litestream", "replicate", "-config", config], {
      env: { ...process.env, TOPICS_REPLICA_AGE_IDENTITY: identity }, stdout: "ignore", stderr: "ignore",
    });
    await Bun.sleep(2_000);
    const writer = setInterval(write, opts.intervalMs ?? 50);
    await Bun.sleep(opts.seconds * 1000);
    // The power goes: no more writes, and the replica dies without a last sync.
    clearInterval(writer);
    replica.kill("SIGKILL");
    const deathMs = Date.now();
    await replica.exited;
    db.close();

    const replicaInClear = walk(replicaDir).some((f) => readFileSync(f).includes(PLAINTEXT_MARKER));

    // The node: a secondary of the dead primary at epoch 1, with its own DB.
    const stateDir = join(root, "node", "state");
    const appDataDir = join(root, "node", "app-data");
    mkdirSync(join(stateDir, "data"), { recursive: true });
    mkdirSync(appDataDir, { recursive: true });
    const nodeDb = new Database(join(stateDir, "data", DB_NAME));
    nodeDb.exec(readFileSync(PRIMARY_STATE_MIGRATION, "utf-8"));
    const role = createPrimaryRole({ db: nodeDb, stateFile: join(appDataDir, "primary-state.json"), localMachineId: () => "m-node", log: () => {} });
    role.adopt({ primaryMachineId: "m-dead", epoch: 1 });
    const report = await claimPrimary({
      role,
      localMachineId: "m-node",
      hostname: "node",
      stateDir,
      receive: {
        secretsDir: join(stateDir, ".topics-secrets"), appDataDir, dbPath: join(stateDir, "data", DB_NAME),
        projectsDir: join(root, "projects"), replica: {}, holdersOf: () => [],
      },
      settings: { restore: `litestream restore -config "${config}" -o "$TOPICS_RESTORE_OUTPUT" "${liveDb}"`, ageSecret: "replica/age" },
      readSecret: async () => identity,
      lastHeardFromPrimary: () => null,
      force: false,
      restart: () => {},
      log: () => {},
    });
    nodeDb.close();
    let restoredRows = 0;
    if (report.ok) {
      const restored = new Database(join(stateDir, INCOMING_DIR, DB_NAME), { readonly: true });
      restoredRows = (restored.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
      restored.close();
    }
    const newest = report.ok && report.newestWrite ? Date.parse(report.newestWrite) : null;
    return { report, writtenRows, restoredRows, lostSeconds: newest === null ? null : (deathMs - newest) / 1000, replicaInClear };
  } finally {
    if (!opts.keep) rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const seconds = Number(process.argv[2] ?? 20);
  const runs = Number(process.argv[3] ?? 3);
  let failed = false;
  for (let i = 1; i <= runs; i++) {
    const m = await measureClaimLoss({ seconds });
    const outcome = m.report.ok ? `claimed at epoch ${m.report.epoch}` : `refused: ${m.report.error}`;
    console.log(`run ${i}: ${outcome}; written ${m.writtenRows} rows, restored ${m.restoredRows}, lost ${m.writtenRows - m.restoredRows}; lost_seconds = ${m.lostSeconds?.toFixed(3) ?? "n/a"}; replica in clear text: ${m.replicaInClear}`);
    failed ||= !m.report.ok || m.replicaInClear;
  }
  process.exit(failed ? 1 : 0);
}
