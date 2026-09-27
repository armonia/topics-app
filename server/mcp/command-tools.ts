/**
 * `run_command`: ANY COMMAND, AS A PROCESS OF TOPICS.
 *
 * `run_script` runs only what the project's manifest declares, and that gate
 * stays. An ad hoc command (a retry loop, a one-off script in /tmp) had nowhere
 * to go but `Bash(run_in_background)`: invisible in the Processes panel, dead
 * with the CLI session, and a wake that belongs to the CLI. On 24/09 a two-hour
 * retry died that way and nobody was woken. This tool gives the command a row
 * in the panel, a life of its own and a wake to the topic when it ends
 * (`server/lib/process-exit-wake.ts`).
 *
 * In a module of its own, like the outbound tools, and for the same reason:
 * the bridge file is the dispatcher and `check:bloat` counts its lines. The
 * annotations are spelled out instead of imported for the reason written over
 * `LEAVES_THE_MACHINE` in `outbound-tools.ts` (the import back would be a cycle).
 */
import { httpJson, type ParsedArgs } from "./topics-http";

export const COMMAND_TOOLS = [
  {
    name: "run_command",
    description:
      "Run ANY shell command (zsh on macOS, sh elsewhere) in the current topic's project as a tracked Topics process: it shows in the Processes panel with live logs, status and Stop, it keeps running if your CLI session restarts, and when it ends this topic receives one message with the exit code and the last 20 lines of output, which wakes you. Use it for long ad hoc waits and loops (a retry every 15 minutes, a one-off script) instead of Bash with run_in_background. Pass wake=false for things that are not meant to end, such as a dev server. Returns a processId for read_process_output / wait_for_process / stop_process. For a script declared in the project's manifest, run_script is the same thing by name.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line, run with `zsh -c` on macOS and `sh -c` elsewhere." },
        cwd: { type: "string", description: "Optional directory to run in, relative to the project root (or absolute inside it). Defaults to the root." },
        wake: { type: "boolean", description: "Wake this topic with the outcome when the command ends by itself (default true). A Stop never wakes." },
      },
      required: ["command"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

interface RunCommandResp { processId?: string; pid?: number; wake?: boolean }

export async function callRunCommand(
  args: ParsedArgs,
  toolArgs: { command?: unknown; cwd?: unknown; wake?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.command !== "string" || !toolArgs.command.trim()) {
    throw new Error("run_command: 'command' (non-empty string) is required");
  }
  const body = {
    command: toolArgs.command,
    ...(typeof toolArgs.cwd === "string" && toolArgs.cwd ? { cwd: toolArgs.cwd } : {}),
    ...(toolArgs.wake === false ? { wake: false } : {}),
  };
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/commands/run`;
  const res = await httpJson<RunCommandResp>(args, "POST", path, body, fetchImpl);
  if (typeof res?.processId !== "string") throw new Error("run_command: server did not return a processId");
  const after = res.wake
    ? "this topic gets a message with the outcome when it ends, so you can end your turn"
    : "no wake: check it with read_process_output or wait_for_process";
  return `started · processId=${res.processId} · pid=${res.pid ?? "?"} · ${after}`;
}
