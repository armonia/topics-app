import { describe, expect, test } from "bun:test";
import { decide } from "../../server/providers/native/permissions";

const run = (command: string) => decide("bash", { command }, "auto-apply").allow;

describe("rm in auto-apply", () => {
  test("allows removing temp dirs", () => {
    expect(run("rm -rf /tmp/work-abc")).toBe(true);
    expect(run("rm -rf /var/folders/xx/T/tmp.123 /tmp/b")).toBe(true);
  });
  test("still blocks everything else", () => {
    expect(run("rm -rf /tmp/../etc")).toBe(false);
    expect(run("rm -rf ~/proj")).toBe(false);
    expect(run("rm -rf /tmp/a; rm -rf /Users/x/y")).toBe(false);
    expect(run("rm -rf /")).toBe(false);
    expect(run("rm -rf $dir")).toBe(false);
    expect(run("rm -rf /tmpfoo/x")).toBe(false);
  });
});
