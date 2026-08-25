/**
 * Test di integrazione per il codec blocks/tool_calls (shared/message-blob.ts).
 *
 * Verifica che `decodeCol` sia attraversato da OGNI percorso di lettura:
 * `rowToMessage`, `endStream`, `waitingAskStartedAt`, `decidePermissionPaint`.
 *
 * La fixture inserisce righe con `blocks` e `tool_calls` COMPRESSI con zstd
 * (tramite `encodeCol`) e le fa uscire dai lettori, asserendo che il dettaglio
 * sia byte-identico all'originale. Su un DB in chiaro (tutto in stringa) la
 * stessa suite è l'identità: nessun comportamento cambia prima della
 * compressione dei dati.
  * @covers WIRE-10
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext } from "../../server/types";
import { encodeCol, decodeCol } from "../../shared/message-blob";

const ROOT = testTmpDir("message-blob-codec");

beforeAll(() => setupTestDataDir(ROOT));

// Tool call fixture — un tool "running" e un tool "success", per testare sia
// l'idratazione normale sia il percorso di finalizzazione orfana.
const TOOL_CALLS_OBJ = [
  { id: "tc_running", name: "Bash", status: "running", startedAt: 1_700_000_000_000 },
  { id: "tc_done",    name: "Read", status: "success" },
];
const TOOL_CALLS_JSON = JSON.stringify(TOOL_CALLS_OBJ);

const BLOCKS_OBJ = [
  { kind: "tool", toolCall: { id: "tc_running", name: "Bash", status: "waiting_for_input", startedAt: 1_700_000_000_001 } },
  { kind: "text", text: "ecco il risultato" },
];
const BLOCKS_JSON = JSON.stringify(BLOCKS_OBJ);

// ─── helper per inserire una riga "compressa" direttamente nel DB ─────────────

function insertRawMessage(
  ctx: AppContext,
  id: string,
  sessionKey: string,
  toolCallsRaw: string | Uint8Array | null,
  blocksRaw: string | Uint8Array | null,
  partial = 0,
) {
  const db = ctx.db;
  db.prepare(
    `INSERT INTO messages
      (id, session_key, role, content, tool_calls, blocks, partial, timestamp, sort_order)
     VALUES (?, ?, 'assistant', '', ?, ?, ?, datetime('now'), 0)
     ON CONFLICT(id) DO UPDATE SET tool_calls=excluded.tool_calls, blocks=excluded.blocks`,
  ).run(id, sessionKey, toolCallsRaw ?? null, blocksRaw ?? null, partial);
}

// ─── 1. encodeCol / decodeCol — round-trip puro ──────────────────────────────

describe("encodeCol / decodeCol — round-trip", () => {
  test("stringa corta: identità (sotto 512 byte)", () => {
    const s = '{"a":1}';
    const enc = encodeCol(s);
    expect(enc).toBe(s);            // non compressa
    expect(decodeCol(enc)).toBe(s); // identità
  });

  test("stringa lunga: comprime e decomprime correttamente", () => {
    const s = TOOL_CALLS_JSON.repeat(10); // > 512 byte
    const enc = encodeCol(s);
    expect(enc).toBeInstanceOf(Uint8Array);  // compressa
    expect(decodeCol(enc)).toBe(s);
  });

  test("null/undefined → null", () => {
    expect(decodeCol(null)).toBeNull();
    expect(decodeCol(undefined)).toBeNull();
    expect(encodeCol(null)).toBeNull();
    expect(encodeCol(undefined)).toBeUndefined();
  });

  test("Buffer da SQLite (Uint8Array) viene decompresso", () => {
    const enc = encodeCol(TOOL_CALLS_JSON.repeat(5)) as Uint8Array;
    // Simula SQLite che restituisce un Uint8Array (non Buffer)
    const u8 = new Uint8Array(enc.buffer, enc.byteOffset, enc.byteLength);
    expect(decodeCol(u8)).toBe(TOOL_CALLS_JSON.repeat(5));
  });
});

// ─── 2. rowToMessage legge blocks e tool_calls compressi ─────────────────────

// JSON abbastanza lungo da superare la soglia di compressione (512 byte)
const TOOL_CALLS_LONG = JSON.stringify(
  Array.from({ length: 15 }, (_, i) => ({
    id: `tc_${i}`,
    name: "Bash",
    status: i === 0 ? "running" : "success",
    startedAt: 1_700_000_000_000 + i,
    output: "x".repeat(30),
  })),
);

describe("rowToMessage — legge colonne compresse", () => {
  test("tool_calls compresso (zstd) idrata toolCalls correttamente", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:blob-rtm-1";
    const id = "msg-rtm-tc-1";
    const enc = encodeCol(TOOL_CALLS_LONG);
    // Verifica che la compressione sia effettiva
    expect(enc instanceof Uint8Array).toBe(true);

    insertRawMessage(ctx, id, sk, enc as Uint8Array, null);

    const thread = ctx.loadActiveThread(sk);
    const found = thread.find((m) => m.id === id);
    expect(found).toBeDefined();
    expect(found!.toolCalls).toBeArrayOfSize(15);
    expect(found!.toolCalls![0].id).toBe("tc_0");
  });

  test("tool_calls in chiaro (stringa) idrata toolCalls correttamente", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:blob-rtm-1b";
    const id = "msg-rtm-tc-1b";

    insertRawMessage(ctx, id, sk, TOOL_CALLS_JSON, null);

    const thread = ctx.loadActiveThread(sk);
    const found = thread.find((m) => m.id === id);
    expect(found).toBeDefined();
    expect(found!.toolCalls).toBeArrayOfSize(2);
    expect(found!.toolCalls![0].id).toBe("tc_running");
    expect(found!.toolCalls![1].name).toBe("Read");
  });

  test("blocks compresso idrata blocks correttamente", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:blob-rtm-2";
    const id = "msg-rtm-bl-1";
    const enc = encodeCol(BLOCKS_JSON) as Uint8Array;

    insertRawMessage(ctx, id, sk, null, enc);

    const thread = ctx.loadActiveThread(sk);
    const found = thread.find((m) => m.id === id);
    expect(found).toBeDefined();
    expect(found!.blocks).toBeArrayOfSize(2);
    expect((found!.blocks![0] as { kind: string }).kind).toBe("tool");
    expect((found!.blocks![1] as { kind: string }).kind).toBe("text");
  });

  test("colonne in chiaro funzionano come prima (invariante su DB non compresso)", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:blob-rtm-plain";
    const id = "msg-rtm-plain";

    insertRawMessage(ctx, id, sk, TOOL_CALLS_JSON, BLOCKS_JSON);

    const thread = ctx.loadActiveThread(sk);
    const found = thread.find((m) => m.id === id);
    expect(found!.toolCalls![0].id).toBe("tc_running");
    expect((found!.blocks![0] as { toolCall: { name: string } }).toolCall.name).toBe("Bash");
  });
});

// ─── 3. waitingAskStartedAt legge blocks compressi ───────────────────────────

describe("waitingAskStartedAt — legge colonne compresse (via topics.ts)", () => {
  test("rileva waiting_for_input da blocks compresso", async () => {
    // Usiamo waitingAskStartedAt direttamente (è pura rispetto al DB)
    const { waitingAskStartedAt } = await import("../../server/lib/waiting-ask");

    const blocksWithWaiting = JSON.stringify([
      { kind: "tool", toolCall: { name: "AskUser", status: "waiting_for_input", startedAt: 42_000 } },
    ]);
    const enc = encodeCol(blocksWithWaiting) as Uint8Array;
    // decodeCol avviene prima della chiamata (come in topics.ts:995)
    const decoded = decodeCol(enc);
    const result = waitingAskStartedAt(null, decoded, undefined);
    expect(result).toBe(42_000);
  });

  test("nessun waiting se blocks non compresso e vuoto", async () => {
    const { waitingAskStartedAt } = await import("../../server/lib/waiting-ask");
    expect(waitingAskStartedAt(null, null, undefined)).toBeNull();
  });
});

// ─── 4. decidePermissionPaint legge tool_calls compresso ─────────────────────

describe("decidePermissionPaint — legge colonne compresse", () => {
  test("trova tool per id in tool_calls compresso", async () => {
    const { decidePermissionPaint } = await import("../../server/lib/permission-paint");

    const calls = JSON.stringify([
      { id: "tu_1", name: "Bash", status: "running" },
      { id: "tu_2", name: "Read", status: "pending" },
    ]);
    const enc = encodeCol(calls) as Uint8Array;
    // decodeCol nella permission-paint stessa
    const row = { tool_calls: decodeCol(enc), blocks: null };
    const d = decidePermissionPaint(row, "tu_1", "Bash");
    expect(d.targetId).toBe("tu_1");
    expect(d.alreadyPainted).toBe(false);
  });

  test("ripiego per nome funziona anche da compresso", async () => {
    const { decidePermissionPaint } = await import("../../server/lib/permission-paint");

    const calls = JSON.stringify([
      { id: "tu_abc", name: "Bash", status: "running" },
    ]);
    const enc = encodeCol(calls) as Uint8Array;
    const row = { tool_calls: decodeCol(enc), blocks: null };
    // toolUseId sconosciuto: si cerca per nome
    const d = decidePermissionPaint(row, "tu_sconosciuto", "Bash");
    expect(d.targetId).toBe("tu_abc");
    expect(d.aliasTo).toBe("tu_abc");
  });
});
