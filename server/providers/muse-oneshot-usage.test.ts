/**
 * A Muse one-shot reads its answer AND its usage from `muse exec --json`.
 *
 * Muse 1.4.12 sends `run.usage` before the run closes; the text mode dropped
 * it, so every side call on Muse left a row with no tokens. The fixture is a
 * real capture (24/10), trimmed to the four events the one-shot reads.
 * @covers USAGE-24
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseMuseOneshotJsonl } from "./muse";

const CAPTURE = readFileSync(join(import.meta.dir, "muse", "fixtures", "meta-oneshot-usage.jsonl"), "utf8");

describe("parseMuseOneshotJsonl", () => {
  test("the closing text is the answer, run.usage the usage", () => {
    expect(parseMuseOneshotJsonl(CAPTURE)).toEqual({
      content: "ok",
      usage: { promptTokens: 58_614, completionTokens: 15, cacheReadTokens: 0, model: "muse-wonder-1.0" },
    });
  });

  test("a run that does not complete is a failure, with its reason", () => {
    const out = parseMuseOneshotJsonl(JSON.stringify({
      payload_type: "run.terminal.failed",
      payload: { kind: "run_terminal", terminal: "failed", text: "", reason: "quota exhausted" },
    }));
    expect(out.error).toBe("quota exhausted");
  });

  test("a CLI that prints plain text keeps working, without a usage", () => {
    expect(parseMuseOneshotJsonl("Titolo\n")).toEqual({ content: "Titolo" });
  });
});
