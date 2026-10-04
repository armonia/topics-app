#!/usr/bin/env bun
/**
 * A FAKE CLI WHOSE TURN STARTS A REAL HTTP SERVER WITH `run_command`, through
 * the same code the Topics MCP bridge runs for that tool (`callRunCommand`),
 * with the bridge's own arguments read from the `--mcp-config` the server
 * hands the CLI (the pattern of `fake-claude-command.ts`).
 *
 * "srvcard-start" starts the server of `$SRVCARD_DIR/srv.ts` on
 * `$SRVCARD_PORT` with `wake: false`, as an agent starts a dev server, and
 * ends the turn with "SRV-STARTED". "srvcard-wake" starts the same server on
 * `$SRVCARD_WAKE_PORT` with the default wake, and ends with "WAKE-STARTED".
 * "srvcard-script" starts the project's dev server script with `run_script`, as
 * an agent starts a declared dev server, and ends with "SCRIPT-STARTED".
 * The server stops by itself once `$SRVCARD_DIR` is gone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callRunCommand } from "../../../server/mcp/command-tools";
import { callRunScript } from "../../../server/mcp/topics-mcp-server";

const SESSION_ID = "00000000-0000-4000-8000-0000000000c9";
const DIR = process.env.SRVCARD_DIR ?? "";
const CWD = process.env.SRVCARD_CWD ?? process.cwd();

function out(o: unknown): void {
  process.stdout.write(JSON.stringify(o) + "\n");
}

function init(): void {
  out({ type: "system", subtype: "init", cwd: CWD, session_id: SESSION_ID, model: "claude-finto", tools: ["mcp__topics__run_command"], fast_mode_state: "off" });
}

function say(text: string): void {
  out({ type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content: [{ type: "text", text }], model: "claude-finto" } });
}

function finish(text: string): void {
  say(text);
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, stop_reason: "end_turn", session_id: SESSION_ID, result: text, duration_ms: 90, total_cost_usd: 0 });
}

/** The bridge's arguments, as `topicsMcpBridgeSpec` writes them into the session's MCP config. */
function bridgeArgs(): { baseUrl: string; sessionKey: string; gatewayToken?: string } | null {
  const i = process.argv.indexOf("--mcp-config");
  if (i < 0 || !process.argv[i + 1]) return null;
  try {
    const config = JSON.parse(readFileSync(process.argv[i + 1]!, "utf8")) as { mcpServers?: { topics?: { args?: string[] } } };
    const args = config.mcpServers?.topics?.args ?? [];
    const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    const baseUrl = flag("base-url");
    const sessionKey = flag("session-key");
    return baseUrl && sessionKey ? { baseUrl, sessionKey, gatewayToken: flag("gateway-token") } : null;
  } catch {
    return null;
  }
}

async function startServer(port: string, wake: boolean, description: string, done: string): Promise<void> {
  const tool = `toolu_srvcard_${wake ? "wake" : "srv"}`;
  const input = {
    command: `'${process.execPath}' '${join(DIR, "srv.ts")}' ${port}`,
    description,
    ...(wake ? {} : { wake: false }),
  };
  out({ type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content: [{ type: "tool_use", id: tool, name: "mcp__topics__run_command", input }], model: "claude-finto" } });
  const args = bridgeArgs();
  let result: string;
  try {
    result = args ? await callRunCommand(args, input) : "NO-MCP-CONFIG";
  } catch (err) {
    result = `RUN-FAILED ${err instanceof Error ? err.message : String(err)}`;
  }
  out({ type: "user", session_id: SESSION_ID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: result }] } });
  finish(result.startsWith("started") ? done : result);
}

/** The project's dev server script, through the bridge's own `run_script` code. */
async function startScript(): Promise<void> {
  const tool = "toolu_srvcard_script";
  out({ type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content: [{ type: "tool_use", id: tool, name: "mcp__topics__run_script", input: { script: "serve" } }], model: "claude-finto" } });
  const args = bridgeArgs();
  let result: string;
  try {
    result = args ? await callRunScript(args, { script: "serve" }) : "NO-MCP-CONFIG";
  } catch (err) {
    result = `RUN-FAILED ${err instanceof Error ? err.message : String(err)}`;
  }
  out({ type: "user", session_id: SESSION_ID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: result }] } });
  finish(result.startsWith("started") ? "SCRIPT-STARTED" : result);
}

function textOf(line: string): string | null {
  try {
    const c = (JSON.parse(line) as { message?: { content?: unknown } })?.message?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.map((b) => {
        const block = b as { type?: string; text?: string } | null;
        return block?.type === "text" ? block.text ?? "" : "";
      }).join("");
    }
  } catch { /* not JSON: ignored */ }
  return null;
}

let pending = "";
process.stdin.on("data", (chunk: Buffer) => {
  pending += chunk.toString();
  let nl: number;
  while ((nl = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, nl).trim();
    pending = pending.slice(nl + 1);
    const text = line ? textOf(line) : null;
    if (text === null) continue;
    init();
    if (text.includes("srvcard-start")) void startServer(process.env.SRVCARD_PORT ?? "0", false, "SRVCARD-SERVER", "SRV-STARTED");
    else if (text.includes("srvcard-script")) void startScript();
    else if (text.includes("srvcard-wake")) void startServer(process.env.SRVCARD_WAKE_PORT ?? "0", true, "SRVCARD-WAKE", "WAKE-STARTED");
    else finish(`got: ${text.slice(0, 200)}`);
  }
});

process.stdin.on("end", () => process.exit(0));
