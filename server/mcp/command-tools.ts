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

/**
 * The bridge of a board card's agent (`topicsMcpBridgeSpec`). The board judges
 * its turn when it ends, so it waits for a command inside the turn instead of
 * ending it on the wake: a card that ended it spent an attempt and met the
 * wake over a nudge (verifiers of 28/09). The wake flow is for ordinary chats.
 */
export function isBoardProfile(profile: string | undefined): boolean {
  return profile === "dispatch" || profile === "codex-dispatch";
}

const RUN_COMMAND_WHAT =
  "Run ANY shell command (zsh on macOS, sh elsewhere) in the current topic's project as a tracked Topics process: it shows in the Processes panel with live logs, status and Stop, it keeps running if your CLI session restarts";
// Muse, 07/10: `freeagent … > /tmp/x.log 2>&1` and its row said «Waiting for
// output...» for 58 minutes. The log now follows a file named on the line,
// but an agent that knows the output is captured has no reason to redirect.
const RUN_COMMAND_REST =
  "Its stdout and stderr are already captured in that log, so do not redirect them to a file to read later; a file named literally on the command line (`> /tmp/x.log 2>&1`, `| tee f > /dev/null`) is followed into the log too, one built from a variable is not. Pass wake=false for things that are not meant to end, such as a dev server. Returns a processId for read_process_output / wait_for_process / stop_process. For a script declared in the project's manifest, run_script is the same thing by name.";

/** `run_command` as a board card's agent reads it (`toolsForProfile`). */
export const RUN_COMMAND_BOARD_DESCRIPTION =
  `${RUN_COMMAND_WHAT}. Use it for long commands (build, test, install) instead of \`&\` or Bash with run_in_background, then get the outcome with wait_for_process in this SAME turn, calling it again while it answers 'timeout': the board judges your turn when it ends, so never end it while the command runs. ${RUN_COMMAND_REST}`;

export const COMMAND_TOOLS = [
  {
    name: "run_command",
    description:
      `${RUN_COMMAND_WHAT}, and when it ends this topic receives one message with the exit code and the last 20 lines of output, which wakes you. Use it for long ad hoc waits and loops (a retry every 15 minutes, a one-off script) instead of Bash with run_in_background. ${RUN_COMMAND_REST}`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line, run with `zsh -c` on macOS and `sh -c` elsewhere." },
        cwd: { type: "string", description: "Optional directory to run in, relative to the project root (or absolute inside it). Defaults to the root." },
        wake: { type: "boolean", description: "Wake this topic with the outcome when the command ends by itself (default true). A Stop never wakes." },
        description: { type: "string", description: "Optional short name (a few words) shown to the person while it runs and in its outcome. Defaults to the command's first line." },
      },
      required: ["command"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

interface RunCommandResp { processId?: string; pid?: number; wake?: boolean }

export async function callRunCommand(
  args: ParsedArgs,
  toolArgs: { command?: unknown; cwd?: unknown; wake?: unknown; description?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.command !== "string" || !toolArgs.command.trim()) {
    throw new Error("run_command: 'command' (non-empty string) is required");
  }
  const body = {
    command: toolArgs.command,
    ...(typeof toolArgs.cwd === "string" && toolArgs.cwd ? { cwd: toolArgs.cwd } : {}),
    ...(toolArgs.wake === false ? { wake: false } : {}),
    ...(typeof toolArgs.description === "string" && toolArgs.description.trim() ? { description: toolArgs.description } : {}),
  };
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/commands/run`;
  const res = await httpJson<RunCommandResp>(args, "POST", path, body, fetchImpl);
  if (typeof res?.processId !== "string") throw new Error("run_command: server did not return a processId");
  const after = !res.wake
    ? "no wake: check it with read_process_output or wait_for_process"
    : isBoardProfile(args.profile)
      ? "now get its outcome with wait_for_process in this same turn, and do not end your turn while it runs"
      : "this topic gets a message with the outcome when it ends, so you can end your turn";
  return `started · processId=${res.processId} · pid=${res.pid ?? "?"} · ${after}`;
}
