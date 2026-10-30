/**
 * A CHANNEL HANDLER THAT THROWS MUST NOT FREEZE THE MESSAGES BEHIND IT.
 *
 * The JS `Channel` that Tauri ships hands messages to `onmessage` in order,
 * through a counter. Up to tauri 2.12.2 a handler that threw left the counter
 * where it was: every later message was parked in a queue nobody drained again,
 * and from the page it looked like a stream that stopped half way with no error
 * (fixed in 2.12.3, tauri-apps/tauri#16244).
 *
 * WHAT IS UNDER TEST. Topics instantiates no `Channel` today (no
 * `@tauri-apps/api`, no `ipc::Channel` in the shell): what it ships is the
 * `tauri` crate, whose `scripts/bundle.global.js` carries the class. So this
 * runs THAT file, taken from the crate version `Cargo.lock` resolved, and not a
 * copy of the logic: the next version jump is judged by the code it brings. The
 * day a stream does go through a `Channel`, the guarantee is already pinned.
 *
 * Il file `bundle.global.js` viene iniettato nella pagina solo con
 * `app.withGlobalTauri = true`, che Topics non imposta; quindi il test prova
 * la classe, non che la pagina la usi; quando si adotta `@tauri-apps/api`,
 * il test va esteso.
 *
 * WHERE THE SOURCE COMES FROM. `$CARGO_HOME/registry/src/<index>/tauri-<version>/`,
 * which `cargo check` has filled by the time the CI `tauri` job gets here;
 * locally `cargo fetch` does it. `TAURI_CRATE_DIR` points at another copy: run
 * it on a 2.12.2 or older tree and this file must go red, which is how its bite
 * was measured. It lives outside the unit shard roots on purpose: those jobs
 * have no cargo registry, and a test that passes when its subject is missing
 * proves nothing.
 *
 * @covers RELEASE-08
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const ROOT = join(import.meta.dir, "../..");

/** The crate directory: the override, or the version the lockfile resolved. */
function tauriCrateDir(): string {
  if (process.env.TAURI_CRATE_DIR) return process.env.TAURI_CRATE_DIR;
  const lock = readFileSync(join(ROOT, "desktop-tauri/src-tauri/Cargo.lock"), "utf8");
  const version = /\[\[package\]\]\r?\nname = "tauri"\r?\nversion = "([^"]+)"/.exec(lock)?.[1];
  if (!version) throw new Error("Cargo.lock has no `tauri` package");
  const registry = join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "registry/src");
  const found = (existsSync(registry) ? readdirSync(registry) : [])
    .map((index) => join(registry, index, `tauri-${version}`))
    .find((dir) => existsSync(join(dir, "scripts/bundle.global.js")));
  if (!found) throw new Error(`tauri ${version} is not in ${registry}: run \`cargo fetch\` in desktop-tauri/src-tauri, or set TAURI_CRATE_DIR`);
  return found;
}

interface Channel<T> {
  id: number;
  onmessage: (message: T) => void;
}

/**
 * The bundle evaluated in a page that is only a `window`. `transformCallback`
 * is the one door the Channel uses to receive from Rust, so `deliver` plays
 * Rust. Errors thrown out of a delivery are what the browser would log as
 * uncaught: they are collected, not swallowed, so a test can tell "reported"
 * from "lost".
 */
function page() {
  const callbacks: Array<(payload: unknown) => void> = [];
  const reported: unknown[] = [];
  const window: Record<string, unknown> = {
    __TAURI_INTERNALS__: {
      transformCallback: (cb: (payload: unknown) => void) => callbacks.push(cb) - 1,
      unregisterCallback: () => {},
    },
  };
  // The fixed class reports through a microtask that throws; run it at once and
  // record what it threw, as the browser's uncaught-error hook would.
  const runAtOnce = (fn: () => void) => {
    try { fn(); } catch (e) { reported.push(e); }
  };
  vm.runInNewContext(readFileSync(join(tauriCrateDir(), "scripts/bundle.global.js"), "utf8"), { window, queueMicrotask: runAtOnce });
  const Channel = (window.__TAURI__ as { core: { Channel: new () => Channel<string> } }).core.Channel;
  const deliver = (channel: Channel<string>, index: number, message: string) => {
    try { callbacks[channel.id]({ index, message }); } catch (e) { reported.push(e); }
  };
  return { Channel, deliver, reported };
}

describe("tauri Channel: onmessage that throws", () => {
  test("the message after the one that threw is still delivered", () => {
    const { Channel, deliver, reported } = page();
    const seen: string[] = [];
    const channel = new Channel();
    channel.onmessage = (m) => {
      seen.push(m);
      if (m === "a") throw new Error("handler blew up on a");
    };
    deliver(channel, 0, "a");
    deliver(channel, 1, "b");
    deliver(channel, 2, "c");
    expect(seen).toEqual(["a", "b", "c"]);
    expect(reported.length, "the error is reported once, not swallowed").toBe(1);
  });

  test("a throw in the middle of a drain does not strand what was parked behind it", () => {
    const { Channel, deliver } = page();
    const seen: string[] = [];
    const channel = new Channel();
    channel.onmessage = (m) => {
      seen.push(m);
      if (m === "b") throw new Error("handler blew up on b");
    };
    // "c" and "d" arrive before "b": they wait. "b" lands and throws, and the
    // drain that follows it must still hand over "c" and "d".
    deliver(channel, 0, "a");
    deliver(channel, 2, "c");
    deliver(channel, 3, "d");
    deliver(channel, 1, "b");
    expect(seen).toEqual(["a", "b", "c", "d"]);
  });

  test("a handler that never throws still gets every message in order", () => {
    const { Channel, deliver, reported } = page();
    const seen: string[] = [];
    const channel = new Channel();
    channel.onmessage = (m) => { seen.push(m); };
    deliver(channel, 1, "b");
    deliver(channel, 0, "a");
    deliver(channel, 2, "c");
    expect(seen).toEqual(["a", "b", "c"]);
    expect(reported).toEqual([]);
  });
});
