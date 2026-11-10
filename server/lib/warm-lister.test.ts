/**
 * The warm lister behind the PC's process list: one child reused, idle stop, timeout.
 *
 * @covers HUBBR-21
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createWarmLister, type WarmLister } from "./warm-lister";

// A stand-in for the PowerShell loop: one listing (with its own pid, to prove reuse) per line read.
const LOOP = ["sh", "-c", "while read -r _; do echo \"pid $$\"; echo row; echo __END__; done"];

let lister: WarmLister | null = null;
afterEach(() => { lister?.stop(); lister = null; });

describe("createWarmLister", () => {
  test("answers each request with the text before the marker, from ONE child", async () => {
    lister = createWarmLister({ argv: LOOP, endMarker: "__END__" });
    const a = await lister.read();
    const b = await lister.read();
    expect(a).toMatch(/^pid \d+\nrow\n$/);
    expect(b).toBe(a);
    expect(lister.running()).toBe(true);
  });

  test("concurrent requests are served in order, each with its own answer", async () => {
    lister = createWarmLister({ argv: LOOP, endMarker: "__END__" });
    const all = await Promise.all([lister.read(), lister.read(), lister.read()]);
    expect(all.every((t) => t.endsWith("row\n"))).toBe(true);
  });

  test("stops after the idle time and starts a new child on the next request", async () => {
    lister = createWarmLister({ argv: LOOP, endMarker: "__END__", idleMs: 50 });
    const first = await lister.read();
    await Bun.sleep(150);
    expect(lister.running()).toBe(false);
    const second = await lister.read();
    expect(second).not.toBe(first);
  });

  test("a child that never answers is killed at the timeout and the next request recovers", async () => {
    lister = createWarmLister({ argv: ["sh", "-c", "while read -r _; do :; done"], endMarker: "__END__", timeoutMs: 100 });
    await expect(lister.read()).rejects.toThrow("timed out");
    expect(lister.running()).toBe(false);
  });

  test("a child that exits rejects the request in flight", async () => {
    lister = createWarmLister({ argv: ["sh", "-c", "read -r _; exit 0"], endMarker: "__END__", timeoutMs: 2_000 });
    await expect(lister.read()).rejects.toThrow("exited");
  });
});
