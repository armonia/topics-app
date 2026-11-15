/**
 * @covers KANBAN-116
 */
import { describe, expect, test } from "bun:test";
import { classifyOrigin, classifyStayLocal } from "./stay-local-audit";
import {
  classifyOrigin as sweepClassifyOrigin,
  classifyStayLocal as sweepClassifyStayLocal,
  decideStayLocal,
  runStayLocalSweep,
} from "../server/services/stay-local-sweep";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASKS_DDL, TASKS_FK_STUBS_DDL } from "../server/db/test-schema";

describe("classifyStayLocal", () => {
  test("KEEP: text names a mac-only launch agent path", () => {
    expect(classifyStayLocal({ text: "Fix the plist under ~/Library/LaunchAgents", description: null })).toBe("KEEP");
  });

  test("KEEP: description names /Users/ even when text does not", () => {
    expect(classifyStayLocal({ text: "Investigate a crash", description: "Logs live at /Users/me/Library/Logs" })).toBe("KEEP");
  });

  test("KEEP: text names the tray icon with no literal path (b3e19133-style card)", () => {
    expect(classifyStayLocal({ text: "Fix the tray icon menu not refreshing", description: null })).toBe("KEEP");
  });

  test("KEEP: description names the local hub port", () => {
    expect(classifyStayLocal({ text: "Pairing fails", description: "The hub on :3360 refuses the handshake" })).toBe("KEEP");
  });

  test("DROP: neither text nor description names a mac-only path or feature", () => {
    expect(classifyStayLocal({ text: "Add a retry to the fetch helper", description: "Flaky under load" })).toBe("DROP");
  });
});

describe("classifyOrigin", () => {
  test("dispatcher: the mac-only-path empty-run comment", () => {
    const comments = [{ kind: "service", content: "La corsa su «Nodo» è finita senza nessun commit: la card usa file che stanno solo su questo Mac. La rimetto in coda qui, «solo Mac»." }];
    expect(classifyOrigin(comments)).toBe("dispatcher");
  });

  test("person: the generic reason comment tasks.ts writes for a human-set pin", () => {
    const comments = [{ kind: "service", content: "«Solo Mac», senza scadenza: pin manuale, nessuna ragione scritta." }];
    expect(classifyOrigin(comments)).toBe("person");
  });

  test("person: a typed reason still reads as a person's pin", () => {
    const comments = [{ kind: "service", content: "«Solo Mac», senza scadenza: usa il tray, non si sposta." }];
    expect(classifyOrigin(comments)).toBe("person");
  });

  test("unknown: no service comment names either reason", () => {
    expect(classifyOrigin([{ kind: "comment", content: "qualunque altra cosa" }])).toBe("unknown");
    expect(classifyOrigin([])).toBe("unknown");
  });
});

describe("one classifier, not two", () => {
  test("the audit script re-exports the sweep's own functions", () => {
    // Identity, not behaviour: a copy of the rule here would drift from the
    // sweep that actually clears the pins, and the drift would be invisible.
    expect(classifyStayLocal).toBe(sweepClassifyStayLocal);
    expect(classifyOrigin).toBe(sweepClassifyOrigin);
  });

  test("the audit verdict and the sweep verdict agree on the same card", () => {
    const card = { text: "Add a retry to the fetch helper", description: null };
    expect(classifyStayLocal(card)).toBe("DROP");
    expect(decideStayLocal(card, []).verdict).toBe("clear");
    const mac = { text: "Fix the tray icon", description: null };
    expect(classifyStayLocal(mac)).toBe("KEEP");
    expect(decideStayLocal(mac, []).verdict).toBe("keep");
  });
});

describe("--apply against a database file", () => {
  test("clears a pure-code pin, leaves a mac-only one, and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "stay-local-audit-"));
    const db = new Database(join(dir, "topics.db"));
    try {
      db.run("PRAGMA foreign_keys = ON");
      db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, effort TEXT)`);
      db.run(TASKS_DDL);
      db.run(TASKS_FK_STUBS_DDL);
      db.run(`CREATE TABLE task_comments (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
        content TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'comment'
      )`);
      const insert = (id: string, text: string) =>
        db.run(
          "INSERT INTO tasks (id, project_id, text, created_at, updated_at, stay_local) " +
            "VALUES (?, 'p', ?, '2026-11-15T00:00:00Z', '2026-11-15T00:00:00Z', 1)",
          [id, text],
        );
      insert("code", "Add a retry to the fetch helper");
      insert("tray", "Fix the tray icon menu");

      expect(runStayLocalSweep(db)).toEqual({ scanned: 2, kept: 1, cleared: 1, skipped: 0 });
      expect(runStayLocalSweep(db)).toEqual({ scanned: 1, kept: 1, cleared: 0, skipped: 0 });

      const pins = db.query("SELECT id, stay_local FROM tasks ORDER BY id").all() as
        { id: string; stay_local: number }[];
      expect(pins).toEqual([{ id: "code", stay_local: 0 }, { id: "tray", stay_local: 1 }]);
      const rows = db.query("SELECT content FROM task_comments").all() as { content: string }[];
      expect(rows).toHaveLength(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
