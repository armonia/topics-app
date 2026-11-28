/**
 * The `agent` action (rules R15, R16, R17, R18, R20 of change
 * lavori-programmati-in-topics). Retries, the duration cap and the board's
 * brakes are a later track (R19, R27): this module never backs off and never
 * reads `dispatchBrakes()`.
 *
 * The engine decides WHEN; this module opens ONE turn of a chat per
 * occurrence, through the chat route injected as a door (the same shape as
 * `lib/process-exit-wake.ts`'s `route`, so the engine never imports the HTTP
 * layer):
 *  - the turn is sent exactly like a person's message, under the
 *    anti-duplicate key `job:<jobId>:<occurrenceKey>` as `clientMessageId`:
 *    SQLite's unique index on `(session_key, client_message_id)` is what
 *    makes two ticks, or a boot's resend, land as ONE row (R15);
 *  - the chat does not start with an "initial message": the first turn is a
 *    normal `/api/chat` POST, marked `scheduledJob` so the transcript never
 *    shows it as a person's words (R16, `lib/user-row-marks.ts`);
 *  - a 409 `stream_in_flight` on send is not a fault: the chat has another
 *    turn in flight (a person, or this same job sent by another engine), and
 *    the next sweep sends it once that turn is free (R9, through R18);
 *  - `sweep()` reads the state from the chat itself, never from a column this
 *    module would keep: open or resuming means wait, closed means the
 *    turn's final text (following the boot resume's `resendOf` copies) closes
 *    the run (R18);
 *  - the run closes `error` when the text's first line is `AUTOMATION_FAILED`,
 *    `ok` otherwise (a bare `NO_REPLY` included: whether that suppresses a
 *    delivery is R22's job, a later track, not this run's status) (R17);
 *  - a job's `at` occurrence that closed `ok` with no open question gets its
 *    chat archived, and so does a job's last chat once it is disabled or
 *    deleted (R20).
 */
import type { Database } from "bun:sqlite";
import type { ActionExecutor } from "./engine";
import { parseJob, parseRun, type AgentJobAction, type RunRow, type ScheduledJob, type ScheduledJobRow, type ScheduledRun } from "./store";

/**
 * Injected into every job's turn, ahead of its own prompt. No names, no
 * paths: this text is read by the model, not by a person.
 */
export const AGENT_JOB_RULES_BLOCK = `This is an automated turn of a scheduled job. Nobody is watching this chat live: there is no one to answer a question in turn, and this turn's outcome is judged ONLY from the text you end with, never from a background task somebody would have to come back for.

- Done, with nothing more to say: end your reply with the line \`NO_REPLY\`.
- Not successful: the FIRST line of your reply is \`AUTOMATION_FAILED\`, followed by why.
- A question the job's owner has to answer: write it in plain words in your final text, you will not get an answer in this turn.
- Do not start background work you would expect a wake for (no open \`run_in_background\`, no open \`wait_for_process\`): finish within this turn.`;

type ChatRoute = (req: Request, url: URL, pathname: string, method: string) => Response | null | Promise<Response | null>;

export interface AgentChatDoor {
  route: ChatRoute;
  /** A new chat for this job, never started with an initial message. Returns its session key. */
  createChat(job: ScheduledJob): string;
  /** Is there a turn open or in resume on this chat right now (R18)? */
  turnOpen(sessionKey: string): boolean;
  /** Does a row under this `clientMessageId` already exist in this chat, whatever its outcome? */
  sent(sessionKey: string, clientMessageId: string): boolean;
  /**
   * The final text of that row's turn, following the boot resume's
   * `resendOf` chain to its terminal copy. Undefined while the turn has not
   * closed yet; null when it closed without a readable outcome (a cut with
   * nothing after it).
   */
  finalText(sessionKey: string, clientMessageId: string): string | null | undefined;
  /** Open questions of this chat waiting on its owner (R20: an `at` job does not archive over one). */
  hasOpenQuestions(sessionKey: string): boolean;
  /** Archives a chat (R20). */
  archiveChat(sessionKey: string): void;
}

export interface AgentEngineDoor {
  closeIfOpen(runId: string, status: "ok" | "error", reason: string | null): boolean;
}

export interface AgentActionOptions {
  chat: AgentChatDoor;
  /** Called when a run closes, so a job waiting on it can restart right away (R9). */
  onClosed?: () => void;
}

/** `job:<jobId>:<occurrenceKey>`: the anti-duplicate key of one occurrence's turn (R15). */
export function scheduledJobClientMessageId(jobId: string, occurrenceKey: string): string {
  return `job:${jobId}:${occurrenceKey}`;
}

export function createAgentAction(db: Database, door: AgentEngineDoor, options: AgentActionOptions) {
  const { chat } = options;

  const jobOf = (id: string): ScheduledJob | null => {
    const row = db.query("SELECT * FROM scheduled_jobs WHERE id = ?").get(id) as ScheduledJobRow | null;
    return row ? parseJob(row) : null;
  };
  const openAgentRuns = (): ScheduledRun[] => (db.query(`SELECT r.* FROM scheduled_job_runs r JOIN scheduled_jobs j ON j.id = r.job_id
    WHERE r.status = 'running' AND json_extract(j.action_json, '$.kind') = 'agent'`).all() as RunRow[]).map(parseRun);

  /**
   * The chat of a job's last agent run, whatever that run's status: `keep`
   * mode's own chat (R20), and the one a turned-off job's chat is archived
   * from. Read off `scheduled_job_runs` itself, never a column the door would
   * have to remember on its own.
   */
  const lastKnownChatOf = (jobId: string): string | null =>
    (db.query("SELECT process_ref FROM scheduled_job_runs WHERE job_id = ? AND process_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1")
      .get(jobId) as { process_ref: string } | null)?.process_ref ?? null;

  // One chain per chat: a sweep landing while a send is still in flight for
  // the same session must not fire a second request alongside it.
  const chains = new Map<string, Promise<void>>();

  async function sendTurn(sessionKey: string, clientMessageId: string, job: ScheduledJob, run: ScheduledRun): Promise<"sent" | "busy" | "error"> {
    const action = job.action as AgentJobAction;
    const url = new URL("http://localhost/api/chat");
    let resp: Response | null;
    try {
      resp = await chat.route(
        new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionKey,
            messages: [{ role: "user", content: `${AGENT_JOB_RULES_BLOCK}\n\n${action.prompt}` }],
            clientMessageId,
            scheduledJob: { jobId: job.id, runId: run.id },
          }),
        }),
        url, "/api/chat", "POST",
      );
    } catch (error) {
      console.warn("[schedule:agent] send failed:", error);
      return "error";
    }
    if (resp?.status === 409) {
      const code = ((await resp.json().catch(() => null)) as { code?: unknown } | null)?.code;
      // Already stored under this key (another tick, another engine, or the boot's own resend): the turn exists, read on.
      if (code === "duplicate_message") return "sent";
      // The chat has another turn in flight: not a fault, just not free yet (R9, through R18).
      if (code === "stream_in_flight") return "busy";
      return "error";
    }
    return resp?.ok ? "sent" : "error";
  }

  /** `AUTOMATION_FAILED` on its first line closes the run in error; everything else is `ok` (R17; what gets delivered is R22's job). */
  function finalize(run: ScheduledRun, job: ScheduledJob | null, sessionKey: string, text: string | null) {
    if (text === null) {
      if (door.closeIfOpen(run.id, "error", "The turn ended without a recorded outcome.")) options.onClosed?.();
      return;
    }
    const failed = text.trim().startsWith("AUTOMATION_FAILED");
    const firstLine = text.trim().split("\n", 1)[0] ?? null;
    if (!door.closeIfOpen(run.id, failed ? "error" : "ok", failed ? firstLine : null)) return;
    options.onClosed?.();
    // R20: an `at` job that succeeded with no open question does not need its chat kept around.
    if (!failed && job?.schedule.kind === "at" && !chat.hasOpenQuestions(sessionKey)) chat.archiveChat(sessionKey);
  }

  async function pump(sessionKey: string, run: ScheduledRun, jobId: string): Promise<void> {
    const job = jobOf(jobId);
    const action = job?.action;
    if (!job || action?.kind !== "agent") return;
    const key = scheduledJobClientMessageId(jobId, run.occurrenceKey);
    if (!chat.sent(sessionKey, key)) {
      const outcome = await sendTurn(sessionKey, key, job, run);
      if (outcome !== "sent") return; // `error` or `busy`: the next sweep tries again, no error is written (R18, R19 is a later track).
    }
    if (chat.turnOpen(sessionKey)) return; // R18: a turn open or in resume is awaited.
    const text = chat.finalText(sessionKey, key);
    if (text === undefined) return; // sent, chat free, but no row read yet (a race with the route's own write): retried next sweep.
    finalize(run, job, sessionKey, text);
  }

  function schedule(sessionKey: string, run: ScheduledRun, jobId: string): void {
    const next = (chains.get(sessionKey) ?? Promise.resolve())
      .then(() => pump(sessionKey, run, jobId))
      .catch((error) => console.warn("[schedule:agent] pump failed:", error));
    chains.set(sessionKey, next);
    void next.finally(() => { if (chains.get(sessionKey) === next) chains.delete(sessionKey); });
  }

  const executor: ActionExecutor = {
    atomic: false,
    start(job, run) {
      const action = job.action as AgentJobAction;
      const sessionKey = action.chatMode === "keep" ? lastKnownChatOf(job.id) ?? chat.createChat(job) : chat.createChat(job);
      schedule(sessionKey, run, job.id);
      return { status: "running", processRef: sessionKey };
    },
    sweep() {
      for (const run of openAgentRuns()) {
        if (!run.processRef) continue;
        schedule(run.processRef, run, run.jobId);
      }
    },
  };

  return {
    executor,
    /** @internal test seam: every pump scheduled so far has settled. */
    async idle(): Promise<void> {
      while (chains.size) await Promise.all([...chains.values()]);
    },
    /** R20: a job turned off (disabled) or deleted archives its last known chat. */
    turnedOff(job: ScheduledJob): void {
      if (job.action.kind !== "agent") return;
      const sessionKey = lastKnownChatOf(job.id);
      if (sessionKey) chat.archiveChat(sessionKey);
    },
  };
}
