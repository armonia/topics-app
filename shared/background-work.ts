/**
 * What a chat with no turn open is still waiting on: the work its last turn
 * left running (an Agent, a Bash, a Monitor, a Workflow), as the `background`
 * row of `GET /api/topics/streaming` carries it. One declaration for the server
 * that writes it and the client that draws it.
 */

/** One task, named: `description` falls back on `type` when the CLI gave none. */
export type BackgroundTaskSummary = { type: string; description: string };

/**
 * `tasks` is empty when a task has reported and the CLI is about to wake to
 * answer it. `lastSignalAt` is when the CLI last printed something about the
 * work (epoch ms).
 */
export type BackgroundWorkDetail = { tasks: BackgroundTaskSummary[]; lastSignalAt: number };
