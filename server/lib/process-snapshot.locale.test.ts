/**
 * `ps` is asked in the C locale, so `lstart` always carries English month names
 * and `parseLstart` can read it.
 *
 * @covers KANBAN-75
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as capture from "./bounded-capture";
import { readStartTimes } from "./process-snapshot";

afterEach(() => { spyOn(capture, "captureWithDeadline").mockRestore(); });

describe("readStartTimes", () => {
  it("runs ps with LC_ALL=C whatever the server's own locale is", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    spyOn(capture, "captureWithDeadline").mockImplementation(async (_argv, _ms, env) => {
      seen.push(env);
      return { text: "42 Sat Oct 31 04:20:36 2026\n", exitCode: 0 };
    });
    const out = await readStartTimes([42]);
    expect(out?.get(42)).toBe("Sat Oct 31 04:20:36 2026");
    expect(seen.at(-1)?.LC_ALL).toBe("C");
  });
});
