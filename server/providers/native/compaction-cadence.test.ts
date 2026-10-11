import { describe, expect, test } from "bun:test";
import { COMPACT_AT, COMPACT_TO, compact, needsCompaction } from "./compaction";
import type { AgentMessage } from "./agent-loop";

interface Policy { compactAt: number; compactTo: number }

function simulate(policy: Policy): { compactions: number; cacheWrites: number } {
  const windowTokens = 200_000;
  const charsPerToken = 1;
  let history: AgentMessage[] = [{ role: "user", content: "initial request" }];
  let compactions = 0;
  let cacheWrites = 0;

  for (let round = 0; round < 120; round++) {
    if (needsCompaction(history, windowTokens, 0, charsPerToken, policy.compactAt)) {
      const compacted = compact(history, {
        windowTokens,
        charsPerToken,
        compactAt: policy.compactAt,
        compactTo: policy.compactTo,
      });
      history = compacted.messages;
      compactions++;
      cacheWrites += compacted.after;
    } else {
      cacheWrites += 8_000;
    }

    const tail = `round-${round}`;
    history.push(
      { role: "assistant", content: `a${tail}`.padEnd(4_000, "a") },
      { role: "user", content: `u${tail}`.padEnd(4_000, "u") },
    );
  }

  return { compactions, cacheWrites };
}

describe("native compaction cadence", () => {
  test("the calibrated policy halves compactions and cuts cache writes by at least 40%", () => {
    const oldPolicy = simulate({ compactAt: 0.75, compactTo: 0.55 });
    const newPolicy = simulate({ compactAt: COMPACT_AT, compactTo: COMPACT_TO });

    expect(newPolicy.compactions).toBeLessThanOrEqual(oldPolicy.compactions / 2);
    expect(newPolicy.cacheWrites).toBeLessThanOrEqual(oldPolicy.cacheWrites * 0.6);
  });
});
