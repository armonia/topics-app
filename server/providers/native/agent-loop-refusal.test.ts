/**
 * @covers CHAT-INT-01
 *
 * THE REFUSAL THAT STAYED INVISIBLE. The API had refused the turn and the
 * server had written the verdict, but it was block 19 of 19 after a tool-call
 * stack where nobody scrolls. The banner above the composer stayed off.
 *
 * The missing link was `cause`: the banner renders only error blocks carrying
 * one, and `stream:end` includes `stopCause` only when `endInfo.cause` exists.
 * A refusal returned only `end: "refusal"`, leaving no banner live or after a
 * reload.
 *
 * These tests cover the source of the cause. Downstream tests cover the banner
 * and the explanatory sentence.
 */
import { describe, test, expect } from "bun:test";
import { roundEnd } from "./agent-loop";
import { STOP_CAUSES } from "../../../shared/ws-outbound";

describe("roundEnd · un rifiuto porta la sua causa", () => {
  test("il rifiuto dichiara ANCHE chi ha chiuso il turno, non solo cosa e' successo", () => {
    const out = roundEnd("refusal", 0, 0, null);
    expect(out.end).toBe("refusal");
    // `cause` is the missing link: without it there is no banner or stopCause.
    expect(out.cause).toBe("refusal");
  });

  test("la causa e' una del vocabolario del filo, o il broadcast viene scartato", () => {
    // A `stopCause` outside `STOP_CAUSES` fails `stream:end` validation. The
    // client then misses the end event and leaves the chat running forever.
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
    // The real turn had already used tools. The tool branch must not suppress
    // the refusal verdict.
    const out = roundEnd("refusal", 6, 18, null);
    expect(out.end).toBe("refusal");
    expect(out.cause).toBe("refusal");
  });

  test("le altre fini NON diventano rifiuti", () => {
    expect(roundEnd("end_turn", 0, 1, null).end).toBe("end_turn");
    expect(roundEnd("max_tokens", 0, 1, null).end).toBe("max_tokens");
    // `max_tokens` deliberately has no cause: it is a length limit, not an
    // attributed termination.
    expect(roundEnd("max_tokens", 0, 1, null).cause).toBeUndefined();
  });
});
