/**
 * The merge of split project identities WRITES ONLY ON REQUEST.
 *
 * `canonical-project-path.ts` stops a second identity from being born; what is
 * already written stays, and folding it is an explicit act. The script's
 * default is the dry run, and the promise worth guarding is the negative one:
 * without `--esegui` the database comes back byte-for-byte the same, while the
 * output already names old id, new id and the counts. The `--esegui` case is
 * here so the dry run is proven against a script that CAN write, not against
 * one that never does.
 *
 * The script is run as a SUBPROCESS, the way a person runs it: it reads
 * `process.argv` and exits on its own, so importing it would be testing a
 * different program. `TOPICS_DB` points it at a synthetic database with the
 * three tables it touches; nothing here looks at the real one.
 *
 * @covers PROJ-ID-02
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { projectIdForPath } from "../shared/board";
import { projectHash, PROJECT_PANES_PREFIX } from "../shared/project-keys";

const SCRIPT = join(import.meta.dir, "canonicalizza-progetti.ts");

let base = "";
let realDir = "";
let link = "";
let dbPath = "";

function seed(): void {
  const db = new Database(dbPath);
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, project_path TEXT)");
  db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT)");
  db.run("CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO topics VALUES ('t1', ?)", [link]);
  db.run("INSERT INTO topics VALUES ('t2', ?)", [link]);
  db.run("INSERT INTO tasks VALUES ('k1', ?)", [projectIdForPath(link)]);
  db.run("INSERT INTO ui_state VALUES (?, '{\"layout\":1}')", [PROJECT_PANES_PREFIX + projectHash(link)]);
  db.close();
}

function snapshot(): unknown {
  const db = new Database(dbPath, { readonly: true });
  const out = {
    topics: db.query("SELECT id, project_path FROM topics ORDER BY id").all(),
    tasks: db.query("SELECT id, project_id FROM tasks ORDER BY id").all(),
    keys: db.query("SELECT key FROM ui_state ORDER BY key").all(),
  };
  db.close();
  return out;
}

function run(...args: string[]) {
  // cwd is the temp dir on purpose: the script falls back to `./data/topics.db`
  // and the repo has one. `TOPICS_DB` wins anyway; this makes the fallback moot.
  const r = spawnSync("bun", [SCRIPT, ...args], {
    cwd: base,
    env: { ...process.env, TOPICS_DB: dbPath },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "canon-script-")));
  realDir = join(base, "real-project");
  mkdirSync(realDir);
  link = join(base, "shortcut");
  symlinkSync(realDir, link);
  dbPath = join(base, "topics.db");
  seed();
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("canonicalizza-progetti", () => {
  it("without --esegui it lists old and new id with the counts, and writes nothing", () => {
    const before = readFileSync(dbPath);
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain("PROVA");
    expect(out).toContain(link);
    expect(out).toContain(realDir);
    expect(out).toContain(`${projectIdForPath(link)} -> ${projectIdForPath(realDir)}`);
    expect(out).toContain("topic da rilegare: 2");
    expect(out).toContain("righe tasks da spostare: 1");
    expect(out).toContain(PROJECT_PANES_PREFIX + projectHash(link));
    // Byte-for-byte: a dry run that touched a page would show up here.
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });

  it("with --esegui topics, tasks and ui_state keys move under the real folder's identity", () => {
    const { code, out } = run("--esegui");
    expect(code).toBe(0);
    expect(out).toContain("ESEGUO");
    expect(snapshot()).toEqual({
      topics: [{ id: "t1", project_path: realDir }, { id: "t2", project_path: realDir }],
      tasks: [{ id: "k1", project_id: projectIdForPath(realDir) }],
      keys: [{ key: PROJECT_PANES_PREFIX + projectHash(realDir) }],
    });
  });

  it("a saved path that is already canonical is not a case", () => {
    const db = new Database(dbPath);
    db.run("UPDATE topics SET project_path = ?", [realDir]);
    db.close();
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain("niente da fondere");
  });
});
