/**
 * THE APP DATA ROOT IS RESOLVED ONCE, AND A FRESH MACHINE NEVER SEES THE OLD NAME.
 *
 * Until card 211605ee the root was `${HOME}/.openclaw` whenever no variable
 * said otherwise, in four copies of the same expression. The desktop shell
 * exports TOPICS_HOME/TOPICS_DATA_DIR/DATA_DIR and not APP_DATA_DIR, so an
 * installed Topics created `~/.openclaw/media` and `~/.openclaw/workspace` in
 * the home of somebody who never ran the product under its previous name.
 *
 * The three branches below are the whole rule. The fourth test is the one that
 * keeps it honest: resolving is a calculation, not a boot step, so it must
 * create nothing — an implementation that mkdir'd the root to check it would
 * make every caller (a CLI probe, a route, a test helper) plant the folder it
 * was only asking about.
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
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    expect(resolveAppDataDir({ env: { APP_DATA_DIR: "/pinned/root" }, home })).toBe("/pinned/root");
    expect(resolveAppDataDir({ env: { OPENCLAW_DIR: "/pinned/legacy" }, home })).toBe("/pinned/legacy");
    // APP_DATA_DIR first when both are set.
    expect(resolveAppDataDir({ env: { APP_DATA_DIR: "/a", OPENCLAW_DIR: "/b" }, home })).toBe("/a");
  });

  test("a home that already has ~/.openclaw keeps using it", () => {
    const home = emptyHome("legacy");
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    expect(resolveAppDataDir({ env: {}, home })).toBe(join(home, ".openclaw"));
  });

  test("a home without ~/.openclaw gets the root under ~/.topics", () => {
    const home = emptyHome("fresh");
    expect(resolveAppDataDir({ env: {}, home })).toBe(join(home, ".topics"));
  });

  test("TOPICS_HOME moves the fresh root with it", () => {
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

  test("both roots stay readable, whichever one is live", () => {
    const home = emptyHome("roots");
    const fresh = appDataRoots({ env: {}, home });
    expect(fresh).toContain(join(home, ".openclaw"));
    expect(fresh).toContain(join(home, ".topics"));

    mkdirSync(join(home, ".openclaw"), { recursive: true });
    const legacy = appDataRoots({ env: {}, home });
    expect(legacy[0]).toBe(join(home, ".openclaw"));
    expect(legacy).toContain(join(home, ".topics"));
    // No duplicates: the live root is one of the two, not a third entry.
    expect(new Set(legacy).size).toBe(legacy.length);
  });
});
