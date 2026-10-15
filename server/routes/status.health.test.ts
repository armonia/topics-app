/** @covers SYSTEM-03 */
import { afterEach, describe, expect, test } from "bun:test";
import { createStatusRouter, _setPtyBridgeHealthSocketForTest } from "./status";
import { HEALTH_SUBSYSTEMS } from "../../shared/system-health";
import type { AppContext } from "../types";
import { setKeychainRunnerForTests, type KeychainRunResult } from "../providers/native/auth";

function makeRouter() {
  const ctx = {
    db: { prepare: () => ({ get: () => ({ total: 0, active: 0 }) }) },
    wsClients: new Set(),
    activeStreams: new Map(),
    STATE_DIR: "/tmp/topics-health-test",
    json: (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }),
  } as unknown as AppContext;
  return createStatusRouter(ctx);
}

afterEach(() => _setPtyBridgeHealthSocketForTest(null));

describe("GET /api/system/health", () => {
  test("returns every subsystem and reports an actionable PTY failure", async () => {
    _setPtyBridgeHealthSocketForTest("/tmp/topics-health-missing-pty.sock");
    const router = makeRouter();
    const response = await router(new Request("http://topics/api/system/health"), new URL("http://topics/api/system/health"), "/api/system/health", "GET");
    const body = await response!.json() as { subsystems: Array<{ id: string; state: string; reason: string; params?: Record<string, string | number> }> };
    expect(body.subsystems.map(({ id }) => id)).toEqual(HEALTH_SUBSYSTEMS.map(({ id }) => id));
    expect(body.subsystems.find(({ id }) => id === "pty-bridge")).toMatchObject({
      state: "error",
      reason: "probe-failed",
    });
  });

  test.skipIf(process.platform !== "darwin")("reads the Claude login cache twice without invoking security twice", async () => {
    const oldFlag = process.env.TOPICS_CREDENTIALS_KEYCHAIN;
    let calls = 0;
    const fakeSecurity = (_cmd: string, args: string[]): KeychainRunResult => {
      calls++;
      expect(args).not.toContain("-w");
      return { status: 0, stdout: '"acct"<blob>="test-user"', stderr: "" };
    };
    process.env.TOPICS_CREDENTIALS_KEYCHAIN = "1";
    setKeychainRunnerForTests(fakeSecurity);
    try {
      const router = makeRouter();
      const read = () => router(new Request("http://topics/api/system/health"), new URL("http://topics/api/system/health"), "/api/system/health", "GET");
      await read();
      await read();
      expect(calls).toBe(1);
    } finally {
      setKeychainRunnerForTests(null);
      if (oldFlag === undefined) delete process.env.TOPICS_CREDENTIALS_KEYCHAIN;
      else process.env.TOPICS_CREDENTIALS_KEYCHAIN = oldFlag;
    }
  });
});
