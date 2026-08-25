/**
 * saveSingleTopic — cascade-safety regression tests.
 *
 * `insertTopic` MUST be a true UPSERT (ON CONFLICT DO UPDATE), never
 * `INSERT OR REPLACE`: SQLite resolves REPLACE by DELETE+INSERT, and with
 * PRAGMA foreign_keys=ON that hidden DELETE fires every ON DELETE action
 * pointing at topics. The observable damage of the REPLACE era, guarded here:
 *   - claude_code_sessions (the CLI `--resume` mapping) CASCADE-wiped on every
 *     topic update → chat respawned fresh and lost the model's session memory;
 *   - unread CASCADE-wiped;
 *   - children's parent_id SET NULL → topic hierarchy silently flattened.
  * @covers UPSERT-01
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase } from "./db";
import { createAppContext } from "./utils";
import type { AppContext, Topic } from "./types";

/* DATA_DIR E' AMBIENTE CONDIVISO, e questo file lo scrive.
 *
 * `server/db.ts:17` risolve la cartella dati come `process.env.DATA_DIR ||
 * join(dataRoot, "data")`: l'ambiente vince sull'argomento esplicito. Bun
 * carica piu' file di test nello STESSO processo, quindi una scrittura non
 * restituita decide dove finisce il database di tutti i file caricati dopo.
 * Misurato il 21/08: due file lanciati insieme aprivano quattro volte lo
 * stesso db temporaneo di uno dei due, mentre da soli ne creavano di propri.
 * Qui la variabile serve davvero (non si passa da `initDatabase`), quindi si
 * RESTITUISCE invece di toglierla. */
const DATA_DIR_PRIMA = process.env.DATA_DIR;


let tmpRoot: string;
let ctx: AppContext;

function makeTopic(id: string, over: Partial<Topic> = {}): Topic {
  const now = new Date().toISOString();
  return {
    id,
    name: `Topic ${id}`,
    slug: `topic-${id}`,
    parentId: null,
    links: [],
    sessionKey: `topic:${id.slice(0, 8)}`,
    color: "#aabbcc",
    icon: "chat",
    createdAt: now,
    updatedAt: now,
    archived: false,
    ...over,
  };
}

beforeAll(() => {
  // Replicate the real layout in a tmpdir so migrations run as-is (same
  // pattern as db/activity-log.test.ts).
  tmpRoot = mkdtempSync(join(tmpdir(), "topic-save-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  mkdirSync(join(tmpRoot, "public"), { recursive: true });
  process.env.DATA_DIR = join(tmpRoot, "data");
  process.env.OPENCLAW_DIR = join(tmpRoot, "openclaw");
  ctx = createAppContext(tmpRoot);
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("saveSingleTopic upsert (no REPLACE cascade)", () => {
  test("re-saving a topic preserves its claude_code_sessions resume mapping", () => {
    const parent = makeTopic("11111111-aaaa-bbbb-cccc-000000000001");
    ctx.saveSingleTopic(parent);

    const now = new Date().toISOString();
    ctx.db
      .prepare(
        `INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(parent.sessionKey, "cli-session-uuid", now, now);

    // Simulate a PATCH: rename + bump updated_at, save again.
    ctx.saveSingleTopic({ ...parent, name: "Renamed", updatedAt: new Date().toISOString() });

    const row = ctx.db
      .prepare(`SELECT claude_session_id FROM claude_code_sessions WHERE session_key = ?`)
      .get(parent.sessionKey) as { claude_session_id: string } | undefined;
    expect(row?.claude_session_id).toBe("cli-session-uuid");

    const saved = ctx.getTopicById(parent.id);
    expect(saved?.name).toBe("Renamed");
  });

  test("re-saving a topic preserves unread state", () => {
    const topic = makeTopic("22222222-aaaa-bbbb-cccc-000000000002");
    ctx.saveSingleTopic(topic);
    ctx.db
      .prepare(`INSERT INTO unread (topic_id, last_read_at, unread_count) VALUES (?, ?, ?)`)
      .run(topic.id, new Date().toISOString(), 7);

    ctx.saveSingleTopic({ ...topic, archived: true });

    const row = ctx.db
      .prepare(`SELECT unread_count FROM unread WHERE topic_id = ?`)
      .get(topic.id) as { unread_count: number } | undefined;
    expect(row?.unread_count).toBe(7);
  });

  test("re-saving a parent topic does not null out children's parent_id", () => {
    const parent = makeTopic("33333333-aaaa-bbbb-cccc-000000000003");
    ctx.saveSingleTopic(parent);
    const child = makeTopic("44444444-aaaa-bbbb-cccc-000000000004", { parentId: parent.id });
    ctx.saveSingleTopic(child);

    ctx.saveSingleTopic({ ...parent, name: "Parent v2" });

    const row = ctx.db
      .prepare(`SELECT parent_id FROM topics WHERE id = ?`)
      .get(child.id) as { parent_id: string | null } | undefined;
    expect(row?.parent_id).toBe(parent.id);
  });

  test("brand-new topic still inserts", () => {
    const topic = makeTopic("55555555-aaaa-bbbb-cccc-000000000005");
    ctx.saveSingleTopic(topic);
    expect(ctx.getTopicById(topic.id)?.name).toBe(topic.name);
  });

  test("standalone survives the save/load round-trip (migration 044)", () => {
    // Regression: `standalone` was on the Topic type but had no DB column, so
    // it was silently dropped on save — the task-workspace / catch-all-session
    // presentation never actually took effect at runtime.
    const t = makeTopic("66666666-aaaa-bbbb-cccc-000000000006", {
      projectPath: "/tmp/.openclaw/workspace/tasks/66666666",
      standalone: true,
    });
    ctx.saveSingleTopic(t);
    expect(ctx.getTopicById(t.id)?.standalone).toBe(true);

    // Flipping it off round-trips too (undefined, not a stuck `true`).
    ctx.saveSingleTopic({ ...t, standalone: false });
    expect(ctx.getTopicById(t.id)?.standalone).toBeUndefined();

    // A normal topic never gains the flag.
    const plain = makeTopic("77777777-aaaa-bbbb-cccc-000000000007");
    ctx.saveSingleTopic(plain);
    expect(ctx.getTopicById(plain.id)?.standalone).toBeUndefined();
  });

  test("mcpPolicy survives the save/load round-trip (migration 049)", () => {
    // Same invariant as `standalone`: a Topic field without its column +
    // insertTopic binding + rowToTopic read silently drops on save.
    const t = makeTopic("88888888-aaaa-bbbb-cccc-000000000008", {
      mcpPolicy: "bridge-only",
    });
    ctx.saveSingleTopic(t);
    expect(ctx.getTopicById(t.id)?.mcpPolicy).toBe("bridge-only");

    // Clearing it round-trips too (absent, not a stuck value).
    ctx.saveSingleTopic({ ...t, mcpPolicy: null });
    expect(ctx.getTopicById(t.id)?.mcpPolicy).toBeUndefined();

    // A normal topic never gains the field.
    const plain = makeTopic("99999999-aaaa-bbbb-cccc-000000000009");
    ctx.saveSingleTopic(plain);
    expect(ctx.getTopicById(plain.id)?.mcpPolicy).toBeUndefined();
  });

  describe("browserState (migration 075)", () => {
    // Il campo esisteva nel tipo ed era SCRITTO — `onNavigate` in server.ts lo
    // assegnava e chiamava `saveSingleTopic` — ma senza colonna, senza binding
    // in insertTopic e senza lettura in rowToTopic il salvataggio lo scartava in
    // silenzio: la lettura dopo lo ritrovava `undefined`. Costo osservato:
    // `GET /api/topics` non ha mai riportato browserState a nessun client, e
    // `restoreAllContexts` — che lo cercava per decidere cosa ripristinare — ha
    // stampato «0 restored» per 962 boot di fila.
    const STATE = {
      url: "https://example.com/",
      contextId: "bs000001-bbbb-cccc-dddd-000000000001",
      lastActiveAt: 1_700_000_000_000,
      viewport: { width: 1280, height: 800 },
    };

    test("sopravvive al giro salva/ricarica", () => {
      const t = makeTopic("bs000001-bbbb-cccc-dddd-000000000001", { browserState: STATE });
      ctx.saveSingleTopic(t);
      expect(ctx.getTopicById(t.id)?.browserState).toEqual(STATE);
      // Anche dalla lettura in blocco, che e' la strada di GET /api/topics.
      expect(ctx.loadTopics().topics[t.id]?.browserState).toEqual(STATE);
    });

    test("la scrittura mirata aggiorna solo quella colonna", () => {
      const t = makeTopic("bs000002-bbbb-cccc-dddd-000000000002", { name: "Nome che deve restare" });
      ctx.saveSingleTopic(t);

      ctx.setTopicBrowserState(t.id, STATE);

      const after = ctx.getTopicById(t.id);
      expect(after?.browserState).toEqual(STATE);
      // Il resto della riga non e' stato toccato: e' tutto il punto della
      // scrittura per colonna (onNavigate scatta a ogni navigazione e non deve
      // correre con una rinomina o un'archiviazione in volo).
      expect(after?.name).toBe("Nome che deve restare");
    });

    test("`null` cancella, e non lascia un valore incastrato", () => {
      const t = makeTopic("bs000003-bbbb-cccc-dddd-000000000003", { browserState: STATE });
      ctx.saveSingleTopic(t);
      expect(ctx.getTopicById(t.id)?.browserState).toBeDefined();

      ctx.setTopicBrowserState(t.id, null);
      expect(ctx.getTopicById(t.id)?.browserState).toBeUndefined();
    });

    test("un topic che non esiste e' un no-op silenzioso", () => {
      // Il contextId puo' appartenere a una pane temporanea o a un terminale
      // (`term-<id>`), che qui non ha una riga: l'hook non deve rumoreggiare.
      expect(() => ctx.setTopicBrowserState("non-esiste", STATE)).not.toThrow();
    });

    test("JSON illeggibile in colonna non fa cadere la lettura del topic", () => {
      const t = makeTopic("bs000004-bbbb-cccc-dddd-000000000004", { name: "Con JSON rotto" });
      ctx.saveSingleTopic(t);
      ctx.db.prepare("UPDATE topics SET browser_state = ? WHERE id = ?").run("{non json", t.id);

      const after = ctx.getTopicById(t.id);
      expect(after?.name).toBe("Con JSON rotto");
      expect(after?.browserState).toBeUndefined();
    });

    test("un topic normale non guadagna il campo", () => {
      const plain = makeTopic("bs000005-bbbb-cccc-dddd-000000000005");
      ctx.saveSingleTopic(plain);
      expect(ctx.getTopicById(plain.id)?.browserState).toBeUndefined();
    });
  });
});

afterAll(() => {
  if (DATA_DIR_PRIMA === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = DATA_DIR_PRIMA;
});
