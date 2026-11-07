/**
 * One native turn, in a process of its own.
 *
 * Spawned by the AI broker (`server/ai-bridge.mjs`) on behalf of the native
 * provider (`detached-turn.ts`), so a server restart does not touch it: the
 * broker keeps the process and every line it writes, and the next server
 * reads them back and follows the rest live.
 *
 * PROTOCOL. stdin: the first line is the turn's spec (`TurnSpec`); later lines
 * are controls (`{"t":"abort","cause":…}`). stdout: the journal
 * (`turn-journal.ts`), one event per line, ending with `end`. stderr: logs.
 *
 * WHAT STAYS IN THE SERVER. The conversation (sent here whole, returned whole
 * in `end`), the usage registry and the turn-end registry (fed from the
 * journal), and the machine's MCP servers: their calls go to
 * `/api/mcp/call` on the server, retried while it restarts, instead of
 * mounting the whole fleet once per turn.
 */

import { writeSync } from "node:fs";
import { runAgentTurn, type AgentMessage, type AgentTurnOptions } from "./agent-loop";
import type { Calibration } from "./context-window";
import type { ToolSpec, ToolResult } from "./tools";
import type { TopicsToolContext } from "./topics-tools";
import { useRemoteMcpFleet } from "./mcp-fleet";
import { journalingHandler, JOURNAL_VERSION, type RoundUsage } from "./turn-journal";
import { bridgeAuthHeaders, loopbackInit } from "../../mcp/topics-http";
import { defaultLifecycleHooks } from "../../services/lifecycle-hooks";
import type { AutonomyLevel } from "../../../shared/types";
import type { StopCause } from "../stop-reason";

export interface TurnSpec {
  v: number;
  sessionKey: string;
  model: string;
  effort?: string | null;
  maxTokens?: number;
  system?: string;
  reminder?: string;
  history: AgentMessage[];
  calibration?: Calibration;
  /** Every tool but the MCP fleet's, as the server composed them. */
  tools: ToolSpec[];
  /** The MCP fleet's tools at spawn; refreshed by every MCP call's answer. */
  mcpTools: ToolSpec[];
  /** A sub-agent's profile (`subagent-tool-policy.ts`), serialized. */
  policy?: { allowed: string[] | null; noDelegation: boolean } | null;
  autonomy?: AutonomyLevel;
  workspace: string;
  topics?: TopicsToolContext | null;
  /** Where `/api/mcp/call` lives and how to authenticate to it. */
  server: { baseUrl: string; topicsHome?: string; gatewayToken?: string };
}

/** How long an MCP call waits for a server that is restarting, in total. */
const MCP_SERVER_DOWN_MAX_MS = Number(process.env.TOPICS_NATIVE_HOST_MCP_WAIT_MS) || 10 * 60_000;

function log(msg: string): void {
  try { process.stderr.write(`[turn-host ${process.pid}] ${msg}\n`); } catch { /* stderr gone */ }
}

/**
 * Writes are synchronous so `end` is on disk before `exit`: a buffered write
 * lost at exit is a turn whose ending nobody reads.
 */
function writeLine(line: string): void {
  try { writeSync(1, line); } catch (err) { log(`stdout write failed: ${(err as Error).message}`); }
}

/**
 * One MCP call through the server, retried while the server is unreachable.
 * A server that answers with an error is an answer: only a connection that
 * cannot be made is retried, because that is what a restart looks like.
 */
async function callServerMcp(spec: TurnSpec, name: string, input: Record<string, unknown>): Promise<{ result: ToolResult; specs?: ToolSpec[] }> {
  const url = `${spec.server.baseUrl.replace(/\/$/, "")}/api/mcp/call`;
  const deadline = Date.now() + MCP_SERVER_DOWN_MAX_MS;
  let wait = 250;
  for (;;) {
    try {
      const res = await fetch(url, {
        ...loopbackInit(),
        method: "POST",
        headers: { "content-type": "application/json", ...bridgeAuthHeaders(spec.server) },
        body: JSON.stringify({ name, input, sessionKey: spec.sessionKey }),
      });
      if (res.status === 502 || res.status === 503) throw new Error(`server unavailable (${res.status})`);
      const body = await res.json().catch(() => null) as { result?: ToolResult; specs?: ToolSpec[]; error?: string } | null;
      if (!res.ok || !body?.result) {
        return { result: { content: body?.error ?? `MCP call failed (${res.status})`, isError: true } };
      }
      return { result: body.result, specs: body.specs };
    } catch (err) {
      if (Date.now() > deadline) return { result: { content: `server unreachable for MCP call: ${(err as Error).message}`, isError: true } };
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 2_000);
    }
  }
}

async function readSpecAndControls(onControl: (msg: { t?: string; cause?: string }) => void): Promise<TurnSpec> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let spec: TurnSpec | null = null;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: unknown;
        try { msg = JSON.parse(line); } catch { log("unparseable stdin line"); continue; }
        if (!spec) { spec = msg as TurnSpec; resolve(spec); continue; }
        onControl(msg as { t?: string; cause?: string });
      }
    });
    process.stdin.on("end", () => { if (!spec) reject(new Error("stdin closed before the spec")); });
  });
}

export async function main(): Promise<void> {
  const abort = new AbortController();
  const spec = await readSpecAndControls((msg) => {
    if (msg.t === "abort" && !abort.signal.aborted) {
      log(`abort (${msg.cause ?? "no cause"})`);
      abort.abort((msg.cause ?? "user") as StopCause);
    }
  });
  const handler = journalingHandler(writeLine);
  handler.emit({ e: "start", v: JOURNAL_VERSION, pid: process.pid, at: Date.now() });

  let mcpTools = spec.mcpTools ?? [];
  useRemoteMcpFleet({
    specs: () => mcpTools,
    call: async (name, input) => {
      const out = await callServerMcp(spec, name, input);
      if (out.specs) mcpTools = out.specs;
      return out.result;
    },
  });

  const policy = spec.policy ? { allowed: spec.policy.allowed ? new Set(spec.policy.allowed) : null, noDelegation: spec.policy.noDelegation } : null;
  const { toolAllowedByPolicy } = await import("../../lib/subagent-tool-policy");
  const allowed = (name: string) => toolAllowedByPolicy(policy, name);

  const opts: AgentTurnOptions = {
    model: spec.model,
    effort: spec.effort ?? null,
    maxTokens: spec.maxTokens,
    system: spec.system,
    reminder: spec.reminder,
    history: spec.history,
    calibration: spec.calibration,
    tools: () => {
      const all = [...spec.tools, ...mcpTools];
      return policy ? all.filter((t) => allowed(t.name)) : all;
    },
    ...(policy ? { allowTool: allowed } : {}),
    toolContext: { workspace: spec.workspace, signal: abort.signal, sessionKey: spec.sessionKey },
    topics: spec.topics ?? undefined,
    autonomy: spec.autonomy,
    hooks: defaultLifecycleHooks(),
    sessionId: spec.sessionKey,
    signal: abort.signal,
    onRequestStart: () => handler.emit({ e: "req", at: Date.now() }),
    onRoundUsage: (u: RoundUsage) => handler.emit({ e: "usage", u }),
  };

  try {
    await runAgentTurn(opts, handler);
  } catch (err) {
    // `runAgentTurn` reports its own failures through the handler; an
    // exception here is a bug in the host, and the turn must still end.
    const msg = err instanceof Error ? err.message : String(err);
    log(`turn threw: ${msg}`);
    if (abort.signal.aborted) handler.emit({ e: "aborted", m: { result: "", turnEnd: { end: "cancelled", cause: String(abort.signal.reason ?? "") } } });
    else handler.emit({ e: "error", msg });
  }
  handler.emit({ e: "end", history: opts.history, calibration: opts.calibration });
}

if (import.meta.main) {
  main().then(() => process.exit(0), (err) => {
    log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    writeLine(JSON.stringify({ e: "error", msg: `turn host failed: ${err instanceof Error ? err.message : String(err)}` }) + "\n");
    process.exit(1);
  });
}
