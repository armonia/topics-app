/**
 * TELLING THE AGENT THAT ITS BACKGROUND COMMAND WAS FROZEN, without writing a
 * word into its conversation.
 *
 * WHY IT MATTERS, measured. The T0 probe (CI, macOS, 16/09/2026) froze a
 * Playwright run for 10 s: `page.waitForTimeout(3000)` came back fine after
 * 10.4 s, but a `click({ timeout: 5000 })` in flight FAILED with a TimeoutError
 * the moment the freeze outlasted its budget. So a frozen test run can end red
 * for a reason that is ours, and an agent that cannot see the freeze will spend
 * a turn debugging the product instead of rerunning the command.
 *
 * WHY NOT A MESSAGE. Nothing may be injected into a CLI's conversation: an
 * error of the provider written as if it were data is a mistake this repo has
 * already paid for (`errore-del-provider-scritto-come-dato`). allow-italian: the memory note's own filename. What a
 * `Bash(run_in_background: true)` gives us instead is a real file: the CLI
 * redirects the shell's stdout to `…/tasks/<id>.output` and `BashOutput` reads
 * it back (verified on Claude Code 2.1.270, fd 1 of the snapshot shell is a REG
 * file under the session's `tasks/` directory). Appending one line to that file
 * is telling the agent in the only channel that is already its own.
 *
 * A pipe instead of a file (an older CLI, another shape) is not written to: the
 * line is dropped and the freeze is still on the card, in the log and in the
 * notification history.
 */
import { appendFileSync } from "fs";
import { captureWithDeadline } from "./bounded-capture";

/** `lsof -a -p <pid> -d 1 -F ftn`: the path of fd 1 when it is a regular file. */
export function parseLsofStdout(text: string): string | null {
  let isRegular = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("f") && line.slice(1) !== "1") { isRegular = false; continue; }
    if (line.startsWith("t")) { isRegular = line.slice(1) === "REG"; continue; }
    if (line.startsWith("n") && isRegular) return line.slice(1);
  }
  return null;
}

/** The file a background shell writes to, or `null` when its stdout is not a file. */
export async function stdoutFileOf(pid: number, timeoutMs = 2_000): Promise<string | null> {
  // The deadline is on the answer (`bounded-capture.ts`): this runs on the freeze
  // path, and an `lsof` that never returns used to hold the beat that the ten
  // minute thaw cap depends on. A note that cannot be written is dropped; a beat
  // that never ends leaves the tree stopped.
  const capture = await captureWithDeadline(["/usr/sbin/lsof", "-a", "-p", String(pid), "-d", "1", "-F", "ftn"], timeoutMs);
  return capture === null ? null : parseLsofStdout(capture.text);
}

/** The line the agent reads in its next `BashOutput`. */
export function frozenNoteLine(frozenMs: number): string {
  const seconds = Math.round(frozenMs / 1000);
  return `\n[Topics: comando congelato ${seconds} s con il Mac in swap, poi ripreso. ` + // allow-italian: the agent's own tool output is written in the same language as the rest of its surface
    "Un'operazione con un timeout scaduto durante il fermo e' un effetto del congelamento, non un difetto del codice: rilancia prima di indagare.]\n"; // allow-italian: same line
}

export function appendFrozenNote(path: string, frozenMs: number): boolean {
  try { appendFileSync(path, frozenNoteLine(frozenMs)); return true; }
  catch { return false; }
}
