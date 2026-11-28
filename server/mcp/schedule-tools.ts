/**
 * SCHEDULED JOBS FOR AGENTS (rule R26 of change lavori-programmati-in-topics).
 *
 * Five tools over `/api/scheduled-jobs`: create, list, run now, pause, delete.
 * The tools never turn a job ON: a job an agent creates is born paused when it
 * has a delivery, and always with the app setting `ask` (the default); the
 * person turns it on. That rule lives in the server (`jobs-service.ts`), keyed
 * on the creator name written here (`agent:<session>`), so it holds for any
 * caller that signs this way.
 *
 * In a module of its own, like the command tools: the bridge file is the
 * dispatcher and `check:bloat` counts its lines.
 */
import { httpJson, type ParsedArgs } from "./topics-http";

const JOBS_PATH = "/api/scheduled-jobs";
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export const SCHEDULE_TOOLS = [
  {
    name: "create_scheduled_job",
    description:
      "Create a scheduled job: a command that Topics runs on a schedule and whose output can be delivered to the person outside the app. THE JOB IS BORN PAUSED when it has a `deliver` block, and also whenever the app setting asks for confirmation (the default): the person turns it on, you cannot. `schedule` is one of {kind:'cron', expr:'0 9 * * *', tz:'UTC'}, {kind:'every', minutes:30} or {kind:'at', at:'<ISO instant in the future>'}. `command` is an argv (a list of strings, no shell). `deliver` is {to:'owner'} (the destination the person configured) and is optional: with none the outcome stays in Topics. Returns the job with its id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "What the job does, in a few words, as the person will read it." },
        schedule: { type: "object", description: "cron {kind, expr, tz} | every {kind, minutes} | at {kind, at}." },
        command: { type: "array", items: { type: "string" }, description: "The argv to run, for example ['bun','run','report']. No shell is involved." },
        cwd: { type: "string", description: "Absolute directory to run in. Omit when project_id is given." },
        project_id: { type: "string", description: "The project the job belongs to; its directory is the default cwd." },
        stdin: { type: "string", description: "Optional text for the command's stdin." },
        timeout_sec: { type: "number", description: "Time limit in seconds. Default 3600." },
        deliver: { type: "object", description: "Optional {to:'owner'}: send the command's output to the destination the person configured." },
      },
      required: ["name", "schedule", "command"],
    },
    annotations: { ...WRITES, title: "Crea un lavoro programmato" },
  },
  {
    name: "list_scheduled_jobs",
    description: "List the scheduled jobs with their schedule, whether they are on, the next run and the last run's outcome.",
    inputSchema: { type: "object", properties: { project_id: { type: "string", description: "Only the jobs of this project." } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: "Elenca i lavori programmati" },
  },
  {
    name: "run_scheduled_job",
    description: "Run a scheduled job now, outside its schedule. It does not move the next scheduled run. Returns the run.",
    inputSchema: { type: "object", properties: { job_id: { type: "string", description: "Job id from list_scheduled_jobs." } }, required: ["job_id"] },
    annotations: { ...WRITES, title: "Esegui un lavoro programmato ora" },
  },
  {
    name: "pause_scheduled_job",
    description: "Pause a scheduled job: it stops running until the person turns it on again. There is no tool to turn a job on.",
    inputSchema: { type: "object", properties: { job_id: { type: "string", description: "Job id from list_scheduled_jobs." } }, required: ["job_id"] },
    annotations: { ...WRITES, idempotentHint: true, title: "Metti in pausa un lavoro programmato" },
  },
  {
    name: "delete_scheduled_job",
    description: "Delete a scheduled job. A run in flight is stopped and nothing is delivered for it; its history is kept.",
    inputSchema: { type: "object", properties: { job_id: { type: "string", description: "Job id from list_scheduled_jobs." } }, required: ["job_id"] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false, title: "Cancella un lavoro programmato" },
  },
];

interface JobView { id: string; name: string; enabled: boolean; schedule: unknown; nextRunAt: string | null; lastRun: { status: string; finishedAt: string | null } | null }

const need = (tool: string, field: string, value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${tool}: '${field}' (non-empty string) is required`);
  return value.trim();
};
/** `httpJson` answers nothing for an empty body; every call here expects a JSON answer. */
const answer = <T>(tool: string, value: T | undefined): T => {
  if (value === undefined) throw new Error(`${tool}: the server sent no answer`);
  return value;
};
const pathOf = (jobId: string, rest = "") => `${JOBS_PATH}/${encodeURIComponent(jobId)}${rest}`;
const line = (job: JobView) => `${job.id} · ${job.name} · ${job.enabled ? "on" : "paused"} · ${JSON.stringify(job.schedule)} · next ${job.nextRunAt ?? "none"} · last ${job.lastRun ? job.lastRun.status : "never"}`;

export async function callCreateScheduledJob(args: ParsedArgs, input: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<string> {
  const name = need("create_scheduled_job", "name", input.name);
  if (!Array.isArray(input.command) || !input.command.every((item) => typeof item === "string")) throw new Error("create_scheduled_job: 'command' must be a list of strings");
  const action = {
    kind: "command", argv: input.command,
    ...(typeof input.cwd === "string" && input.cwd ? { cwd: input.cwd } : {}),
    ...(typeof input.stdin === "string" ? { stdin: input.stdin } : {}),
    ...(typeof input.timeout_sec === "number" ? { timeoutSec: input.timeout_sec } : {}),
  };
  const body = {
    name, schedule: input.schedule, action, createdBy: `agent:${args.sessionKey}`,
    ...(typeof input.project_id === "string" && input.project_id ? { projectId: input.project_id } : {}),
    ...(input.deliver && typeof input.deliver === "object" ? { deliver: input.deliver } : {}),
  };
  const job = answer("create_scheduled_job", await httpJson<JobView>(args, "POST", JOBS_PATH, body, fetchImpl));
  return job.enabled ? `created and on · ${line(job)}` : `created PAUSED, the person turns it on · ${line(job)}`;
}

export async function callListScheduledJobs(args: ParsedArgs, input: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<string> {
  const query = typeof input.project_id === "string" && input.project_id ? `?projectId=${encodeURIComponent(input.project_id)}` : "";
  const { jobs } = answer("list_scheduled_jobs", await httpJson<{ jobs: JobView[] }>(args, "GET", `${JOBS_PATH}${query}`, undefined, fetchImpl));
  return jobs.length ? jobs.map(line).join("\n") : "no scheduled jobs";
}

export async function callRunScheduledJob(args: ParsedArgs, input: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<string> {
  const run = answer("run_scheduled_job", await httpJson<{ id: string; status: string }>(args, "POST", pathOf(need("run_scheduled_job", "job_id", input.job_id), "/run"), {}, fetchImpl));
  return `run ${run.id} · ${run.status}`;
}

export async function callPauseScheduledJob(args: ParsedArgs, input: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<string> {
  const job = answer("pause_scheduled_job", await httpJson<JobView>(args, "PATCH", pathOf(need("pause_scheduled_job", "job_id", input.job_id)), { enabled: false }, fetchImpl));
  return `paused · ${line(job)}`;
}

export async function callDeleteScheduledJob(args: ParsedArgs, input: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<string> {
  const id = need("delete_scheduled_job", "job_id", input.job_id);
  await httpJson(args, "DELETE", pathOf(id), undefined, fetchImpl);
  return `deleted ${id}`;
}
