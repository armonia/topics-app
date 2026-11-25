/**
 * The pieces Codex and Muse share through `exec-turn.ts`, driven through BOTH
 * providers: a regression in a shared helper must turn both suites red, not
 * only the one that happened to cover it.
 *
 * Wait and abort use a stand-in child (an EventEmitter with `kill`), so they run
 * anywhere. The one-shot completion needs a real process: those cases use a fake
 * executable with a shebang and are skipped on Windows.
 *
 * @covers CHAT-QUEUE-07, MUSE-03
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { _resetCodexBinCache } from "../lib/codex-bin";
import { _resetMuseBinCache } from "../lib/muse-bin";
import { CodexProvider } from "./codex";
import { KILL_GRACE_MS } from "./exec-turn";
import { MuseProvider } from "./muse";
import type { StreamHandler } from "./types";

type Child = EventEmitter & { kill: (sig?: string) => boolean; signals: string[]; exitCode: number | null; signalCode: string | null };

function fakeChild(): Child {
  const child = new EventEmitter() as Child;
  child.signals = [];
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (sig?: string) => { child.signals.push(sig ?? "SIGTERM"); return true; };
  return child;
}

function recorder() {
  const events: string[] = [];
  const handler = {
    onTextDelta: () => {},
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: () => { events.push("done"); },
    onError: (e: string) => { events.push(`error:${e}`); },
    onAborted: () => { events.push("aborted"); },
  } as StreamHandler;
  return { handler, events };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

let root: string;
const previous = { codex: process.env.CODEX_BIN, muse: process.env.MUSE_BIN };

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "exec-turn-test-")));
  // Hangs (timeout case), or fails with a stderr line when the prompt asks for it.
  const body = `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
import { existsSync, readFileSync, statSync } from 'fs';
// The prompt reaches the child on stdin (Codex) or in a file named in argv (Muse).
const fromFiles = process.argv.slice(2).filter((a) => existsSync(a) && statSync(a).isFile()).map((a) => readFileSync(a, 'utf8')).join(' ');
// Stdin is read only without a prompt file: Muse never closes it.
const text = fromFiles || (await Bun.stdin.text());
if (text.includes('fail')) { console.error('boom-from-stderr'); process.exit(3); }
// A child the deadline failed to kill must not keep the test run alive.
setTimeout(() => process.exit(0), 8000);
setInterval(() => {}, 1000);
`;
  for (const bin of ["fake-codex", "fake-muse"]) writeFileSync(join(root, bin), body, { mode: 0o700 });
  process.env.CODEX_BIN = join(root, "fake-codex");
  process.env.MUSE_BIN = join(root, "fake-muse");
  _resetCodexBinCache();
  _resetMuseBinCache();
});

afterAll(() => {
  if (previous.codex === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous.codex;
  if (previous.muse === undefined) delete process.env.MUSE_BIN; else process.env.MUSE_BIN = previous.muse;
  _resetCodexBinCache();
  _resetMuseBinCache();
  rmSync(root, { recursive: true, force: true });
});


const providers = [
  { name: "codex", runner: "runCodexTurn", make: () => new CodexProvider({ type: "codex" }) },
  { name: "muse", runner: "runMuseTurn", make: () => new MuseProvider({ type: "muse" }) },
];

describe.each(providers)("exec-turn shared by $name", ({ name, runner, make }) => {
  test("a send waits for the dying previous child and starts nothing before its close", async () => {
    const provider = make() as any;
    const key = `topic:${name}-wait`;
    const previous = fakeChild();
    provider.activeChildren.set(key, previous);
    const started: string[] = [];
    provider[runner] = () => { started.push(key); };
    const sent = recorder();

    const send = provider.sendChat(key, "send now", sent.handler);
    await settle();
    expect(started).toEqual([]);
    expect(provider.activeChildren.get(key)).toBe(previous);

    provider.activeChildren.delete(key);
    previous.emit("close", 130);
    await send;
    expect(started).toEqual([key]);
    expect(provider.waitingSends.has(key)).toBe(false);
  });

  test("a Stop while the send waits cancels it: nothing is written", async () => {
    const provider = make() as any;
    const key = `topic:${name}-wait-stop`;
    const previous = fakeChild();
    provider.activeChildren.set(key, previous);
    const started: string[] = [];
    provider[runner] = () => { started.push(key); };
    const sent = recorder();

    const send = provider.sendChat(key, "send now", sent.handler);
    await settle();
    await provider.abort(key);
    expect(await send).toEqual({ runId: undefined, notSent: true });
    provider.activeChildren.delete(key);
    previous.emit("close", 130);
    await settle();
    expect(started).toEqual([]);
    expect(sent.events).toEqual([]);
  });

  test("abort marks the turn aborted, sends SIGINT, then SIGKILL after the grace window", async () => {
    const provider = make() as any;
    const key = `topic:${name}-abort`;
    const child = fakeChild();
    provider.activeChildren.set(key, child);
    const state = { aborted: false };
    provider.sessionState.set(key, state);

    await provider.abort(key);
    expect(state.aborted).toBe(true);
    expect(child.signals).toEqual(["SIGINT"]);

    await new Promise((r) => setTimeout(r, KILL_GRACE_MS + 200));
    expect(child.signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  test("abort of a child that closed in the grace window does not SIGKILL it", async () => {
    const provider = make() as any;
    const key = `topic:${name}-abort-closed`;
    const child = fakeChild();
    provider.activeChildren.set(key, child);

    await provider.abort(key);
    provider.activeChildren.delete(key);
    await new Promise((r) => setTimeout(r, KILL_GRACE_MS + 200));
    expect(child.signals).toEqual(["SIGINT"]);
  });
});

const makeWithRoot = [
  { name: "codex", make: () => new CodexProvider({ type: "codex", defaultWorkspace: root }) },
  { name: "muse", make: () => new MuseProvider({ type: "muse", defaultWorkspace: root }) },
];

describe.skipIf(process.platform === "win32")("exec-turn one-shot completion (fake executables)", () => {
  describe.each(makeWithRoot)("$name", ({ make }) => {
    test("the deadline kills a hung completion and rejects as timed out", async () => {
      const started = Date.now();
      await expect(make().complete([{ role: "user", content: "hang" }], { isolated: true, timeoutMs: 1000 })).rejects.toThrow("timed out");
      expect(Date.now() - started).toBeLessThan(KILL_GRACE_MS + 1500);
    });

    test("a failing completion logs the child's stderr", async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await make().complete([{ role: "user", content: "fail" }], { isolated: true, timeoutMs: 5000 });
        expect(result.error).toBe("exit 3");
        expect(warn.mock.calls.flat().join(" ")).toContain("boom-from-stderr");
      } finally {
        warn.mockRestore();
      }
    });
  });
});
