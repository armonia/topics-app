/**
 * THE PROCESS A `run_command` / `run_script` CARD STARTED, read from its answer
 * (`started · processId=…`, `server/mcp/command-tools.ts`): the card draws that
 * process's live log under itself (`LaunchedProcessTail`). Pure, so the rule has
 * a test with no DOM.
 */

const LAUNCHED = /started · processId=([\w:.-]+)/;

/** The process a `run_command` / `run_script` answer says it started, or null. */
export function launchedProcessId(answer: string | undefined): string | null {
  return (answer && LAUNCHED.exec(answer)?.[1]) || null;
}
