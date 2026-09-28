/**
 * An e2e spec fakes the Tauri shell through ONE helper, and that helper sends
 * the shell's loopback proxy home.
 *
 * Why this test exists (28/09/2026): faking the shell is one assignment,
 * `window.__TAURI_INTERNALS__ = {...}` in an init script, and it turns on
 * `isTauri`. With `isTauri` on, `client/src/lib/shell/net.ts` sends every API
 * call and every WebSocket to `127.0.0.1:13333`, which on a developer Mac is
 * the loopback proxy of the REAL Topics.app, forwarding to production :3333.
 * Specs run under WebKit against the isolated test server reached the live
 * server that evening (`ref=http://localhost:13334` in its log, CORS
 * preflights answered 404, WebSocket handshakes from the test page). Three
 * specs had their own copy of the rewrite that prevents it, two did not, and
 * CI could not tell the difference: no proxy runs there.
 *
 * No behavioural assertion can catch the next one, because the suite stays
 * green while it talks to production. So the rule is on the SOURCE: outside
 * `tests/e2e/helpers/fake-tauri-shell.ts`, no code under `tests/e2e` names the
 * shell's globals. Comments may: they are how specs explain the disguise.
 *
 * @covers E2E-GATE-06
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { SHELL_PROXY_HOST } from "../e2e/helpers/fake-tauri-shell";

const E2E_DIR = join(import.meta.dir, "../e2e");
const HELPER = "helpers/fake-tauri-shell.ts";
const NET_TS = join(import.meta.dir, "../../client/src/lib/shell/net.ts");
/** The two globals `detectShell()` reads (`client/src/lib/shell/index.ts`). */
const SHELL_GLOBAL = /__TAURI(?:_INTERNALS)?__/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** Code lines only, the same cut `global-setup-no-prod-paths.test.ts` makes. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

describe("the Tauri shell is faked through one helper", () => {
  test("no spec or helper under tests/e2e names the shell's globals outside fake-tauri-shell.ts", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(E2E_DIR)) {
      const rel = relative(E2E_DIR, file);
      if (rel === HELPER) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (!isComment(line) && SHELL_GLOBAL.test(line)) offenders.push(`tests/e2e/${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      offenders,
      "These lines fake the Tauri shell by hand. A hand-made fake leaves `isTauri` on with the " +
        "network pointed at 127.0.0.1:13333, the live Topics.app on a developer Mac. " +
        `Use fakeTauriShell() from tests/e2e/${HELPER}:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("the helper rewrites the proxy address net.ts actually calls", () => {
    // If the shell's proxy moves, the helper must move with it: otherwise it
    // rewrites and blocks an address nobody calls, and the leak is back.
    const host = readFileSync(NET_TS, "utf8").match(/const DESKTOP_SERVER_HOST = ['"]([^'"]+)['"]/)?.[1];
    expect(host, "DESKTOP_SERVER_HOST not found in client/src/lib/shell/net.ts").toBeDefined();
    expect(SHELL_PROXY_HOST).toBe(host!);
  });
});
