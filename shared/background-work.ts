/**
 * What a chat is still waiting on, turn open or not: the work its last turn
 * left running (an Agent, a Bash, a Monitor, a Workflow) or a session cron it
 * armed (`type: "cron"`, named by its schedule), as the `background`
 * row of `GET /api/topics/streaming` carries it. One declaration for the server
 * that writes it and the client that draws it.
 */

/**
 * One task, named: `description` falls back on `type` when the CLI gave none.
 * `type` is the CLI's (`local_bash`, `local_agent`), `cron`, or `monitor` for a
 * Monitor, which the CLI lists as a `local_bash`. `startedAt` (epoch ms) is
 * when the server first saw it running; a server older than the field sends none.
 */
export type BackgroundTaskSummary = { type: string; description: string; startedAt?: number };

/**
 * `tasks` is empty when a task has reported and the CLI is about to wake to
 * answer it. `lastSignalAt` is when the CLI last printed something about the
 * work (epoch ms).
 */
export type BackgroundWorkDetail = { tasks: BackgroundTaskSummary[]; lastSignalAt: number };
