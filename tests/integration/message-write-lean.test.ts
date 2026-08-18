/**
 * Quanto pesa SCRIVERE sulla riga di un turno in corso.
 *
 * Compagno di `thread-load-lean.test.ts`, che misura la LETTURA di un thread.
 * Qui il soggetto sono i mutatori che girano decine di volte per turno: ogni
 * salvataggio periodico del testo passa da `updateLastMessage`, ogni tool che
 * parte da `addToolCallToLastMessage`, ogni risultato da `updateToolCallResult`.
 *
 * Tutti e tre leggevano la riga con una `SELECT` che portava entrambe le colonne
 * grosse — su questo database `blocks` e `tool_calls` sono il 98% dei byte della
 * tabella, e su un turno agentico lungo sono decine di KB a riga — e due di loro
 * ne facevano anche il `JSON.parse` per poi buttarlo via. Su un solo thread di
 * Bun quel lavoro è tempo in cui la chat non disegna, proprio mentre l'agente
 * sta lavorando di più.
 *
 * Si misura il PARSE (i byte che passano da `JSON.parse`), non i millisecondi:
 * un tempo su una macchina condivisa è rumore, i byte no. E la seconda metà del
 * test è la vera barra: una lettura magra che si dimenticasse di riscrivere una
 * colonna la CANCELLEREBBE, quindi dopo ogni mutatore le due colonne grosse
 * devono essere identiche byte per byte a com'erano — tranne quella che il
 * mutatore possiede.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext, StoredMessage } from "../../server/types";
import type { ToolCall, ContentBlock } from "../../shared/types";

const TEST_DATA = testTmpDir("message-write-lean-data");
beforeAll(() => setupTestDataDir(TEST_DATA));

/** ~2 MB di timeline e ~120 KB di tool call: le proporzioni del DB vero. */
const BLOCKS_FILLER = "x".repeat(2_000_000);
const TOOL_FILLER = "y".repeat(120_000);

function seedFatRow(ctx: AppContext, sessionKey: string): StoredMessage {
  const tc: ToolCall = {
    id: "tc-fat", name: "Bash", args: { command: "echo" }, status: "success",
    result: TOOL_FILLER, detail: { type: "shell", command: "echo", output: "ok" },
    startedAt: 1, endedAt: 2,
  };
  const blocks: ContentBlock[] = [
    { kind: "text", text: BLOCKS_FILLER } as ContentBlock,
    { kind: "tool", toolCall: tc } as ContentBlock,
  ];
  ctx.saveLocalMessages(sessionKey, [
    { id: `${sessionKey}-u`, role: "user", content: "domanda", timestamp: new Date(1).toISOString() },
    {
      id: `${sessionKey}-a`, role: "assistant", content: "risposta",
      timestamp: new Date(2).toISOString(), parentId: `${sessionKey}-u`,
      blocks, toolCalls: [tc], partial: true, media: ["/tmp/allegato.png"],
    },
  ]);
  return ctx.loadLocalMessages(sessionKey).filter((m) => m.role === "assistant")[0]!;
}

/** Byte grezzi delle due colonne grosse, letti fuori da ogni idratazione. */
function rawFatColumns(ctx: AppContext, id: string): { blocks: string | null; toolCalls: string | null } {
  const row = ctx.db.prepare("SELECT blocks, tool_calls FROM messages WHERE id = ?").get(id) as
    { blocks: string | null; tool_calls: string | null };
  return { blocks: row.blocks, toolCalls: row.tool_calls };
}

/** Somma dei byte passati a `JSON.parse` mentre gira `fn`. */
function bytesParsedDuring(fn: () => void): number {
  const real = JSON.parse;
  let bytes = 0;
  (JSON as { parse: typeof JSON.parse }).parse = ((text: string, reviver?: never) => {
    if (typeof text === "string") bytes += text.length;
    return real(text, reviver);
  }) as typeof JSON.parse;
  try { fn(); } finally { (JSON as { parse: typeof JSON.parse }).parse = real; }
  return bytes;
}

describe("scrivere sulla riga di un turno non idrata le due colonne grosse", () => {
  test("updateLastMessage non parsa né i blocchi né le tool call, e non ne perde un byte", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:write-lean-body";
    const msg = seedFatRow(ctx, sk);
    const prima = rawFatColumns(ctx, msg.id);

    const bytes = bytesParsedDuring(() => {
      ctx.updateLastMessage(sk, { content: "risposta più lunga", partial: undefined, streamedAt: undefined });
    });

    // Prima: `SELECT *` più un `JSON.parse` incondizionato di `tool_calls`.
    // Ora nessuna delle due colonne viene nemmeno chiesta a SQLite.
    expect(bytes).toBeLessThan(4_000);

    const dopo = rawFatColumns(ctx, msg.id);
    expect(dopo.blocks).toBe(prima.blocks);
    expect(dopo.toolCalls).toBe(prima.toolCalls);
    const riga = ctx.getMessageById(msg.id);
    expect(riga?.content).toBe("risposta più lunga");
    // `media` è l'unica colonna del corpo SENZA `COALESCE` in `updateMessage`:
    // se la lettura magra smettesse di portarla, ogni scrittura del corpo
    // cancellerebbe gli allegati del turno.
    expect(riga?.media).toEqual(["/tmp/allegato.png"]);
  });

  test("addToolCallToLastMessage parsa SOLO le tool call, e lascia i blocchi intatti", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:write-lean-add";
    const msg = seedFatRow(ctx, sk);
    const prima = rawFatColumns(ctx, msg.id);

    const nuovo: ToolCall = {
      id: "tc-nuovo", name: "Read", args: { file_path: "/x" }, status: "running",
      detail: { type: "read", filePath: "/x" }, startedAt: 3,
    };
    const bytes = bytesParsedDuring(() => { ctx.addToolCallToLastMessage(sk, nuovo); });

    // Le tool call le DEVE parsare: le riscrive. I 2 MB di blocchi no — ed è
    // quello il grosso, su ogni singolo evento di tool.
    expect(bytes).toBeLessThan(BLOCKS_FILLER.length / 4);
    expect(bytes).toBeGreaterThan(0);

    const dopo = rawFatColumns(ctx, msg.id);
    // La colonna che questo mutatore NON possiede non si muove di un byte.
    expect(dopo.blocks).toBe(prima.blocks);
    // Quella che possiede sì, e senza perdere la vecchia.
    const toolCalls = ctx.getMessageById(msg.id)?.toolCalls ?? [];
    expect(toolCalls.map((t) => t.id)).toEqual(["tc-fat", "tc-nuovo"]);
    expect(toolCalls[0]?.result).toBe(TOOL_FILLER);
  });

  test("updateToolCallResult: stessa regola, i blocchi restano dov'erano", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:write-lean-result";
    const msg = seedFatRow(ctx, sk);
    const prima = rawFatColumns(ctx, msg.id);

    const bytes = bytesParsedDuring(() => {
      ctx.updateToolCallResult(sk, "tc-fat", "finito", undefined, { endedAt: 9 });
    });
    expect(bytes).toBeLessThan(BLOCKS_FILLER.length / 4);

    expect(rawFatColumns(ctx, msg.id).blocks).toBe(prima.blocks);
    const tc = ctx.getMessageById(msg.id)?.toolCalls?.[0];
    expect(tc?.result).toBe("finito");
    expect(tc?.endedAt).toBe(9);
  });

  test("updateToolCallFields resta l'UNICO a leggere i blocchi, e li patcha davvero", async () => {
    // La `SELECT` con `blocks` è stata separata perché i due mutatori caldi non
    // ne hanno bisogno. Questo è il caso che la teneva in piedi: quando un
    // messaggio ha blocchi, chi disegna legge quelli e ignora `tool_calls` —
    // scrivere solo `tool_calls` produce una riga che nel DB dice «aspetta una
    // risposta» e a schermo continua a girare (visto il 7 agosto). Se la
    // separazione avesse portato via la colonna anche di qui, la patch sarebbe
    // partita su un `undefined`: un aggiornamento che gira e non si vede.
    const ctx = await createTestAppContext();
    const sk = "topic:write-lean-fields";
    const msg = seedFatRow(ctx, sk);

    const bytes = bytesParsedDuring(() => {
      ctx.updateToolCallFields(sk, "tc-fat", { status: "waiting_for_input" });
    });
    // Qui i 2 MB di blocchi si parsano per forza: è l'unica via che li riscrive.
    expect(bytes).toBeGreaterThan(BLOCKS_FILLER.length);

    const riga = ctx.getMessageById(msg.id)!;
    expect(riga.toolCalls?.[0]?.status).toBe("waiting_for_input");
    const bloccoTool = riga.blocks?.find((b) => b.kind === "tool");
    expect(bloccoTool?.kind === "tool" && bloccoTool.toolCall.status).toBe("waiting_for_input");
  });

  test("un turno di soli TOOL non viene scartato come vuoto (la lettura magra non lo rende invisibile)", async () => {
    // Il rischio della lettura magra: `updateLastMessage` non porta più
    // `tool_calls` sul valore di ritorno, e `discardIfEmptyTurn` decide su
    // quello. Senza la sonda in SQL, un turno interrotto DOPO una tool call ma
    // prima di una sola parola risulterebbe vuoto e verrebbe cancellato.
    const ctx = await createTestAppContext();
    const sk = "topic:write-lean-onlytools";
    ctx.saveLocalMessages(sk, [
      { id: `${sk}-u`, role: "user", content: "fai una cosa", timestamp: new Date(1).toISOString() },
    ]);
    const placeholder = ctx.createPartialMessage(sk, "assistant");
    ctx.addToolCallToLastMessage(sk, {
      id: "tc-solo", name: "Bash", args: { command: "ls" }, status: "running",
      detail: { type: "shell", command: "ls" }, startedAt: 1,
    });

    const finalized = ctx.updateLastMessage(sk, { content: "", partial: undefined, streamedAt: undefined });
    expect(ctx.discardIfEmptyTurn(sk, finalized)).toBeNull();
    expect(ctx.getMessageById(placeholder.id)).not.toBeNull();
  });

  test("un segnaposto davvero vuoto viene ancora scartato", async () => {
    const ctx = await createTestAppContext();
    const sk = "topic:write-lean-empty";
    ctx.saveLocalMessages(sk, [
      { id: `${sk}-u`, role: "user", content: "che ore sono?", timestamp: new Date(1).toISOString() },
    ]);
    const placeholder = ctx.createPartialMessage(sk, "assistant");

    const finalized = ctx.updateLastMessage(sk, { content: "", partial: undefined, streamedAt: undefined });
    expect(ctx.discardIfEmptyTurn(sk, finalized)).toBe(placeholder.id);
    expect(ctx.getMessageById(placeholder.id)).toBeNull();
  });
});
