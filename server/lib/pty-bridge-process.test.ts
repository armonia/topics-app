/**
 * @covers TERM-13
 *
 * Which bridge holds the socket, and since when, read from the OS. The pure
 * parts are tested on the shapes `ps` really prints; the end-to-end case, on a
 * real process holding a real socket, is in
 * `tests/integration/pty-bridge-identity.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { bridgeImplementationFromProcess, identifyBridgeProcess, parseElapsed, withBridgeProcess, type ActiveBridge } from "./pty-bridge-process";
import type { Runner } from "./live-terminals";

describe("parseElapsed: what `ps -o etime=` prints", () => {
  test("minutes and seconds", () => expect(parseElapsed("05:07")).toBe(307_000));
  test("hours", () => expect(parseElapsed("12:24:16")).toBe(((12 * 60 + 24) * 60 + 16) * 1000));
  test("days, with the padding ps puts in front", () => {
    expect(parseElapsed("   08-12:24:16")).toBe((((8 * 24 + 12) * 60 + 24) * 60 + 16) * 1000);
  });
  test("anything else is not a time", () => {
    expect(parseElapsed("")).toBeNull();
    expect(parseElapsed("Wed Oct  7 13:12:12 2026")).toBeNull();
  });
});

describe("bridgeImplementationFromProcess", () => {
  const SOCK = "--socket /tmp/topics-pty-bridge-9ec57b11.sock --parent-pid 88275";

  test("a runtime running pty-bridge.mjs is the Node bridge", () => {
    expect(bridgeImplementationFromProcess("/opt/homebrew/bin/node", `node /Users/x/server/pty-bridge.mjs ${SOCK}`)).toBe("node");
  });

  test("the pty-bridge binary is the Rust bridge, full path or the 15 characters Linux keeps", () => {
    expect(bridgeImplementationFromProcess("/Applications/Topics.app/Contents/MacOS/pty-bridge", `/Applications/Topics.app/Contents/MacOS/pty-bridge ${SOCK}`)).toBe("rust");
    expect(bridgeImplementationFromProcess("pty-bridge-univ", `/x/pty-bridge-universal-apple-darwin ${SOCK}`)).toBe("rust");
  });

  test("the socket's name alone proves nothing: both bridges have it", () => {
    expect(bridgeImplementationFromProcess("/usr/bin/python3", `python3 probe.py ${SOCK}`)).toBe("unknown");
  });
});

describe("identifyBridgeProcess, with the tools answering as they do", () => {
  const NOW = Date.parse("2026-10-16T03:00:00.000Z");
  const fake = (answers: Record<string, string>): Runner => async (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    if (!(key in answers)) throw new Error(`unexpected ${key}`);
    return answers[key];
  };

  test("skips its own pid, reads the holder's age and kind", async () => {
    const run = fake({
      "lsof -t /s.sock": "4242\n98046\n",
      "ps -p 98046 -o etime=": "08-13:47:48\n",
      "ps -p 98046 -o comm=": "/opt/homebrew/bin/node\n",
      "ps -p 98046 -o command=": "node /Users/x/server/pty-bridge.mjs --socket /s.sock\n",
    });
    const info = await identifyBridgeProcess("/s.sock", { run, selfPid: 4242, now: () => NOW, platform: "darwin" });
    expect(info).toEqual({ pid: 98046, implementation: "node", startedAt: "2026-10-07T13:12:12.000Z" });
  });

  test("nobody holding the socket is no answer, not a guess", async () => {
    const run = fake({ "lsof -t /s.sock": "" });
    expect(await identifyBridgeProcess("/s.sock", { run, platform: "darwin" })).toBeNull();
  });

  test("a tool that fails is no answer, and does not throw", async () => {
    const run: Runner = async () => { throw new Error("lsof: not found"); };
    expect(await identifyBridgeProcess("/s.sock", { run, platform: "linux" })).toBeNull();
  });

  test("on Windows the bridge is a named pipe: nothing is asked", async () => {
    const run: Runner = async () => { throw new Error("must not run"); };
    expect(await identifyBridgeProcess("\\\\.\\pipe\\topics", { run, platform: "win32" })).toBeNull();
  });
});

describe("withBridgeProcess: the pong speaks first", () => {
  const INFO = { pid: 98046, implementation: "node" as const, startedAt: "2026-10-07T13:12:12.000Z" };
  const active = (implementation: ActiveBridge["implementation"]): ActiveBridge =>
    ({ implementation, reason: "reused", path: "/s.sock", pid: null, startedAt: null });

  test("a pong that said nothing takes what the process is, and its date", () => {
    expect(withBridgeProcess(active("unknown"), INFO)).toEqual({
      implementation: "node", reason: "reused", path: "/s.sock", pid: 98046, startedAt: "2026-10-07T13:12:12.000Z",
    });
  });

  test("a pong that named itself is not overruled by what ps could not tell", () => {
    expect(withBridgeProcess(active("rust"), { ...INFO, implementation: "unknown" }).implementation).toBe("rust");
  });
});
