/**
 * The resume against cuts that came from outside the turn: an API that
 * stopped answering (card e30f35e4) and the ai-bridge daemon dying under its
 * children (card 51fb9359). Split from `ripresa-boot.test.ts`, which holds the
 * rest of the rule and the sweep against a database.
 *
 * @covers RESUME-01, RESUME-04
 */
import { describe, expect, test } from "bun:test";
import { resumeCapNotice, resumeVerdict } from "./ripresa-boot";
import type { ContentBlock } from "../types";

type Row = Parameters<typeof resumeVerdict>[0];

const NOW = Date.UTC(2026, 8, 25, 3, 0, 0);
const prose: ContentBlock = { kind: "text", text: "stavo misurando" };
const base: Row = {
  sessionKey: "topic:3019832f",
  ruolo: "assistant",
  blocks: null,
  timestampMs: NOW - 60_000,
  attempts: 0,
};

/**
 * Cuts that came from outside the turn. Topic 3019832f on 25/09: the API went
 * dark at 02:00Z, the claude-code watchdog closed the turn at 02:30Z with a
 * bare text and no cause, and every sweep from 02:35 to 03:20 read it as
 * "no" until a person resent by hand, 52 minutes later. And the same day at
 * 12:57 the ai-bridge daemon died under four live CLIs, whose turns ended
 * "as died" and stayed there.
 */
describe("an outage outside the turn is resumed", () => {
  const tool: ContentBlock = { kind: "tool", toolCall: { id: "toolu_1", name: "Bash", args: {}, status: "success" } } as ContentBlock;

  test("the watchdog's bare text on the real row (5e92d06e) is a cut of ours", () => {
    const row: Row = {
      ...base,
      blocks: [tool, tool, { kind: "error", text: "Nessuna attività dal modello per 30 minuti. Turno terminato." } as ContentBlock],
    };
    expect(resumeVerdict(row, NOW)).toBe("resend");
  });

  test("a turn the API left unanswered, and one whose daemon died, are resent", () => {
    for (const cause of ["api-unavailable", "broker-died"]) {
      const cut = { kind: "error", text: "una frase qualunque", cause } as unknown as ContentBlock;
      expect(resumeVerdict({ ...base, blocks: [prose, cut] }, NOW), cause).toBe("resend");
    }
  });

  /**
   * A wake (a background task or a Monitor delivering) opens a row of its own
   * under a person's message that was already answered. The resend is that
   * message: resent, the agent ran it a second time, a paid turn and every
   * effect again (the blackout of 25/09 met a wake on 4e5e2d76, fb360b27).
   */
  test("a woken turn cut by an outage, or by a stall, does not resend the person's message", () => {
    const wake = { kind: "woken", label: "bjppuaycc" } as ContentBlock;
    for (const cause of ["api-unavailable", "broker-died", "watchdog"]) {
      const cut = { kind: "error", text: "una frase qualunque", cause } as unknown as ContentBlock;
      expect(resumeVerdict({ ...base, blocks: [wake, { kind: "text", text: "Request timed out" }, cut] }, NOW), cause).toBe("no");
    }
  });

  test("a child that died on its own, with the daemon alive, stays where it is", () => {
    const died = { kind: "error", text: "Process died unexpectedly", cause: "process-died" } as ContentBlock;
    expect(resumeVerdict({ ...base, blocks: [prose, died] }, NOW)).toBe("no");
  });

  test("the cap notice names the outage that cut the last link, not an unknown cause", () => {
    expect(resumeCapNotice({ restarted: false, cause: "api-unavailable" })).toMatch(/l'API non rispondeva/);
    expect(resumeCapNotice({ restarted: false, cause: "broker-died" })).toMatch(/ospitava l'agente/);
  });
});
