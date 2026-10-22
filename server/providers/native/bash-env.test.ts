/**
 * The native `bash` tool runs an agent's command in the agent's environment
 * (`lib/agent-env.ts`), never the server's.
 *
 * Measured on bun 1.3.8: a child spawned with NO `env` option gets the
 * environment the server was LAUNCHED with, so a secret from launchd or `.env`
 * survives `delete process.env.X`, and setting one at runtime never shows. The
 * test therefore puts the secrets in a real process's launch environment and
 * runs the tool from there.
 *
 * @covers MP-NATENV-01
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const TOOLS = join(import.meta.dir, "tools.ts");

describe("native bash: the agent's environment, not the server's", () => {
  test("a secret the server was launched with does not reach the command", () => {
    const script = `
      const { executeTool } = await import(${JSON.stringify(TOOLS)});
      const out = await executeTool("bash", { command: 'printf "%s|%s|%s" "\${GATEWAY_TOKEN:-absent}" "\${TOPICS_LICENSE_TOKEN:-absent}" "\${HOME:+home}"' }, { workspace: process.cwd() });
      process.stdout.write(out.content);
    `;
    const r = Bun.spawnSync(["bun", "-e", script], {
      env: { ...process.env, GATEWAY_TOKEN: "launch-fixture", TOPICS_LICENSE_TOKEN: "license-fixture" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = r.stdout.toString();
    expect(out).toContain("absent|absent|home");
    expect(out).not.toContain("fixture");
  });
});
