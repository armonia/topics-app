/**
 * Background shells, read from the results of the tools (3.5).
 *
 * A `Bash(run_in_background: true)` is not a tool that ends: it is a process
 * that STAYS. Its only trace used to be the card in the transcript, a memory
 * and not a state: it scrolled away, it was not counted and it could not be
 * killed. Only the part that reads the CLI lives here; the registry is
 * `routes/processes.ts`, already the place where live processes are seen and
 * stopped.
 *
 * Why parsing and not a structured field: the CLI answers these tools in
 * prose (`Command running in background with ID: bash_1`) and with tags
 * (`<status>`, `<exit_code>`). It is not a contract and it changes between
 * versions, so every function here is deliberately lenient and returns `null`
 * instead of guessing. An unrecognised shell stays invisible as before; a
 * misrecognised one would be a Stop button aimed at something else.
 */

import type { ToolCallDetail } from "../../types";

/** Stati terminali che il CLI sa riportare, più `running`. */
export type ShellStatus = "running" | "completed" | "failed" | "killed";

/** Cosa fare del registro delle shell, dato un risultato di tool. */
export type ShellToolAction =
  | { kind: "start"; shellId: string; command: string; cwd?: string; outputPath?: string }
  | { kind: "output"; shellId: string; output: string; status?: ShellStatus; exitCode?: number }
  | { kind: "kill"; shellId: string };

/**
 * Translates a tool result into its effect on the registry, or `null` when it
 * has none. It lives here and not in the route because it is all reading of
 * somebody else's formats: the route only carries the effect out.
 */
export function classifyShellToolResult(
  detail: ToolCallDetail | undefined,
  result: string | undefined,
  isError?: boolean,
): ShellToolAction | null {
  if (!detail) return null;

  // A background Bash that FAILED left nothing behind.
  if (detail.type === "shell" && detail.background === true && !isError) {
    const shellId = parseBackgroundShellId(result);
    if (!shellId) return null;
    const outputPath = parseBackgroundShellOutputPath(result);
    return {
      kind: "start",
      shellId,
      command: detail.command,
      ...(detail.cwd ? { cwd: detail.cwd } : {}),
      ...(outputPath ? { outputPath } : {}),
    };
  }

  if (detail.type === "bash_output" && detail.shellId) {
    const st = parseShellStatus(result);
    return {
      kind: "output",
      shellId: detail.shellId,
      output: parseShellOutput(result),
      ...(st?.status ? { status: st.status } : {}),
      ...(st?.exitCode != null ? { exitCode: st.exitCode } : {}),
    };
  }

  if (detail.type === "kill_shell" && detail.shellId) {
    return { kind: "kill", shellId: detail.shellId };
  }

  return null;
}

/**
 * The id the CLI gives the shell it just started, read from the `Bash` result.
 * Call it ONLY when `run_in_background` was true: on an ordinary Bash any
 * output containing "ID: ..." would be a false positive.
 */
export function parseBackgroundShellId(result: string | undefined): string | null {
  if (!result) return null;
  const patterns: RegExp[] = [
    // The JSON shape, should the CLI stop answering in prose one day.
    /"(?:shell_?id|bash_?id|id)"\s*:\s*"([^"]+)"/i,
    // The sentence: "Command running in background with ID: bash_1".
    /\bID[:=]\s*([A-Za-z0-9][A-Za-z0-9_.:-]*)/i,
    /\bID\s+([A-Za-z0-9][A-Za-z0-9_.:-]*)/i,
    // Last resort: the bare id, without a label.
    /\b(bash_[A-Za-z0-9]+)\b/i,
  ];
  for (const re of patterns) {
    const m = result.match(re);
    // The current CLI ends the id's sentence with a full stop ("with ID:
    // b68urh4wy. Output is being written to: ..."), and the id class accepts
    // dots, so the stop came along: `wait_for_process` on the id the agent sees
    // then missed the row keyed with the dot.
    const id = m?.[1]?.replace(/\.+$/, "");
    if (id) return id;
  }
  return null;
}

/**
 * The file the current CLI writes the shell's output to, read from the same
 * announcement ("Output is being written to: /.../b68urh4wy.output. If it
 * exits ..."). The registry follows it, so the row's log grows without the
 * agent reading it: the CLI no longer calls `BashOutput`, the old source.
 */
export function parseBackgroundShellOutputPath(result: string | undefined): string | null {
  const raw = result?.match(/Output is being written to:\s*(\S+)/i)?.[1];
  const path = raw?.replace(/\.+$/, "");
  return path ? path : null;
}

/**
 * The status a `BashOutput` reports. `null` when the result says nothing about
 * it: the caller keeps what it had instead of inventing a "completed" out of
 * silence.
 */
export function parseShellStatus(
  result: string | undefined,
): { status: ShellStatus; exitCode?: number } | null {
  if (!result) return null;

  const raw =
    result.match(/<status>\s*([a-z_]+)\s*<\/status>/i)?.[1] ??
    result.match(/"status"\s*:\s*"([a-z_]+)"/i)?.[1] ??
    null;
  if (!raw) return null;

  const exitRaw =
    result.match(/<exit_?code>\s*(-?\d+)\s*<\/exit_?code>/i)?.[1] ??
    result.match(/"exit_?code"\s*:\s*(-?\d+)/i)?.[1] ??
    null;
  const exitCode = exitRaw != null ? Number(exitRaw) : undefined;

  const status = normalizeStatus(raw, exitCode);
  if (!status) return null;
  return exitCode != null ? { status, exitCode } : { status };
}

function normalizeStatus(raw: string, exitCode?: number): ShellStatus | null {
  switch (raw.toLowerCase()) {
    case "running":
    case "in_progress":
      return "running";
    case "completed":
    case "complete":
    case "done":
    case "success":
      // A "completed" with a non-zero exit code is a failure: the code says
      // so, not the label.
      return exitCode != null && exitCode !== 0 ? "failed" : "completed";
    case "failed":
    case "error":
      return "failed";
    case "killed":
    case "terminated":
      return "killed";
    default:
      return null;
  }
}

/**
 * The useful text of a `BashOutput`: the status tags removed, `<stdout>` and
 * `<stderr>` unwrapped. What is left is what the shell really printed, the
 * only thing worth showing in the panel.
 */
export function parseShellOutput(result: string | undefined): string {
  if (!result) return "";
  return result
    // The metadata tags go, with all their content.
    .replace(/<(status|exit_?code|timestamp)>[^]*?<\/\1>/gi, "")
    // The two channels are unwrapped: in the panel they are lines like any other.
    .replace(/<\/?(stdout|stderr)>/gi, "")
    .trim();
}
