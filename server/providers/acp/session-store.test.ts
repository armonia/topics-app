/**
 * La memoria durevole della sessione dell'agente (migration 063).
 *
 * L'errore che questa tabella evita non dà errore: senza, dopo un riavvio del
 * server la chat mostra tutti i messaggi di prima e il modello non ne ricorda
 * nessuno. Quindi si prova la cosa che conta — che l'id SOPRAVVIVA — e la
 * regola meno ovvia: la `cwd` fa parte dell'identità.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { initDatabase, closeDatabase, getDatabase } from "../../db";
import {
  forgetProviderSession,
  readProviderSession,
  sessionMatchesCwd,
  writeProviderSession,
} from "./session-store";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "acp-session-store-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
    initDatabase(tmpRoot);
});

afterAll(() => {
  try { closeDatabase(); } catch { /* già chiuso */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* già sparito */ }
});

describe("provider_sessions", () => {
  test("scrivi → rileggi: l'id sopravvive (è tutto il punto della tabella)", () => {
    writeProviderSession(getDatabase(), "gemini", "topic:a", "sess-1", "/repo");
    expect(readProviderSession(getDatabase(), "gemini", "topic:a")).toEqual({
      providerSessionId: "sess-1",
      cwd: "/repo",
    });
  });

  test("una chat senza memoria dà null, non un errore", () => {
    expect(readProviderSession(getDatabase(), "gemini", "topic:mai-vista")).toBeNull();
  });

  test("la chiave è (provider, sessionKey): due agenti sulla STESSA chat non si pestano", () => {
    writeProviderSession(getDatabase(), "gemini", "topic:b", "g-1", "/repo");
    writeProviderSession(getDatabase(), "goose", "topic:b", "go-1", "/repo");
    expect(readProviderSession(getDatabase(), "gemini", "topic:b")!.providerSessionId).toBe("g-1");
    expect(readProviderSession(getDatabase(), "goose", "topic:b")!.providerSessionId).toBe("go-1");
  });

  test("riscrivere aggiorna invece di duplicare (upsert)", () => {
    writeProviderSession(getDatabase(), "gemini", "topic:c", "sess-1", "/repo");
    writeProviderSession(getDatabase(), "gemini", "topic:c", "sess-2", "/altro");
    expect(readProviderSession(getDatabase(), "gemini", "topic:c")).toEqual({
      providerSessionId: "sess-2",
      cwd: "/altro",
    });
    const n = getDatabase()
      .prepare(`SELECT COUNT(*) AS n FROM provider_sessions WHERE provider='gemini' AND session_key='topic:c'`)
      .get() as { n: number };
    expect(n.n).toBe(1);
  });

  test("dimenticare cancella; dimenticare due volte non esplode", () => {
    writeProviderSession(getDatabase(), "gemini", "topic:d", "sess-9", null);
    forgetProviderSession(getDatabase(), "gemini", "topic:d");
    expect(readProviderSession(getDatabase(), "gemini", "topic:d")).toBeNull();
    expect(() => forgetProviderSession(getDatabase(), "gemini", "topic:d")).not.toThrow();
  });

  test("su un DB senza la tabella la lettura dà null: assenza di memoria, non guasto", () => {
    const bare = new Database(":memory:");
    expect(readProviderSession(bare, "gemini", "topic:a")).toBeNull();
    bare.close();
  });
});

describe("sessionMatchesCwd", () => {
  test("stessa directory → la sessione si può ricaricare", () => {
    expect(sessionMatchesCwd({ providerSessionId: "s", cwd: "/repo" }, "/repo")).toBe(true);
  });

  test("directory DIVERSA → no: ACP la fissa in session/new e non si cambia più", () => {
    expect(sessionMatchesCwd({ providerSessionId: "s", cwd: "/repo" }, "/repo/worktree-x")).toBe(false);
  });

  test("null da una delle due parti → non si invalida niente", () => {
    expect(sessionMatchesCwd({ providerSessionId: "s", cwd: null }, "/repo")).toBe(true);
    expect(sessionMatchesCwd({ providerSessionId: "s", cwd: "/repo" }, null)).toBe(true);
  });
});
