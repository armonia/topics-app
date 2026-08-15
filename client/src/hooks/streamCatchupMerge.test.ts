import { describe, expect, test } from "bun:test";
import { isClientGeneratedMessageId, mergeCatchupIntoPartial, shouldAdoptIntoPlaceholder } from "./streamCatchupMerge";
import type { ChatMessage, ContentBlock, ToolCall } from "../types";

// ─── Test helpers ───────────────────────────────────────────────────────────
const NOW = "2026-05-12T10:00:00.000Z";
const ID = () => "msg_stub";
const tc = (id: string, status: ToolCall["status"] = "running"): ToolCall => ({
  id,
  name: "Bash",
  args: {},
  status,
});
const txt = (s: string): ContentBlock => ({ kind: "text", text: s });
const tool = (id: string): ContentBlock => ({
  kind: "tool",
  toolCall: tc(id),
});
const partial = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "srv_42",
  role: "assistant",
  content: "",
  timestamp: NOW,
  partial: true,
  ...over,
});

describe("mergeCatchupIntoPartial", () => {
  // ── Fresh attach: no local partial yet ────────────────────────────────────
  // Covers the late-joiner case (browser refresh, second window, fresh app
  // load with a stream already in flight on the server).
  describe("no existing partial message", () => {
    test("creates a partial assistant with server-truth fields", () => {
      const msg = mergeCatchupIntoPartial(
        {
          messageId: "srv_42",
          content: "Hello, world",
          thinking: "let me think",
          toolCalls: [tc("t1")],
          blocks: [txt("Hello, world"), tool("t1")],
        },
        undefined,
        ID,
        NOW,
      );
      expect(msg.id).toBe("srv_42");
      expect(msg.role).toBe("assistant");
      expect(msg.content).toBe("Hello, world");
      expect(msg.thinking).toBe("let me think");
      expect(msg.toolCalls).toEqual([tc("t1")]);
      expect(msg.blocks?.length).toBe(2);
      expect(msg.partial).toBe(true);
    });

    test("falls back to generated id when server omits messageId", () => {
      const msg = mergeCatchupIntoPartial({ content: "x" }, undefined, ID, NOW);
      expect(msg.id).toBe("msg_stub");
      expect(msg.content).toBe("x");
    });

    test("absent toolCalls/blocks stay undefined (no synthetic [])", () => {
      const msg = mergeCatchupIntoPartial(
        { content: "x" },
        undefined,
        ID,
        NOW,
      );
      // Empty arrays would trigger the tool-rendering path in MessageBubble;
      // undefined keeps the existing text-only render.
      expect(msg.toolCalls).toBeUndefined();
      expect(msg.blocks).toBeUndefined();
    });

    test("non-partial last message (e.g. user turn) still triggers create", () => {
      const userTurn: ChatMessage = {
        id: "u1",
        role: "user",
        content: "what's 2+2",
        timestamp: NOW,
      };
      const msg = mergeCatchupIntoPartial(
        { messageId: "srv_42", content: "4" },
        userTurn,
        ID,
        NOW,
      );
      // The user turn is not a partial assistant, so we create — not update.
      // The caller appends; this fn just returns the new message.
      expect(msg.role).toBe("assistant");
      expect(msg.id).toBe("srv_42");
      expect(msg.partial).toBe(true);
    });

    test("does NOT inherit a finalized previous turn's toolCalls", () => {
      // lastMessage is the PRIOR (finalized, non-partial) assistant turn with a
      // tool card. A catchup for a new turn that omits toolCalls must create a
      // clean bubble — not bleed the previous turn's stale tool card into it.
      const prevTurn: ChatMessage = {
        id: "a_prev",
        role: "assistant",
        content: "done",
        toolCalls: [tc("t_old")],
        blocks: [tool("t_old")],
        timestamp: NOW,
      };
      const msg = mergeCatchupIntoPartial(
        { messageId: "srv_new", content: "next" },
        prevTurn,
        ID,
        NOW,
      );
      expect(msg.id).toBe("srv_new");
      expect(msg.toolCalls).toBeUndefined();
      expect(msg.blocks).toBeUndefined();
    });
  });

  // ── Update path: a partial assistant already exists ───────────────────────
  // Covers the race where a stream:tool_call event arrived on the WS BEFORE
  // catchup was queued (so we already have a partial with a tool), or a
  // previous catchup that needs refreshing.
  describe("with existing partial assistant", () => {
    test("server toolCalls override local toolCalls", () => {
      // Server says the partial has 2 tools (already wrote them to DB);
      // local only saw 1 because the second tool_call event hadn't fired
      // on this client yet. Server wins — it's the source of truth.
      const local = partial({
        content: "starting...",
        toolCalls: [tc("t1")],
      });
      const msg = mergeCatchupIntoPartial(
        {
          messageId: "srv_42",
          content: "starting... checking files",
          toolCalls: [tc("t1", "success"), tc("t2")],
        },
        local,
        ID,
        NOW,
      );
      expect(msg.toolCalls?.length).toBe(2);
      expect(msg.toolCalls?.[0].status).toBe("success");
    });

    test("missing toolCalls in payload keeps local toolCalls intact", () => {
      // CRITICAL: a stream:tool_call broadcast may arrive between the WS
      // open and the catchup payload being computed on the server. If
      // catchup blindly overwrote toolCalls with `undefined`, that tool
      // would vanish from the UI. The merge must treat undefined as
      // "server didn't carry this — keep local".
      const local = partial({ toolCalls: [tc("t1")] });
      const msg = mergeCatchupIntoPartial(
        { messageId: "srv_42", content: "partial text" },
        local,
        ID,
        NOW,
      );
      expect(msg.toolCalls).toEqual([tc("t1")]);
    });

    test("missing blocks in payload keeps local blocks intact", () => {
      const local = partial({
        blocks: [txt("Hello"), tool("t1")],
      });
      const msg = mergeCatchupIntoPartial(
        { messageId: "srv_42", content: "Hello" },
        local,
        ID,
        NOW,
      );
      expect(msg.blocks?.length).toBe(2);
    });

    test("empty-string content falls back to local content", () => {
      // The server-side ActiveStream.content is "" when a stream has been
      // registered but no text delta has arrived yet (e.g. the model is
      // still in thinking phase). If we overwrote with "" we'd wipe
      // whatever the previous catchup or initial loadHistory set.
      const local = partial({ content: "established prose" });
      const msg = mergeCatchupIntoPartial(
        { messageId: "srv_42", content: "" },
        local,
        ID,
        NOW,
      );
      expect(msg.content).toBe("established prose");
    });

    test("server content overrides local when both present", () => {
      // Server's in-memory buffer is canonical; if it's non-empty it
      // reflects everything the model has emitted up to this point.
      const local = partial({ content: "Hello" });
      const msg = mergeCatchupIntoPartial(
        { messageId: "srv_42", content: "Hello, world!" },
        local,
        ID,
        NOW,
      );
      expect(msg.content).toBe("Hello, world!");
    });

    test("adotta l'id DUREVOLE sopra un segnaposto coniato dal client", () => {
      // Il segnaposto nasce con un `msg_…` quando il server non ha annunciato
      // l'id (o quando lo ha creato `sendMessage` per l'SSE). Tenerselo vuol
      // dire che il prossimo `loadHistory` riporta indietro la stessa risposta
      // sotto il nome vero, non riconosce la bolla e la disegna DUE VOLTE.
      const local = partial({ id: "msg_1765432100000_ab12cd34e" });
      const msg = mergeCatchupIntoPartial(
        { messageId: "srv_42", content: "x" },
        local,
        ID,
        NOW,
      );
      expect(msg.id).toBe("srv_42");
    });

    test("preserves message id from local partial", () => {
      // Once a partial exists with id=srv_42 it MUST stay that id, otherwise
      // a follow-up loadHistory() (which returns srv_42 from DB) would
      // de-dup against a stub with a different id and we'd end up with two
      // assistant rows for the same turn. The merge keeps the existing id
      // by spreading the local message before applying overrides.
      const local = partial({ id: "srv_42" });
      const msg = mergeCatchupIntoPartial(
        // Server somehow sends a different id (shouldn't happen, but be
        // defensive — we always trust the local id once locked in).
        { messageId: "srv_99", content: "x" },
        local,
        ID,
        NOW,
      );
      expect(msg.id).toBe("srv_42");
    });

    test("preserves partial flag even after merge", () => {
      // The stream is still in-flight — `partial: true` must survive so
      // the renderer keeps showing the streaming indicator and the
      // SAVE_INTERVAL persistence path in the route handler can still
      // patch this row.
      const local = partial({ partial: true });
      const msg = mergeCatchupIntoPartial(
        { messageId: "srv_42", content: "x" },
        local,
        ID,
        NOW,
      );
      expect(msg.partial).toBe(true);
    });
  });

  // ── Defensive: empty payloads + unusual states ───────────────────────────
  describe("edge cases", () => {
    test("empty payload still produces a valid placeholder", () => {
      // A stream that just started (no deltas yet) emits a catchup with
      // empty content/thinking and undefined tools/blocks. We still need
      // a partial assistant in the list so subsequent stream:content_chunk
      // events have something to append to.
      const msg = mergeCatchupIntoPartial({}, undefined, ID, NOW);
      expect(msg.role).toBe("assistant");
      expect(msg.partial).toBe(true);
      expect(msg.content).toBe("");
    });

    test("only thinking, no text yet — extended thinking phase", () => {
      // Claude opus emits thinking_delta events for tens of seconds
      // before any text_delta. A late joiner during this window must
      // see the thinking buffer, not a blank assistant.
      const msg = mergeCatchupIntoPartial(
        { thinking: "deliberating..." },
        undefined,
        ID,
        NOW,
      );
      expect(msg.thinking).toBe("deliberating...");
      expect(msg.content).toBe("");
    });
  });
});

/**
 * IL RAPPORTO DEL SOTTO-AGENTE CHE SI MANGIAVA LA BOLLA VIVA.
 *
 * `server/lib/subagent-watch.ts` scrive l'uscita di un sotto-agente e la
 * trasmette come un `message:new` qualunque, a turno ancora aperto. Il ramo di
 * fusione decideva per POSIZIONE — «l'ultimo messaggio è un assistant parziale»
 * — quindi quella riga si prendeva id, testo e bandiera del turno in corso, e
 * tutto il resto della risposta finiva incollato sotto il rapporto.
 */
describe("shouldAdoptIntoPlaceholder", () => {
  const vivo = (id: string): ChatMessage => partial({ id });

  test("la riga che CHIUDE il turno si fonde: stesso id del segnaposto", () => {
    expect(shouldAdoptIntoPlaceholder({
      incomingId: "srv_42",
      incomingRole: "assistant",
      last: vivo("srv_42"),
      streamingMessageId: "srv_42",
    })).toBe(true);
  });

  test("un id DIVERSO non si fonde: è un'altra riga, si accoda", () => {
    expect(shouldAdoptIntoPlaceholder({
      incomingId: "srv_subagent_99",
      incomingRole: "assistant",
      last: vivo("srv_42"),
      streamingMessageId: "srv_42",
    })).toBe(false);
  });

  test("segnaposto ancora senza nome: la seconda rete è l'id annunciato da stream:start", () => {
    // Server che non manda `messageId`: il segnaposto resta `msg_…` e la
    // posizione è tutto ciò che si ha. Ma se sappiamo quale id sta scrivendo il
    // turno, un id diverso resta un'altra riga.
    const segnaposto = vivo("msg_1765432100000_ab12cd34e");
    expect(shouldAdoptIntoPlaceholder({
      incomingId: "srv_subagent_99",
      incomingRole: "assistant",
      last: segnaposto,
      streamingMessageId: "srv_42",
    })).toBe(false);
    expect(shouldAdoptIntoPlaceholder({
      incomingId: "srv_42",
      incomingRole: "assistant",
      last: segnaposto,
      streamingMessageId: undefined,
    })).toBe(true);
  });

  test("senza id non si fonde niente: sono le aggiunte sintetiche", () => {
    expect(shouldAdoptIntoPlaceholder({
      incomingId: undefined,
      incomingRole: "assistant",
      last: vivo("srv_42"),
      streamingMessageId: "srv_42",
    })).toBe(false);
  });

  test("un messaggio utente non tocca mai il segnaposto", () => {
    expect(shouldAdoptIntoPlaceholder({
      incomingId: "srv_u1",
      incomingRole: "user",
      last: vivo("srv_42"),
      streamingMessageId: "srv_42",
    })).toBe(false);
  });

  test("senza un parziale in coda non c'è niente in cui fondere", () => {
    const finito: ChatMessage = { id: "srv_1", role: "assistant", content: "fatto", timestamp: NOW };
    expect(shouldAdoptIntoPlaceholder({
      incomingId: "srv_2",
      incomingRole: "assistant",
      last: finito,
      streamingMessageId: undefined,
    })).toBe(false);
    expect(shouldAdoptIntoPlaceholder({
      incomingId: "srv_2",
      incomingRole: "assistant",
      last: undefined,
      streamingMessageId: undefined,
    })).toBe(false);
  });
});

describe("isClientGeneratedMessageId", () => {
  test("distingue il segnaposto locale dall'uuid del server", () => {
    expect(isClientGeneratedMessageId("msg_1765432100000_ab12cd34e")).toBe(true);
    expect(isClientGeneratedMessageId("3f6d0f1e-2b0a-4a55-9c8e-1a2b3c4d5e6f")).toBe(false);
    expect(isClientGeneratedMessageId(undefined)).toBe(false);
  });
});
