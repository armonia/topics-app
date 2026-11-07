/**
 * One native turn, in a process of its own.
 *
 * Spawned by the AI broker (`server/ai-bridge.mjs`) on behalf of the native
 * provider (`detached-turn.ts`), so a server restart does not touch it: the
 * broker keeps the process and every line it writes, and the next server
 * reads them back and follows the rest live.
 *
 * PROTOCOL. stdin: the first line is the turn's spec (`TurnSpec`); later lines
 * are controls (`HostControl` in `turn-effects.ts`: abort, and the freeze and
 * thaw of a command's deadline). stdout: the journal
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
import { nativeCommandByPid } from "../../lib/native-command-registry";
import type { ProviderHold } from "../../lib/provider-hold";
import { journalHostEffects, type HostControl } from "./turn-effects";
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
  /** The server's provider hold at spawn (see `journalHostEffects`). */
  hold?: ProviderHold | null;
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
 * Errors that prove the request never reached a server: nothing listens yet
 * (a restart), so sending it again cannot run the tool twice.
 */
const NOT_SENT_CODES = new Set(["ConnectionRefused", "ECONNREFUSED", "FailedToOpenSocket", "ENOENT"]);

export function requestNeverLeft(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && NOT_SENT_CODES.has(code);
}

/**
 * One MCP call through the server, retried while the server is down.
 *
 * ONLY A REQUEST THAT NEVER LEFT IS RETRIED. A restart can land while the
 * server is running the tool: the connection resets, and a blind retry ran a
 * send or a post twice. A refused connection, or a 502/503 from a server not
 * yet ready, did not run anything; any other failure gets an "outcome
 * unknown" answer and the model decides. The turn's own Stop ends the wait.
 */
export async function callServerMcp(
  spec: Pick<TurnSpec, "server" | "sessionKey">,
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
  maxWaitMs: number = MCP_SERVER_DOWN_MAX_MS,
): Promise<{ result: ToolResult; specs?: ToolSpec[] }> {
  const url = `${spec.server.baseUrl.replace(/\/$/, "")}/api/mcp/call`;
  const deadline = Date.now() + maxWaitMs;
  let wait = 250;
  for (;;) {
    if (signal?.aborted) return { result: { content: "MCP call not sent: the turn was stopped", isError: true } };
    let notReady: string;
    try {
      const res = await fetch(url, {
        ...loopbackInit(),
        method: "POST",
        headers: { "content-type": "application/json", ...bridgeAuthHeaders(spec.server) },
        body: JSON.stringify({ name, input, sessionKey: spec.sessionKey }),
        ...(signal ? { signal } : {}),
      });
      if (res.status === 502 || res.status === 503) {
        notReady = `server unavailable (${res.status})`;
      } else {
        const body = await res.json().catch(() => null) as { result?: ToolResult; specs?: ToolSpec[]; error?: string } | null;
        if (!res.ok || !body?.result) {
          return { result: { content: body?.error ?? `MCP call failed (${res.status})`, isError: true } };
        }
        return { result: body.result, specs: body.specs };
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      if (signal?.aborted) return { result: { content: "MCP call interrupted: the turn was stopped; it may or may not have run", isError: true } };
      if (!requestNeverLeft(err)) {
        return { result: { content: `MCP call outcome unknown, not retried (the server may have run it): ${msg}`, isError: true } };
      }
      notReady = msg;
    }
    if (Date.now() > deadline) return { result: { content: `server unreachable for MCP call: ${notReady}`, isError: true } };
    await new Promise<void>((r) => {
      const t = setTimeout(done, wait);
      function done() { clearTimeout(t); signal?.removeEventListener("abort", done); r(); }
      signal?.addEventListener("abort", done, { once: true });
    });
    wait = Math.min(wait * 2, 2_000);
  }
}

async function readSpecAndControls(onControl: (msg: Partial<HostControl> & { t?: string }) => void): Promise<TurnSpec> {
  return new Promise((resolve, reject) => {
    let pending = "";
    let spec: TurnSpec | null = null;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      pending += chunk;
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: unknown;
        try { msg = JSON.parse(line); } catch { log("unparseable stdin line"); continue; }
        if (!spec) { spec = msg as TurnSpec; resolve(spec); continue; }
        onControl(msg as Partial<HostControl>);
      }
    });
    process.stdin.on("end", () => { if (!spec) reject(new Error("stdin closed before the spec")); });
  });
}

export async function main(): Promise<void> {
  const abort = new AbortController();
  const spec = await readSpecAndControls((msg) => {
    if (msg.t === "abort" && !abort.signal.aborted) {
      const cause = (msg as { cause?: string }).cause;
      log(`abort (${cause ?? "no cause"})`);
      abort.abort((cause ?? "user") as StopCause);
    } else if (msg.t === "freeze" && typeof msg.pid === "number") {
      nativeCommandByPid(msg.pid)?.onFreeze();
    } else if (msg.t === "thaw" && typeof msg.pid === "number") {
      nativeCommandByPid(msg.pid)?.onThaw(Number((msg as { frozenMs?: number }).frozenMs) || 0);
    }
  });
  const handler = journalingHandler(writeLine);
  handler.emit({ e: "start", v: JOURNAL_VERSION, pid: process.pid, at: Date.now(), model: spec.model });
  journalHostEffects(handler.emit, spec.hold ?? null);

  let mcpTools = spec.mcpTools ?? [];
  useRemoteMcpFleet({
    specs: () => mcpTools,
    call: async (name, input) => {
      const out = await callServerMcp(spec, name, input, abort.signal);
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
    onRoundUsage: (u: RoundUsage) => {
      // A round's usage means the API answered: the server lifts an outage hold on it.
      handler.emit({ e: "api_ok", at: Date.now() });
      handler.emit({ e: "usage", u });
    },
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
  let lastTools: ToolSpec[] = [];
  try { lastTools = opts.tools?.() ?? []; } catch { /* the keep-alive just does not start */ }
  handler.emit({
    e: "end",
    history: opts.history,
    calibration: opts.calibration,
    warm: { model: opts.model, effort: opts.effort, maxTokens: opts.maxTokens, system: opts.system, tools: lastTools },
  });
}

if (import.meta.main) {
  // stdout IS the journal. The loop's own logs (`[native] round:`, which
  // `scripts/token-audit.ts` reads from the server log) go to stderr, which
  // the server forwards to its stdout log (`forwardHostLog`).
  const toStderr = (...args: unknown[]) => { try { console.error(...args); } catch { /* stderr gone */ } };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  main().then(() => process.exit(0), (err) => {
    log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    writeLine(JSON.stringify({ e: "error", msg: `turn host failed: ${err instanceof Error ? err.message : String(err)}` }) + "\n");
    process.exit(1);
  });
}
