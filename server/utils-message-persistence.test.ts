/**
 * Message-row persistence isolation — regression tests for the "chat streams
 * then deletes the message" bug.
 *
 * Root cause: the shared `updateMessage` statement overwrote `content` /
 * `thinking` / `tool_calls` directly (no COALESCE), and every writer re-persisted
 * ALL of them from its own snapshot. A tool-result write (e.g. the burst a killed
 * process flushes) or a control-only update (flipping `partial` on timeout) could
 * therefore blank the streamed body. These tests pin the field-ownership contract:
 *   - a tool write NEVER touches content/thinking,
 *   - a content write NEVER touches tool_calls,
 *   - finalize / partial-only updates NEVER blank the body.
  * @covers MSGOWN-01
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase } from "./db";
import { createAppContext } from "./utils";
import { beginAsk, hasPendingAsk } from "./lib/ask-user-bridge";
import type { AppContext, Topic, ToolCall } from "./types";
import { mergeReattachedRow } from "./routes/reattachMerge";

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

const SK = "topic:persist01";

function seedTopic() {
  const now = new Date().toISOString();
  const topic: Topic = {
    id: "persist01-aaaa-bbbb-cccc-000000000001",
    name: "Persistence",
    slug: "persistence",
    parentId: null,
    links: [],
    sessionKey: SK,
    color: "#aabbcc",
    icon: "chat",
    createdAt: now,
    updatedAt: now,
    archived: false,
  };
  ctx.saveSingleTopic(topic);
}

function tool(id: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name: "Bash", args: { command: "echo hi" }, status: "running", ...over };
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "msg-persist-test-"));
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
  seedTopic();
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("message field-ownership on updateMessage", () => {
  test("a tool-result write never blanks the streamed content", () => {
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.appendToLastMessage(SK, "Ecco il risultato: ");
    ctx.addToolCallToLastMessage(SK, tool("t1"));

    // The burst a killed/draining process flushes: a late tool_result.
    ctx.updateToolCallResult(SK, "t1", "hi\n", undefined, { endedAt: Date.now() });

    const row = ctx.getMessageById(msg.id)!;
    expect(row.content).toBe("Ecco il risultato: "); // NOT blanked
    expect(row.toolCalls?.[0]?.status).toBe("success");
    expect(row.toolCalls?.[0]?.result).toBe("hi\n");
  });

  test("a content delta never blanks tool state", () => {
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.addToolCallToLastMessage(SK, tool("t2", { status: "running" }));
    ctx.appendToLastMessage(SK, "testo dopo il tool");

    const row = ctx.getMessageById(msg.id)!;
    expect(row.content).toBe("testo dopo il tool");
    expect(row.toolCalls?.length).toBe(1);
    expect(row.toolCalls?.[0]?.id).toBe("t2");
  });

  test("finalizeLastMessage preserves content and tools (never a blank bubble)", () => {
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.appendToLastMessage(SK, "risposta completa");
    ctx.addToolCallToLastMessage(SK, tool("t3"));
    ctx.updateToolCallResult(SK, "t3", "done");

    ctx.finalizeLastMessage(SK);

    const row = ctx.getMessageById(msg.id)!;
    expect(row.partial).toBeFalsy();
    expect(row.content).toBe("risposta completa");
    expect(row.toolCalls?.[0]?.result).toBe("done");
  });

  test("a control-only updateLastMessage (partial flip) does not blank body", () => {
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.appendToLastMessage(SK, "quasi finito");
    ctx.addToolCallToLastMessage(SK, tool("t4"));

    // The timeout handlers do exactly this: flip the control flags without
    // re-sending content/tools.
    ctx.updateLastMessage(SK, { partial: undefined, streamedAt: undefined });

    const row = ctx.getMessageById(msg.id)!;
    expect(row.content).toBe("quasi finito");
    expect(row.toolCalls?.[0]?.id).toBe("t4");
  });

  test("endStream marks a hung 'running' tool as interrupted, stamps endedAt, returns it", () => {
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.startStream(SK, msg.id);
    ctx.addToolCallToLastMessage(SK, tool("t6", { status: "running" }));

    // Turn dies without a result → endStream must not leave the tool spinning.
    const interrupted = ctx.endStream(SK);

    expect(interrupted.map(t => t.id)).toEqual(["t6"]);
    expect(interrupted[0]?.status).toBe("error");
    expect(typeof interrupted[0]?.endedAt).toBe("number"); // duration freezes

    const row = ctx.getMessageById(msg.id)!;
    expect(row.toolCalls?.[0]?.status).toBe("error");
    expect(typeof row.toolCalls?.[0]?.endedAt).toBe("number");
  });

  test("endStream leaves already-settled tools untouched", () => {
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.startStream(SK, msg.id);
    ctx.addToolCallToLastMessage(SK, tool("t7", { status: "running" }));
    ctx.updateToolCallResult(SK, "t7", "ok");

    const interrupted = ctx.endStream(SK);

    expect(interrupted.length).toBe(0); // nothing was still running
    const row = ctx.getMessageById(msg.id)!;
    expect(row.toolCalls?.[0]?.status).toBe("success");
    expect(row.toolCalls?.[0]?.result).toBe("ok");
  });

  test("endStream spegne anche una domanda rimasta a schermo: un pannello vivo su un turno morto non promette niente a nessuno", () => {
    // Il difetto visto su `topic:ed2070df`: `fix()` finalizzava 'running' e
    // 'pending', non `waiting_for_input`. Il turno veniva chiuso, ma il tool
    // della domanda restava in attesa — e `waiting_for_input` è lo stato che
    // rende il pannello CLICCABILE. Sullo schermo: una domanda che invita a
    // rispondere accanto al banner «Nessuna risposta ricevuta / Retry», con la
    // certezza che quel clic non sarebbe arrivato a nessuno, perché il
    // rendez-vous vive nel processo che ha appena dichiarato morto il turno.
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.startStream(SK, msg.id);
    ctx.addToolCallToLastMessage(SK, tool("t8", {
      name: "mcp__topics__ask_user_question",
      status: "waiting_for_input",
    }));
    beginAsk(SK);
    expect(hasPendingAsk(SK)).toBe(true);

    const interrupted = ctx.endStream(SK);

    expect(interrupted.map(t => t.id)).toEqual(["t8"]);
    expect(interrupted[0]?.status).toBe("error");
    expect(interrupted[0]?.error).toMatch(/domanda era ancora a schermo/i);
    expect(typeof interrupted[0]?.endedAt).toBe("number");

    const row = ctx.getMessageById(msg.id)!;
    expect(row.toolCalls?.[0]?.status).toBe("error");
    // …e l'ask è chiusa: chi fosse bloccato sul bridge fallisce pulito invece
    // di restare appeso a una risposta che non arriverà.
    expect(hasPendingAsk(SK)).toBe(false);
  });

  test("a timeout marker sets content but preserves the tool timeline", () => {
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.addToolCallToLastMessage(SK, tool("t5"));
    ctx.updateToolCallResult(SK, "t5", "ok");

    // handleHardTimeout / handleGraceExpiry: an interrupted turn with no prose
    // gets an explicit marker — never an empty row — and keeps its tools.
    ctx.updateLastMessage(SK, { content: "⚠️ Hard timeout reached", partial: undefined, streamedAt: undefined });

    const row = ctx.getMessageById(msg.id)!;
    expect(row.content).toBe("⚠️ Hard timeout reached");
    expect(row.toolCalls?.[0]?.result).toBe("ok");
  });

  test("un turno di SOLI blocchi non viene scartato come vuoto", () => {
    // La proiezione magra di updateLastMessage salta il parse di `blocks`. Se
    // facesse sparire del tutto `blocks` dal valore di ritorno, un turno che ha
    // prodotto SOLO blocchi (niente prosa, niente tool_calls) risulterebbe vuoto
    // e discardIfEmptyTurn lo cancellerebbe: perdita di dati. La colonna grezza
    // deve arrivare fino a isEmptyAssistantTurn.
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.updateLastMessage(SK, { blocks: [{ kind: "text", text: "solo un blocco" }] as any });

    // Finalize come fa il vero percorso: solo flag di controllo, contenuto vuoto.
    const finalized = ctx.updateLastMessage(SK, { content: "", partial: undefined, streamedAt: undefined });
    expect(finalized).not.toBeNull();

    const discarded = ctx.discardIfEmptyTurn(SK, finalized);
    expect(discarded).toBeNull(); // NON scartato: aveva blocchi

    const row = ctx.getMessageById(msg.id);
    expect(row).not.toBeNull(); // la riga sopravvive
    expect(row!.blocks?.length).toBe(1);
  });
});

describe("reuseHeadstoneOrCreate — il turno spontaneo riprende il cartello che lo precede", () => {
  const CARTELLO = "⚠️ Nessuna risposta: il turno si è chiuso senza produrre niente. Il tuo messaggio è ancora qui: «Riprova» lo rimanda.";

  /** The row as the failure leaves it: closed, wearing the notice, no body. */
  function seminaLapide(sk: string) {
    const riga = ctx.createPartialMessage(sk, "assistant");
    ctx.updateLastMessage(sk, {
      content: CARTELLO,
      partial: false,
      blocks: [{ kind: "error", text: "Nessuna risposta: il turno si è chiuso senza produrre niente." }],
    });
    return riga;
  }

  test("la lapide si riusa: stessa bolla, corpo pulito, turno vivo", () => {
    const sk = "topic:lapide01";
    const lapide = seminaLapide(sk);

    const ripresa = ctx.reuseHeadstoneOrCreate(sk);

    // The SAME row: it is the only way the bubble that said «no answer» can
    // become the answer under the reader's eyes — there is no «message
    // deleted» event.
    expect(ripresa.id).toBe(lapide.id);
    const dopo = ctx.getMessageById(lapide.id)!;
    expect(dopo.content).toBe("");
    expect(dopo.partial).toBeTruthy();
    expect(dopo.blocks ?? []).toEqual([]);
  });

  test("una risposta vera non si tocca: nasce una riga NUOVA", () => {
    const sk = "topic:lapide02";
    const vera = ctx.createPartialMessage(sk, "assistant");
    ctx.updateLastMessage(sk, { content: "Ecco il montaggio.", partial: false });

    const nuova = ctx.reuseHeadstoneOrCreate(sk);

    expect(nuova.id).not.toBe(vera.id);
    expect(ctx.getMessageById(vera.id)!.content).toBe("Ecco il montaggio.");
  });

  test("un turno che aveva prodotto dei tool non e' una lapide", () => {
    const sk = "topic:lapide03";
    const conTool = ctx.createPartialMessage(sk, "assistant");
    ctx.addToolCallToLastMessage(sk, tool("lap1"));
    ctx.updateLastMessage(sk, { content: CARTELLO, partial: false });

    const nuova = ctx.reuseHeadstoneOrCreate(sk);

    expect(nuova.id).not.toBe(conTool.id);
    expect(ctx.getMessageById(conTool.id)!.toolCalls?.[0]?.id).toBe("lap1");
  });

  test("su una sessione vuota crea e basta", () => {
    const creata = ctx.reuseHeadstoneOrCreate("topic:lapide04");
    expect(creata.id).toBeTruthy();
    expect(creata.partial).toBeTruthy();
  });
});

describe("reuseOrCreatePartialForReattach — reload-survival (no duplicate turn, no ghost)", () => {
  test("reuses the surviving partial row IN PLACE, keeps its body, rebuilds cleanly", () => {
    const sk = "topic:reatt01";
    const original = ctx.createPartialMessage(sk, "assistant");
    ctx.appendToLastMessage(sk, "contenuto pre-restart");
    ctx.addToolCallToLastMessage(sk, tool("rt1"));

    // Boot reattach path: continue the SAME bubble.
    const reused = ctx.reuseOrCreatePartialForReattach(sk);
    expect(reused.id).toBe(original.id); // same bubble — no duplicate, no ghost
    expect(reused.reusedBody).toBe(true); // il client saprà di dover svuotare la BOLLA

    const adottata = ctx.getMessageById(original.id)!;
    expect(adottata.partial).toBeTruthy(); // still streaming
    expect(adottata.content).toBe("contenuto pre-restart"); // il record non si svuota
    expect(adottata.toolCalls?.[0]?.id).toBe("rt1");
    expect(adottata.streamedAt).toBe(reused.streamedAt!); // ma il turno riparte da adesso

    // The replay rebuilds the same row in place.
    ctx.updateLastMessage(sk, { content: "turno ricostruito dal replay" });
    expect(ctx.getMessageById(original.id)!.content).toBe("turno ricostruito dal replay");
  });

  test("la gamba di riadozione muore prima di finalizzare: la riga resta com'era", () => {
    // Il guasto vero, letto dal DB di produzione (topic:dc2b90d0, 10 agosto):
    // riga nata alle 15:46:22.678, `streamed_at` 15:47:29.751 — l'ora di un
    // riattacco — e corpo VUOTO, `latency_ms` NULL: il finalize non è mai
    // arrivato. La riadozione aveva svuotato la riga per riusarla e la copia di
    // ciò che aveva cancellato viveva solo in RAM, dentro la richiesta che poi
    // è morta. A schermo: il messaggio dell'utente e una bolla vuota, per
    // sempre.
    //
    // La regola che questo modulo dichiara — «una riadozione non può
    // SOTTRARRE» — deve valere anche quando la riadozione non finisce. Quindi
    // l'adozione non tocca il corpo: chi ricostruisce ci scrive sopra, chi
    // muore non lascia il vuoto.
    const sk = "topic:reatt05-crash";
    const original = ctx.createPartialMessage(sk, "assistant");
    ctx.appendToLastMessage(sk, "mezz'ora di lavoro");
    ctx.addToolCallToLastMessage(sk, tool("crash1"));
    ctx.updateLastMessage(sk, { blocks: [{ kind: "text", text: "mezz'ora di lavoro" }] });

    // Il server riparte e adotta il turno sopravvissuto…
    const reused = ctx.reuseOrCreatePartialForReattach(sk);
    expect(reused.id).toBe(original.id);
    // …e qui la gamba muore: nessun replay, nessun merge, nessun finalize.

    const after = ctx.getMessageById(original.id)!;
    expect(after.content).toBe("mezz'ora di lavoro");
    expect(after.toolCalls?.[0]?.id).toBe("crash1");
    expect(after.blocks?.length).toBe(1);
    expect(after.partial).toBeTruthy(); // ancora in volo: il prossimo boot lo riprende
  });

  test("un replay MUTO non porta via il pannello: quel che c'era torna al suo posto", () => {
    // La composizione che il 4 agosto ha fatto sparire una domanda a schermo
    // sei volte di fila, una per ricarica del server: il riattacco SVUOTA la
    // riga per riusarla, ma quando lo store del broker ha la coda chiusa il
    // provider ri-consegna solo il testo finale — nessun tool. Senza il merge
    // la riga restava senza `ask_user_question`, e il pannello moriva.
    const sk = "topic:reatt04-ask";
    const original = ctx.createPartialMessage(sk, "assistant");
    ctx.appendToLastMessage(sk, "Ho una domanda per te.");
    ctx.addToolCallToLastMessage(sk, tool("ask1", {
      name: "mcp__topics__ask_user_question",
      status: "waiting_for_input",
      userInputSchema: { kind: "questions", questions: [{ question: "Quale strada?", header: "Strada", options: [{ label: "A" }, { label: "B" }] }] },
    }));

    // Quello che fa la route un attimo prima di svuotare.
    const before = ctx.db.prepare(
      "SELECT content, thinking, tool_calls, blocks FROM messages WHERE id = ?",
    ).get(original.id) as { content: string; thinking: string | null; tool_calls: string | null; blocks: string | null };
    const snapshot = {
      content: before.content, thinking: before.thinking,
      toolCallsJson: before.tool_calls, blocksJson: before.blocks,
    };

    const reused = ctx.reuseOrCreatePartialForReattach(sk);
    expect(reused.id).toBe(original.id);

    // Replay muto: solo il testo finale, nessun tool visto da questo handler.
    const merged = mergeReattachedRow(snapshot, { content: "Ho una domanda per te.", trackedTools: 0, blocks: [] });
    expect(merged.nothingNew).toBe(true);
    if (merged.toolCallsJson !== undefined) {
      ctx.db.run("UPDATE messages SET tool_calls = ? WHERE id = ?", [merged.toolCallsJson, original.id]);
    }
    ctx.updateLastMessage(sk, { content: merged.content });

    const after = ctx.getMessageById(original.id)!;
    expect(after.content).toBe("Ho una domanda per te.");
    expect(after.toolCalls?.[0]?.id).toBe("ask1");
    expect(after.toolCalls?.[0]?.status).toBe("waiting_for_input");
    // Lo schema della domanda è quello che fa comparire il pannello: se si
    // perde lui, resta una riga grigia che non si può rispondere.
    expect((after.toolCalls?.[0] as { userInputSchema?: unknown })?.userInputSchema).toBeTruthy();
  });

  test("creates a FRESH row when nothing survived (last message already finalized)", () => {
    const sk = "topic:reatt02";
    const done = ctx.createPartialMessage(sk, "assistant");
    ctx.appendToLastMessage(sk, "completo");
    ctx.finalizeLastMessage(sk);

    const fresh = ctx.reuseOrCreatePartialForReattach(sk);
    expect(fresh.id).not.toBe(done.id); // new bubble
    expect(ctx.getMessageById(fresh.id)!.partial).toBeTruthy();
    expect(ctx.getMessageById(done.id)!.content).toBe("completo"); // the finalized turn is untouched
  });

  test("creates a FRESH row on an empty session (no last message)", () => {
    const sk = "topic:reatt03-empty";
    const fresh = ctx.reuseOrCreatePartialForReattach(sk);
    expect(ctx.getMessageById(fresh.id)!.partial).toBeTruthy();
    expect(ctx.getMessageById(fresh.id)!.content).toBe("");
  });
});

afterAll(() => {
  if (DATA_DIR_PRIMA === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = DATA_DIR_PRIMA;
});
