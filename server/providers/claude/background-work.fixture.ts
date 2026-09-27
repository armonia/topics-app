/**
 * A REAL CLI SESSION THAT ENDS ITS TURN WITH WORK STILL RUNNING.
 *
 * Recorded on 25/09/2026 with Claude Code 2.1.282 and the argv Topics uses
 * (`--print --verbose --input-format stream-json --output-format stream-json
 * --include-partial-messages`), stdin left open like a pooled chat. One turn
 * launched a background Agent (two slow commands), a background Bash
 * (`sleep 40`) and a Monitor (three ticks), then ended. Hook lines and the
 * bulk of `system/init` were dropped, nothing else was touched. What the CLI
 * printed, in seconds from the send:
 *
 *     [ 7.1] background_tasks_changed [agent]      task_started agent
 *     [ 8.0] background_tasks_changed [agent,bash] ...  [8.5] [+monitor]
 *     [ 9.1] assistant parent=toolu_01KQLt        <- the agent, inside the turn
 *     [10.2] result "Launched."                   <- the turn ends HERE
 *     [11.6] assistant parent=toolu_01KQLt        <- the agent goes on talking
 *     [21.0] system/init  [22.5] assistant  [22.6] result "Tick-1 fired."
 *                                                 <- a real wake: the Monitor
 *     ... five more wakes, one per task_notification ...
 *     [62.4] background_tasks_changed []          <- nothing left
 *     [62.7] system/init  [65.8] result "Slow counter agent finished ..."
 *
 * The subagent lines after the first `result` are the ones Topics took for a
 * turn the CLI opened by itself (chat 3019832f, 25/09).
 */
import { readFileSync } from "fs";
import { join } from "path";

const FIXTURE = join(import.meta.dir, "..", "..", "..", "tests", "fixtures", "claude-cli-2.1.282-background-work.ndjson");

/** The recorded stdout, one parsed event per line, in order. */
export function recordedBackgroundSession(): Array<Record<string, unknown>> {
  return readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** The raw NDJSON bytes, for a fake CLI that replays them into a broker store. */
export function recordedBackgroundSessionText(): string {
  return readFileSync(FIXTURE, "utf8");
}

const CRON_FIXTURE = join(import.meta.dir, "..", "..", "..", "tests", "fixtures", "claude-cli-2.1.282-session-cron.ndjson");

/**
 * A REAL CLI SESSION THAT ARMS A SESSION CRON AND ENDS ITS TURN.
 *
 * Recorded on 25/09/2026 with Claude Code 2.1.282 and the same argv. The turn
 * scheduled a one-shot CronCreate for the next minute, answered "scheduled"
 * and ended. Hook lines, the rate-limit line and the bulk of `system/init`
 * were dropped. Each line keeps the recorder's `{"__t":ms}` prefix, the
 * milliseconds since the send:
 *
 *     [ 8.5] assistant tool_use CronCreate {recurring: false}
 *     [ 8.6] user tool_result, tool_use_result {id: "afc60409"}
 *     [12.4] result "scheduled"            <- the turn ends HERE
 *     [14.8] command_lifecycle started     <- the cron fires
 *     [14.9] system/init  [19.4] result "CRON-FIRED"  command_lifecycle completed
 *
 * Not one `system/task_*` or `background_tasks_changed` line in between.
 */
export function recordedSessionCron(): Array<{ at: number; event: Record<string, unknown> }> {
  return readFileSync(CRON_FIXTURE, "utf8").split("\n").filter((l) => l.trim()).map((l) => {
    const [t, json] = l.split("\t");
    return { at: JSON.parse(t).__t, event: JSON.parse(json) };
  });
}
