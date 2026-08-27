/**
 * @covers E2E-ISO-01
 *
 * ONE DOOR TO THE STATE FOLDER, and this file is the lock on it.
 *
 * The server's mutable state used to be found by two unrelated roads that
 * nobody kept aligned: `DATA_DIR`, read straight from the environment by
 * `db.ts` and a handful of others, and `resolveStateDir()`, which looked only
 * at `TOPICS_DATA_DIR` and served fifteen call sites. Two names, two
 * populations of callers, no link.
 *
 * It cost a run. On 25/08/2026 the e2e servers exported only `DATA_DIR`: the
 * SQLite was really isolated, `topics.json`, `unread.json`, `uploads/`,
 * `context-files/`, `messages/` and `data/usage/` were not, and landed in the
 * LIVE folder. Four shards on one usage dir, an ENOENT on the rename of a temp
 * file, one server dead at boot, 253 tests never run.
 *
 * The cure of that day was a line in `start-test-server.sh` copying one
 * variable into the other. It worked, and it was a bridge, not a union: the
 * next subsystem born beside the SQLite could still read the wrong name, and no
 * gate would notice until a suite died. THIS is the gate that notices — and it
 * is why the bridge line could be removed.
 *
 * Scope: the server runtime (`server/`, `shared/`), tests excluded. Command
 * line tools under `scripts/` are OUTSIDE consumers — they locate somebody
 * else's database from the shell — so they read the variable on purpose.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { envDataDir, resolveDataDir, resolveStateDir } from "../../server/lib/data-dir";

const ROOT = join(import.meta.dir, "..", "..");
const THE_DOOR = "server/lib/data-dir.ts";

/** Any read of the two variables off any env object, comments included. */
const ENV_READ = /\benv\.(DATA_DIR|TOPICS_DATA_DIR)\b/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
    if (name.includes(".test.") || name.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

describe("STATE-DIR-DOOR-01 · una sola porta per la cartella di stateDir", () => {
  test("nessun file del server legge DATA_DIR o TOPICS_DATA_DIR da solo", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(join(ROOT, "server")), ...sourceFiles(join(ROOT, "shared"))]) {
      const rel = relative(ROOT, file);
      if (rel === THE_DOOR) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (ENV_READ.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `queste letture aggirano ${THE_DOOR}: due nomi non allineati sono il difetto del 25/08`,
    ).toEqual([]);
  });

  test("la porta dichiara la precedenza: TOPICS_DATA_DIR vince, DATA_DIR segue", () => {
    const stateDir = join(tmpdir(), `topics-door-${process.pid}-stateDir`);
    const both = { TOPICS_DATA_DIR: stateDir, DATA_DIR: join(stateDir, "data") } as NodeJS.ProcessEnv;
    expect(resolveStateDir(ROOT, both)).toBe(stateDir);
    expect(resolveDataDir(stateDir, both)).toBe(join(stateDir, "data"));
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("con il SOLO DATA_DIR lo stateDir NON torna nel repo: e' cio' che sostituisce la riga-ponte", () => {
    const isolatedDir = join(tmpdir(), `topics-door-${process.pid}-old-name`);
    const onlyOld = { DATA_DIR: isolatedDir } as NodeJS.ProcessEnv;
    expect(resolveStateDir(ROOT, onlyOld)).toBe(isolatedDir);
    expect(resolveDataDir(resolveStateDir(ROOT, onlyOld), onlyOld)).toBe(isolatedDir);
    rmSync(isolatedDir, { recursive: true, force: true });
  });

  test("senza nulla nell'ambiente il comportamento storico resta identico", () => {
    const empty = {} as NodeJS.ProcessEnv;
    expect(resolveStateDir(ROOT, empty)).toBe(ROOT);
    expect(resolveDataDir(ROOT, empty)).toBe(join(ROOT, "data"));
    expect(envDataDir(empty)).toBeUndefined();
  });

  test("l'identita' del socket: nessuna variabile in produzione, quindi base = cwd come prima", () => {
    expect(envDataDir({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(envDataDir({ DATA_DIR: "/tmp/a" } as NodeJS.ProcessEnv)).toBe("/tmp/a");
    expect(envDataDir({ TOPICS_DATA_DIR: "/tmp/b" } as NodeJS.ProcessEnv)).toBe("/tmp/b");
  });
});
