/**
 * What a chat is still waiting on, turn open or not: the work its last turn
 * left running (an Agent, a Bash, a Monitor, a Workflow) or a session cron it
 * armed (`type: "cron"`, named by its schedule), as the `background`
 * row of `GET /api/topics/streaming` carries it. One declaration for the server
 * that writes it and the client that draws it.
 */

/**
 * One task, named: `description` falls back on `type` when the CLI gave none.
 * `type` is the CLI's (`local_bash`, `local_agent`), `cron`, `monitor` for a
 * Monitor, which the CLI lists as a `local_bash`, or `command` for a process
 * the agent started with the Topics tool `run_command`, which lives in Topics'
 * own process registry and not in the CLI. `startedAt` (epoch ms) is when the
 * server first saw it running (a command's own start); a server older than the
 * field sends none. Only a command carries `processId` (the row of the
 * Processes panel that opens it) and `wakes` (its end wakes the chat).
 */
export type BackgroundTaskSummary = { type: string; description: string; startedAt?: number; processId?: string; wakes?: boolean };

/**
 * `tasks` is empty when a task has reported and the CLI is about to wake to
 * answer it. `lastSignalAt` is when the CLI last printed something about the
 * work (epoch ms).
 */
export type BackgroundWorkDetail = { tasks: BackgroundTaskSummary[]; lastSignalAt: number };
