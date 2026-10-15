import { describe, expect, test } from "bun:test";
import { upgradeWebSocket } from "./ws-upgrade";

/** @covers NATIVE-HOST-06 */
describe("browser socket native-host hint", () => {
  test("marks the viewer when its reconnect URL names a native host", () => {
    let data: Record<string, unknown> | undefined;
    const server = { upgrade: (_request: Request, options: { data: Record<string, unknown> }) => { data = options.data; return true; } };
    const request = new Request("http://localhost/ws/browser/ctx?host=native");
    expect(upgradeWebSocket(request, "/ws/browser/ctx", server as never, null, false)).toBeUndefined();
    expect(data?.expectsNativeHost).toBe(true);
  });

  test("leaves clients without the hint on the old path", () => {
    let data: Record<string, unknown> | undefined;
    const server = { upgrade: (_request: Request, options: { data: Record<string, unknown> }) => { data = options.data; return true; } };
    const request = new Request("http://localhost/ws/browser/ctx");
    upgradeWebSocket(request, "/ws/browser/ctx", server as never, null, false);
    expect(data?.expectsNativeHost).toBe(false);
  });
});
