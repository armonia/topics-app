/**
 * @covers KANBAN-23
 *
 * A card preview is started by the live server and must not inherit the
 * listeners and channels that server owns: an inherited tunnel port made every
 * preview die on «Is port 3434 in use?».
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
  TOPICS_RELAY_URL: "wss://relay.example",
  TOPICS_SECRETS_DIR: "/secrets",
};

describe("previewServerEnv", () => {
  test("drops every listener and channel of the live server", () => {
    const env = previewServerEnv(LIVE, { BUN_PORT: "3400" });
    // Named, not read back from LIVE_SERVER_ONLY: a name dropped from that list must fail here.
    const left = Object.keys(env).filter((k) => k.startsWith("TOPICS_"));
    expect(left).toEqual([]);
  });

  test("keeps the rest of the inherited environment and adds its own", () => {
    const env = previewServerEnv(LIVE, { BUN_PORT: "3400", DATA_DIR: "/tmp/p/data" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/someone");
    expect(env.BUN_PORT).toBe("3400");
    expect(env.DATA_DIR).toBe("/tmp/p/data");
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
