/**
 * @covers KANBAN-23
 *
 * A card preview is started by the live server and must not inherit the
 * settings that server owns: an inherited tunnel port made every preview die
 * on «Is port 3434 in use?», and an inherited socket or workspace would point
 * the preview at live state.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { previewServerEnv } from "./preview-env";

const LIVE = {
  PATH: "/usr/bin",
  HOME: "/Users/someone",
  TOPICS_TUNNEL_PORT: "3434",
  TOPICS_TUNNEL_HTTP_PORT: "3435",
  TOPICS_MODEL_PROXY_PORT: "3391",
  TOPICS_EXTERNAL_PROXY_PORT: "3350",
  TOPICS_CDP_PORT: "19222",
  TOPICS_PTY_SOCKET: "/tmp/live-pty.sock",
  TOPICS_AI_BRIDGE_SOCKET: "/tmp/live-ai.sock",
  TOPICS_WEBRTC_SOCKET: "/tmp/live-webrtc.sock",
  TOPICS_RELAY_URL: "wss://relay.example",
  TOPICS_SECRETS_DIR: "/secrets",
  TOPICS_WORKSPACE: "/live/workspace",
};

describe("previewServerEnv", () => {
  test("drops the tunnel port the live server holds", () => {
    expect(previewServerEnv(LIVE, {}).TOPICS_TUNNEL_PORT).toBeUndefined();
  });

  test("drops every other setting of the live server: ports, sockets, relay, secrets, workspace", () => {
    const env = previewServerEnv(LIVE, { BUN_PORT: "3400" });
    expect(Object.keys(env).filter((k) => k.startsWith("TOPICS_"))).toEqual([]);
  });

  test("keeps the rest of the inherited environment, and its own values win", () => {
    const env = previewServerEnv(LIVE, { BUN_PORT: "3400", DATA_DIR: "/tmp/p/data", TOPICS_PUBLIC_DIR: "/tmp/p/public" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/someone");
    expect(env.BUN_PORT).toBe("3400");
    expect(env.DATA_DIR).toBe("/tmp/p/data");
    expect(env.TOPICS_PUBLIC_DIR).toBe("/tmp/p/public");
  });

  test("leaves the caller's environment untouched", () => {
    const inherited = { ...LIVE };
    previewServerEnv(inherited, {});
    expect(inherited.TOPICS_TUNNEL_PORT).toBe("3434");
  });

  test("the preview script spawns its server through it", () => {
    const src = readFileSync(join(import.meta.dir, "preview-worktree.ts"), "utf8");
    expect(src).toContain("env: previewServerEnv(process.env, {");
    expect(src).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/);
  });
});
