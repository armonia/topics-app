/**
 * `ps` is asked in the C locale, so `lstart` always carries English month names
 * and `parseLstart` can read it.
 *
 * @covers KANBAN-75
 */
import { afterAll, describe, expect, it, mock } from "bun:test";
import { captureWithDeadline } from "./bounded-capture";

const seen: Array<Record<string, string> | undefined> = [];
const realCapture = { captureWithDeadline };

mock.module("./bounded-capture", () => ({
  captureWithDeadline: async (_argv: string[], _ms: number, env?: Record<string, string>) => {
    seen.push(env);
    return { text: "42 Sat Oct 31 04:20:36 2026\n", exitCode: 0 };
  },
}));
const { readStartTimes } = await import("./process-snapshot");

afterAll(() => { mock.module("./bounded-capture", () => realCapture); });

describe("readStartTimes", () => {
  it("runs ps with LC_ALL=C whatever the server's own locale is", async () => {
    const out = await readStartTimes([42]);
    expect(out?.get(42)).toBe("Sat Oct 31 04:20:36 2026");
    expect(seen.at(-1)?.LC_ALL).toBe("C");
  });
});
