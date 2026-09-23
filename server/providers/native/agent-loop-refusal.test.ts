/**
 * THE REFUSAL NOBODY SAW — reported 21/09 on topic:a5c4a915.
 *
 * "It's stuck, I see no feedback." The chat wasn't stuck: the API had
 * refused the turn ("violative cyber content") and the server had
 * written the verdict. The verdict, though, was the 19th block of 19,
 * behind a pile of tool calls, where nobody scrolls — and the amber
 * banner above the composer, which exists exactly for this, didn't light
 * up.
 *
 * THE MISSING LINK, in a single chain: the banner only renders `error`
 * blocks that carry a `cause` (see `interruptedTurnOf`), and `stream:end`
 * puts `stopCause` on the wire only if `endInfo.cause` exists. A refusal
 * came back with just `end: "refusal"`: no cause, no banner, neither live
 * nor after a reload.
 *
 * These tests look at the SOURCE of the cause. Further downstream are
 * the banner tests (`client/src/components/Chat/turnError.test.ts`) and
 * the sentence tests (`server/lib/cancelled-notice.test.ts`).
 */
import { describe, test, expect } from "bun:test";
import { roundEnd } from "./agent-loop";
import { STOP_CAUSES } from "../../../shared/ws-outbound";

describe("roundEnd · un rifiuto porta la sua causa", () => {
  test("il rifiuto dichiara ANCHE chi ha chiuso il turno, non solo cosa e' successo", () => {
    const out = roundEnd("refusal", 0, 0, null);
    expect(out.end).toBe("refusal");
    // `cause` is the missing link: without it, no banner and no stopCause.
    expect(out.cause).toBe("refusal");
  });

  test("la causa e' una del vocabolario del filo, o il broadcast viene scartato", () => {
    // A `stopCause` outside `STOP_CAUSES` fails `stream:end` validation:
    // the client never gets the end of the turn and the chat stays
    // "running" forever. It's the fault documented next to that list, and
    // this test is why it can't come back.
    expect(STOP_CAUSES).toContain(roundEnd("refusal", 0, 0, null).cause as never);
  });

  test("la spiegazione dell'API viaggia col verdetto: e' l'unica parte utile", () => {
    const out = roundEnd("refusal", 0, 0, {
      type: "refusal",
      explanation: "violative cyber content",
    } as never);
    expect(out.detail ?? "").toContain("violative cyber content");
  });

  test("un rifiuto CON lavoro gia' fatto resta un rifiuto", () => {
    // The real case: the turn had already run tools before the no. If the
    // tool branch won here, the verdict would come back silent.
    const out = roundEnd("refusal", 6, 18, null);
    expect(out.end).toBe("refusal");
    expect(out.cause).toBe("refusal");
  });

  test("le altre fini NON diventano rifiuti", () => {
    expect(roundEnd("end_turn", 0, 1, null).end).toBe("end_turn");
    expect(roundEnd("max_tokens", 0, 1, null).end).toBe("max_tokens");
    // `max_tokens` has no dedicated cause: it's a length limit, not an
    // end attributed to someone.
    expect(roundEnd("max_tokens", 0, 1, null).cause).toBeUndefined();
  });
});
