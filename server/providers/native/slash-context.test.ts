/**
 * The native runtime gets a skill invocation the way the CLI does: the user's
 * text block is exactly `/recap …`, and the context arrives as a text block of
 * its own BEFORE it, never glued in front of the command.
 *
 * No network and no turn: `sessionFor` and `driveTurn` are replaced, and the
 * history the turn would start from is read as `sendChat` leaves it.
 *
 * @covers SKILL-03
 */
import { describe, expect, test } from "bun:test";
import { NativeProvider } from "./provider";
import type { StreamHandler } from "../types";

type HistoryEntry = { role: string; content: unknown };

function harness(initial: HistoryEntry[]) {
  const provider = new NativeProvider({ type: "native" });
  const session = { history: initial.map((m) => ({ ...m })), lastUsedAt: 0, calibration: { charsPerToken: 4 } };
  let started: HistoryEntry[] | null = null;
  const internals = provider as unknown as {
    hasGlobalCoordinatorRole: () => boolean;
    sessionFor: () => typeof session;
    supersedeLiveTurn: () => Promise<void>;
    driveTurn: (sk: string, s: typeof session) => Promise<{ runId?: string }>;
  };
  internals.hasGlobalCoordinatorRole = () => false;
  internals.sessionFor = () => session;
  internals.supersedeLiveTurn = async () => {};
  internals.driveTurn = async (_sk, s) => { started = structuredClone(s.history); return {}; };
  const handler = { onTextDelta() {}, onDone() {}, onError() {} } as unknown as StreamHandler;
  return {
    send: async (message: string, slashContext?: string) => {
      await provider.sendChat("topic:native-slash", message, handler, slashContext === undefined ? undefined : { slashContext });
      return started!;
    },
  };
}

describe("native sendChat with a skill invocation", () => {
  test("the context is a block of its own, before the bare command", async () => {
    const history = await harness([]).send("/vai solo X", "<context>\nC\n</context>");
    expect(history).toEqual([
      { role: "user", content: [{ type: "text", text: "<context>\nC\n</context>" }, { type: "text", text: "/vai solo X" }] },
    ]);
  });

  test("an ordinary message is the plain string it always was", async () => {
    const history = await harness([]).send("<context>\nC\n</context>\n\nciao");
    expect(history).toEqual([{ role: "user", content: "<context>\nC\n</context>\n\nciao" }]);
  });

  test("merged into an unanswered question left by a dead turn, the command block still comes last", async () => {
    const history = await harness([{ role: "assistant", content: "a" }, { role: "user", content: "domanda rimasta" }])
      .send("/vai", "<context>C</context>");
    expect(history.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "domanda rimasta" },
        { type: "text", text: "<context>C</context>" },
        { type: "text", text: "/vai" },
      ],
    });
  });
});
