/**
 * A fake credential left behind by a killed e2e job is removed before the next
 * run's server starts; anything that is not the fake stays.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakeAnthropic, removeStaleFakeAnthropic } from "../e2e/helpers/fake-anthropic-api";

const homes: string[] = [];
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "stale-fake-anthropic-"));
  homes.push(h);
  return h;
}
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

describe("removeStaleFakeAnthropic", () => {
  test("the fake left by an undo that never ran goes, the other settings stay", () => {
    const h = home();
    writeFileSync(join(h, "keep.txt"), "");
    mkdirSync(join(h, ".claude"));
    writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ env: { KEEP: "1" }, theme: "dark" }));
    installFakeAnthropic(h, "http://127.0.0.1:45678"); // its undo is never called

    removeStaleFakeAnthropic(h);

    expect(existsSync(join(h, ".claude", ".credentials.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(h, ".claude", "settings.json"), "utf8"))).toEqual({ env: { KEEP: "1" }, theme: "dark" });
  });

  test("a credential that is not the fake, and a base URL that is not loopback, are left alone", () => {
    const h = home();
    mkdirSync(join(h, ".claude"));
    const real = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-real", expiresAt: 1 } });
    writeFileSync(join(h, ".claude", ".credentials.json"), real);
    const settings = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://proxy.example.com" } });
    writeFileSync(join(h, ".claude", "settings.json"), settings);

    removeStaleFakeAnthropic(h);

    expect(readFileSync(join(h, ".claude", ".credentials.json"), "utf8")).toBe(real);
    expect(readFileSync(join(h, ".claude", "settings.json"), "utf8")).toBe(settings);
  });

  test("an empty home is not an error", () => {
    expect(() => removeStaleFakeAnthropic(home())).not.toThrow();
  });
});
