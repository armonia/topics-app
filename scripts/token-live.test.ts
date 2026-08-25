/**
 * Il braccio macchina di token-live.
 *
 * `--json` esiste per essere letto da un programma, e un programma non perdona:
 * basta una riga di legenda, un colore o l'intestazione della tabella e
 * `JSON.parse` muore. Qui lo script gira DAVVERO (spawn, DB temporaneo,
 * transcript finto) e stdout viene parsato intero — non "cercato dentro".
 *
 * I numeri non sono decorazione: contesto dell'ultima chiamata, token letti e
 * chiamate sono calcolati a mano sul transcript qui sotto, così se un giorno il
 * dedup per `message.id` o la somma fresco+cache cambiano, questo diventa rosso
 * invece di continuare a stampare un JSON ben formato e sbagliato.
 *
 * @covers USAGE-18
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "token-live.ts");
const MODEL = "claude-opus-5"; // finestra nota: 200k

let dir: string;

/** Due chiamate vere, una riga duplicata (stesso message.id) e un preambolo. */
function transcript(): string {
  const lines = [
    { type: "user", message: { role: "user", content: "<context>preambolo</context> ciao" } },
    {
      type: "assistant",
      message: {
        id: "msg_1",
        model: MODEL,
        content: [{ type: "text", text: "prima" }],
        usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 },
      },
    },
    // Stessa risposta, secondo content-block: la CLI la riscrive, non va contata.
    {
      type: "assistant",
      message: {
        id: "msg_1",
        model: MODEL,
        content: [{ type: "text", text: "prima (bis)" }],
        usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 },
      },
    },
    {
      type: "assistant",
      message: {
        id: "msg_2",
        model: MODEL,
        content: [{ type: "text", text: "seconda" }],
        usage: {
          input_tokens: 50,
          output_tokens: 5,
          cache_creation_input_tokens: 2000,
          cache_read_input_tokens: 7000,
          cache_creation: { ephemeral_1h_input_tokens: 2000 },
        },
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "token-live-"));
  const jsonl = join(dir, "chat.jsonl");
  writeFileSync(jsonl, transcript());

  const db = new Database(join(dir, "topics.db"));
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, session_key TEXT, model TEXT, archived INTEGER, updated_at TEXT)`);
  db.run(`CREATE TABLE claude_code_sessions (session_key TEXT PRIMARY KEY, jsonl_path TEXT, phase TEXT)`);
  db.run(`INSERT INTO topics VALUES ('t1', 'Chat  viva', 'sk-1', '${MODEL}', 0, '2026-01-02')`);
  db.run(`INSERT INTO claude_code_sessions VALUES ('sk-1', '${jsonl}', 'idle')`);
  // Archiviata: la tabella non la mostra, e nemmeno il JSON deve mostrarla.
  db.run(`INSERT INTO topics VALUES ('t2', 'Chat archiviata', 'sk-2', '${MODEL}', 1, '2026-01-01')`);
  db.run(`INSERT INTO claude_code_sessions VALUES ('sk-2', '${jsonl}', 'idle')`);
  db.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(...extra: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bun", SCRIPT, ...extra], {
    env: { ...process.env, DATA_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { stdout, stderr, code: await proc.exited };
}

describe("token-live --json", () => {
  it("stampa un solo oggetto JSON e nient'altro", async () => {
    const { stdout, code } = await run("--json");
    expect(code).toBe(0);
    expect(stdout).not.toContain("\x1b["); // nessun colore
    expect(stdout).not.toContain("CHIAMATE"); // nessuna intestazione
    expect(stdout).not.toContain("PREAMBOLI ="); // nessuna legenda
    expect(stdout.trim().split("\n")).toHaveLength(1);

    const parsed = JSON.parse(stdout); // l'intero stdout, non un pezzo
    expect(Array.isArray(parsed.chats)).toBe(true);
    expect(parsed.chats).toHaveLength(1); // l'archiviata resta fuori
  });

  it("l'involucro risponde alle due domande che un consumatore fa per prime", async () => {
    // WHEN was this true, and WHAT was it filtered by. This wrapper was
    // delivered on 2026-08-09 and silently removed the day after by a rewrite
    // done for an unrelated reason (`01c118f3f`); nothing caught it because
    // nothing asserted the shape. Without `generatedAt` a cached reading is
    // indistinguishable from a fresh one; without `filter` a short list reads
    // as "few chats" when it was "few chats MATCHING".
    const { stdout } = await run("--json");
    const parsed = JSON.parse(stdout);

    expect(Number.isFinite(Date.parse(parsed.generatedAt)), "generatedAt deve essere una data leggibile").toBe(true);
    expect(parsed).toHaveProperty("filter", null);
    // `count` is the cheap guard against a truncated pipe: a consumer compares
    // it with what it actually received.
    expect(parsed.count).toBe(parsed.chats.length);
  });

  it("il filtro finisce NELL'involucro, non solo nell'effetto", async () => {
    const { stdout } = await run("--json", "prima");
    const parsed = JSON.parse(stdout);
    expect(parsed.filter, "chi legge deve poter dire perche' la lista e' corta").toBe("prima");
  });

  it("`--json --watch` viene RIFIUTATO, non obbedito a meta'", async () => {
    // A watched JSON render prints one object every four seconds, which is a
    // stream of objects: `jq` on the other end either blocks or chokes on the
    // second one. The kind failure is the loud one — the alternative is a
    // command that appears to work and produces something unparseable.
    const { code, stderr, stdout } = await run("--json", "--watch");
    expect(code, "deve uscire non-zero").not.toBe(0);
    expect(stderr).toContain("si escludono");
    expect(stdout.trim(), "e non deve aver stampato niente su stdout").toBe("");
  });

  it("ogni voce porta gli stessi numeri della tabella", async () => {
    const { stdout } = await run("--json");
    const [chat] = JSON.parse(stdout).chats;

    expect(Object.keys(chat).sort()).toEqual(
      [
        "calls",
        "contextPct",
        "contextWindowKnown",
        "contextWindowTokens",
        "costUsd",
        "lastContextTokens",
        "model",
        "name",
        "phase",
        "preambles",
        "readTokens",
        "sessionKey",
      ].sort(),
    );

    expect(chat.sessionKey).toBe("sk-1");
    expect(chat.name).toBe("Chat viva"); // spazi collassati, come nella tabella
    expect(chat.phase).toBe("idle");
    expect(chat.model).toBe(MODEL);
    expect(chat.calls).toBe(2); // il duplicato di msg_1 non conta
    expect(chat.preambles).toBe(1);
    expect(chat.lastContextTokens).toBe(50 + 7000 + 2000); // ultima chiamata
    expect(chat.contextWindowTokens).toBe(200_000);
    expect(chat.contextWindowKnown).toBe(true);
    expect(chat.contextPct).toBeCloseTo((9050 / 200_000) * 100, 6);
    expect(chat.readTokens).toBe(150 + 3000 + 12_000); // fresco + scrittura + rilettura
    expect(chat.costUsd).toBeGreaterThan(0);
  });

  it("il filtro vale anche in JSON", async () => {
    const { stdout } = await run("nessunachat", "--json");
    expect(JSON.parse(stdout).chats).toEqual([]);
  });
});

describe("senza --json non cambia niente", () => {
  it("resta la tabella, con intestazione e legenda", async () => {
    const { stdout, code } = await run();
    expect(code).toBe(0);
    expect(stdout).toContain("CHIAMATE");
    expect(stdout).toContain("Chat viva");
    expect(stdout).toContain("\x1b["); // i colori ci sono ancora
    expect(() => JSON.parse(stdout)).toThrow();
  });
});
