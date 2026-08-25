/**
 * `/compact` FINISCE — provato spawnando una CLI vera (finta, ma un processo).
 *
 * L'unità (`claude-code-compaction-result.test.ts`) inchioda la decisione: un
 * `result` senza testo chiude il turno. Questo test prova la CATENA: sendChat →
 * spawn del figlio → stdin → stdout NDJSON → readline → handleStreamEvent →
 * `onCompaction` + `onDone` → la promessa di `sendChat` che si risolve.
 *
 * Quella promessa è il punto. Prima di questo fix non si risolveva MAI su un
 * `/compact`: la coda seriale dei turni (`pp.pendingResolve`) restava presa, il
 * messaggio successivo si accodava dietro di lei, e a trenta minuti il watchdog
 * uccideva il figlio scrivendo in chat «Nessuna attività dal modello per 30
 * minuti. Turno terminato.» sopra una compattazione perfettamente riuscita.
 * Verificato dal vivo su topic:44d914ec il 20/08/2026: `/compact` alle 10:42,
 * `compact_boundary` alle 10:45, turno ucciso alle 11:15.
 *
 * Il secondo `sendChat` è quindi metà del test, non un di più: è il messaggio
 * scritto DOPO — quello che in pagina arriva dalla coda, che si drena alla fine
 * di uno stream. Se il turno di compattazione non finisce, questo non parte, e
 * il test scade invece di passare. È il «poi non manda più i messaggi in coda».
  * @covers CCLI-05
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, cpSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
let tempDir = "";
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "compact-turn-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);

  // La CLI finta emette la sequenza REGISTRATA di una compattazione vera
  // (init → compact_boundary → result vuoto). Vive in tests/e2e/helpers perché
  // è la stessa che serve al banco end-to-end.
  const src = join(REPO_ROOT, "tests", "e2e", "helpers", "fake-claude-compact.ts");
  const fake = join(tempDir, "fake-claude-compact.ts");
  cpSync(src, fake);
  chmodSync(fake, 0o755);
  setEnv("TOPICS_CLAUDE_CLI_PATH", fake);
});

afterAll(async () => {
  try {
    const { closeDatabase } = await import("../db");
    closeDatabase();
  } catch { /* mai aperto */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

interface Registrato {
  compattazioni: number;
  done: number;
  errori: string[];
}

function handler(reg: Registrato, risolvi: () => void, rifiuta: (e: Error) => void) {
  return {
    onTextDelta: () => {},
    onToolStart: () => {},
    onToolResult: () => {},
    onSubAgentUpdate: () => {},
    onUserInputRequired: () => {},
    onAborted: () => {},
    onCompaction: () => { reg.compattazioni++; },
    onDone: () => { reg.done++; risolvi(); },
    onError: (e: string) => { reg.errori.push(e); rifiuta(new Error(e)); },
  } as never;
}

describe("un turno di /compact si CHIUDE (catena intera, figlio vero)", () => {
  test("compattazione → onDone, e il messaggio dopo parte davvero", async () => {
    const { initDatabase, getDatabase } = await import("../db");
    initDatabase(REPO_ROOT);
    const now = new Date().toISOString();
    getDatabase().prepare(
      `INSERT INTO topics (id, name, slug, session_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("t-cmp", "cmp", "cmp", "topic:compact-test", now, now);

    const { ClaudeCodeProvider } = await import("./claude-code");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });

    const reg: Registrato = { compattazioni: 0, done: 0, errori: [] };

    // 1) Il turno di compattazione. `sendChat` RESTITUISCE — ed è tutto il
    //    punto: prima restava appesa fino al watchdog dei 30 minuti.
    const primo = new Promise<void>((res, rej) => {
      void provider.sendChat("topic:compact-test", "/compact", handler(reg, res, rej)).catch(rej);
    });
    await primo;

    expect(reg.errori).toEqual([]);
    // La compattazione è arrivata: il divider in chat nasce da qui.
    expect(reg.compattazioni).toBe(1);
    // …e il turno è FINITO.
    expect(reg.done).toBe(1);

    // 2) Il messaggio scritto dopo — in pagina è quello che la coda drena a
    //    fine stream. Con il turno di prima ancora aperto, la coda seriale di
    //    `sendChat` lo terrebbe fermo e questa attesa scadrebbe.
    const secondo = new Promise<void>((res, rej) => {
      void provider.sendChat("topic:compact-test", "e adesso?", handler(reg, res, rej)).catch(rej);
    });
    await secondo;

    expect(reg.errori).toEqual([]);
    expect(reg.done).toBe(2);

    await provider.stop();
  }, 30_000);
});
