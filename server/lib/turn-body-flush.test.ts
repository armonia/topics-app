/**
 * THE ROW THE CONFIRMATION IS PAINTED ON IS WRITTEN LATE, AND "LATE" WAS READ
 * AS "NOBODY IS THERE".
 *
 * Nothing here is mocked: the real throttle (`block-persist-throttle`), the
 * real writer (`turn-body-persist`) and the real reader (`findWaitingToolRow`)
 * are driven the way a turn drives them - one tool block, then another - and
 * the row is whatever the writer actually wrote. Faking the row is precisely
 * how the existing gate tests missed this: each of them builds a row that
 * already contains the tool.
 *
 * The regression it watches: a `send_mail` that is not the FIRST tool of its
 * turn rides the deferred write, so at the instant the gate reads the database
 * the row still shows the tool before it - and the send was refused outright
 * with "no visible tool row to ask on: nobody could confirm".
 * @covers OUTBOUND-03
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ContentBlock, StoredMessage } from "../types";
import { createTurnBodyPersist } from "./turn-body-persist";
import { registerTurnBodyFlush, flushTurnBody, _resetTurnBodyFlushers } from "./turn-body-flush";
import { confirmOutbound, findWaitingToolRow, type OutboundGateDeps } from "./outbound-gate";
import { cancelAsk } from "./ask-user-bridge";
import { _resetRoutedAsks } from "../services/board-ask-routing";

afterEach(() => { _resetTurnBodyFlushers(); _resetRoutedAsks(); });

/**
 * A payload size that makes the throttle wait as LONG AS IT CAN.
 *
 * The delay is `lastSize / 512` ms, clamped to [1s, 15s]: past ~7.7 MB it
 * saturates at the maximum. The size is declared by the caller and never
 * measured from the blocks, so this is the real fifteen-second case without
 * eight megabytes of fixture.
 */
const MAX_DELAY_BYTES = 8_000_000;

const toolBlock = (id: string, name: string): ContentBlock =>
  ({ kind: "tool", toolCall: { id, name, args: {}, status: "running" } });

/** A turn that writes its body to a row, as `routes/chat.ts` builds it. */
function liveTurn(sessionKey: string) {
  const blocks: ContentBlock[] = [];
  let row: { tool_calls: string | null; blocks: string | null } = { tool_calls: "[]", blocks: null };
  const persist = createTurnBodyPersist({
    sessionKey,
    // The real row keeps `tool_calls` empty when it has blocks: that is what
    // `toolColumnWriteMode` does on every modern write, and it is why the
    // blocks column is the only carrier the gate can read.
    updateLastMessage: (_key: string, updates: Partial<StoredMessage>) => {
      row = { tool_calls: "[]", blocks: JSON.stringify(updates.blocks ?? []) };
    },
    blocks,
    content: () => "",
    thinking: () => "",
    trackedTools: () => blocks.length,
    reattachSnapshot: () => null,
  });
  return {
    persist,
    row: () => row,
    /** One tool announced, exactly as `appendToolBlock` does it. */
    announce(id: string, name: string, sizeBytes: number) {
      blocks.push(toolBlock(id, name));
      persist.request(false, sizeBytes);
    },
  };
}

describe("la riga di un turno vivo si fa scrivere PRIMA di leggerla", () => {
  test("il secondo tool di un turno non e' ancora sulla riga, e il flush ce lo mette", () => {
    const sessionKey = "topic:flush01";
    const turn = liveTurn(sessionKey);
    // First write of the turn: immediate, and it sets the budget from which the
    // next delay is computed.
    turn.announce("t1", "read_file", MAX_DELAY_BYTES);
    expect(findWaitingToolRow(turn.row(), "mcp__topics__send_mail")).toBeNull();

    // The tool that stops to ask. It grows the payload by one byte, so the
    // throttle defers it for the full fifteen seconds.
    turn.announce("t2", "send_mail", MAX_DELAY_BYTES + 1);
    expect(findWaitingToolRow(turn.row(), "mcp__topics__send_mail")).toBeNull();

    const release = registerTurnBodyFlush(sessionKey, () => turn.persist.flush());
    expect(flushTurnBody(sessionKey)).toBe(true);
    expect(findWaitingToolRow(turn.row(), "mcp__topics__send_mail")).toEqual({
      toolCallId: "t2",
      alreadyWaiting: false,
    });
    release();
    turn.persist.dispose();
  });

  test("senza turno vivo non c'e' niente da forzare, e lo dice", () => {
    // A finalized row is already whole: the gate reads it as it is, and the
    // absence of a flusher is not an error.
    expect(flushTurnBody("topic:nessuno")).toBe(false);
  });

  test("la conferma NON viene rifiutata per una scrittura in ritardo", async () => {
    // The consequence the verifier measured: in a chat session (no card) the
    // gate answered `refused` - "nobody could confirm" - and the MCP tool
    // raises on a refusal, so there was no second leg for a row that was one
    // second away.
    const sessionKey = "chat:flush02";
    const turn = liveTurn(sessionKey);
    turn.announce("t1", "read_file", MAX_DELAY_BYTES);
    turn.announce("t2", "send_mail", MAX_DELAY_BYTES + 1);
    const release = registerTurnBodyFlush(sessionKey, () => turn.persist.flush());

    const painted: string[] = [];
    const deps: OutboundGateDeps = {
      db: { prepare: () => ({ get: () => undefined }) } as never,
      comment: () => true,
      deliver: () => true,
      lastToolRow: (key) => { flushTurnBody(key); return turn.row(); },
      paint: (args) => { painted.push(args.toolCallId); },
    };
    const outcome = await confirmOutbound(deps, {
      sessionKey,
      toolName: "mcp__topics__send_mail",
      header: "Posta",
      summary: "Invio una mail dall'account primo.",
      digest: "abcd1234",
      legMs: 120,
    });
    expect(outcome.state).toBe("pending");
    expect(painted).toEqual(["t2"]);
    cancelAsk(sessionKey, "fine del test");
    release();
    turn.persist.dispose();
  });
});
