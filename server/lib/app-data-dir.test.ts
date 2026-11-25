/**
 * THE APP DATA ROOT IS THE TOPICS HOME, UNLESS A VARIABLE PINS ANOTHER ONE.
 *
 * Until change `agents-in-topics-home` a folder under the product's older name
 * won whenever it existed, so a machine that had one kept a second home for the
 * app, shared with the always-on agents. Two branches are left, and the tests
 * below are the whole rule. The fourth keeps it honest: resolving is a
 * calculation, not a boot step, so it must create nothing.
 *
 * @covers RUNTIME-19
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appDataRoots, resolveAppDataDir } from "./data-dir";
import { testTmpDir } from "../../tests/integration/helpers";

/** A home that exists on disk but holds nothing. */
function emptyHome(name: string): string {
  const home = join(testTmpDir(`app-data-${name}`), "home");
  mkdirSync(home, { recursive: true });
  return home;
}

describe("resolveAppDataDir", () => {
  test("an explicit variable wins over everything", () => {
    const home = emptyHome("explicit");
    expect(resolveAppDataDir({ env: { APP_DATA_DIR: "/pinned/root" }, home })).toBe("/pinned/root");
  });

  test("without one it is ~/.topics, whatever other folder the home already holds", () => {
    const home = emptyHome("fresh");
    mkdirSync(join(home, ".old-root", "media"), { recursive: true });
    expect(resolveAppDataDir({ env: {}, home })).toBe(join(home, ".topics"));
  });

  test("TOPICS_HOME moves it with the rest of the Topics home", () => {
    const home = emptyHome("isolated");
    expect(resolveAppDataDir({ env: { TOPICS_HOME: "/iso/home" }, home })).toBe("/iso/home");
  });

  test("resolving is idempotent and creates nothing", () => {
    const home = emptyHome("pure");
    const first = resolveAppDataDir({ env: {}, home });
    const second = resolveAppDataDir({ env: {}, home });
    expect(second).toBe(first);
    expect(existsSync(first)).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  });

  test("the allowlist roots are the live one and the Topics home, once each", () => {
    const home = emptyHome("roots");
    expect(appDataRoots({ env: {}, home })).toEqual([join(home, ".topics")]);
    expect(appDataRoots({ env: { APP_DATA_DIR: "/pinned" }, home })).toEqual(["/pinned", join(home, ".topics")]);
  });
});
