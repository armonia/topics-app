#!/usr/bin/env bun
/**
 * A FAKE CLI WHOSE TURN STARTS A `run_command` MID-TURN, through the same
 * code the Topics MCP bridge runs for that tool (`callRunCommand`), with the
 * bridge's own arguments read from the `--mcp-config` the server hands the CLI.
 *
 * "cmdwatch-start" opens a turn that says "HOLDING" and waits for the file
 * `run` in `$CMDWATCH_DIR`: the command starts as late in the turn as the test
 * decides. The tool call goes out as the real CLI prints it (`assistant`
 * tool_use of `mcp__topics__run_command`, then its `tool_result`), the turn
 * says "STARTED" and stays open until the file `release`, then ends with
 * "RUN-DONE". The command waits for the file `finish` (or for the folder to
 * go), prints two lines and exits 0; its end wakes the topic with a message the fake answers "CMD-WOKEN".
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callRunCommand } from "../../../server/mcp/command-tools";

const SESSION_ID = "00000000-0000-4000-8000-0000000000c8";
const DIR = process.env.CMDWATCH_DIR ?? "";
const CWD = process.env.CMDWATCH_CWD ?? process.cwd();
const TOOL = "toolu_cmdwatch";
const JOB_DESCRIPTION = "CMDWATCH-JOB";
let waitingRun = false;
let holding = false;

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

async function runCommand(): Promise<void> {
  const input = {
    // It also stops once the test's folder is gone: a failed run must not leave it looping.
    command: `while [ -d '${DIR}' ] && [ ! -f '${join(DIR, "finish")}' ]; do sleep 0.2; done; echo CMDWATCH-OUT; echo CMDWATCH-LAST 42`,
    description: JOB_DESCRIPTION,
  };
  out({ type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content: [{ type: "tool_use", id: TOOL, name: "mcp__topics__run_command", input }], model: "claude-finto" } });
  const args = bridgeArgs();
  let result: string;
  try {
    result = args ? await callRunCommand(args, input) : "NO-MCP-CONFIG";
  } catch (err) {
    result = `RUN-FAILED ${err instanceof Error ? err.message : String(err)}`;
  }
  out({ type: "user", session_id: SESSION_ID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: TOOL, content: result }] } });
  say(result.startsWith("started") ? "STARTED" : result);
  holding = true;
}

setInterval(() => {
  if (!DIR) return;
  if (waitingRun && existsSync(join(DIR, "run"))) {
    waitingRun = false;
    void runCommand();
  }
  if (holding && existsSync(join(DIR, "release"))) {
    holding = false;
    finish("RUN-DONE");
  }
}, 150);

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
    if (text.includes("cmdwatch-start")) {
      say("HOLDING");
      waitingRun = true;
    } else if (text.includes(`Command \`${JOB_DESCRIPTION}\` finished`)) {
      finish("CMD-WOKEN");
    } else {
      finish(`got: ${text.slice(0, 200)}`);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
