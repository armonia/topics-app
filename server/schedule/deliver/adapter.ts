/**
 * THE ADAPTER: ONE COMMAND THAT CARRIES A TEXT OUT OF THE APP (rule R21).
 *
 * The text goes on stdin. The command is an argv with placeholders
 * (`{channel} {chat} {thread} {title} {jobId} {runId} {key}`) plus environment
 * variables. An argument that is empty once filled takes its option out with it
 * (`--thread {thread}` with no thread leaves neither), and the executable is
 * resolved to an absolute path before it runs. stderr is read for the error
 * message only: it never leaves the app.
 */
import { withoutGatewayToken } from "../../lib/child-env";
import { isAbsolute } from "node:path";
import type { AdapterConfig, Destination } from "./settings";

export interface AdapterValues extends Destination { title: string; jobId: string; runId: string; key: string }

export interface AdapterCall { argv: string[]; env: Record<string, string>; stdin: string }
export interface AdapterResult {
  exitCode: number; stdout: string; stderr: string;
  /** The call went over its time limit, or left a pipe open after the process ended: it may have gone out. */
  timedOut?: boolean;
  /** The signal that ended the process, when it did not exit by itself. */
  signalCode?: string | null;
}
/** Runs one call. Production spawns a process; tests record what they were given. */
export type AdapterRunner = (call: AdapterCall) => Promise<AdapterResult>;

const PLACEHOLDER_TEST = /\{(channel|chat|thread|title|jobId|runId|key)\}/;
const PLACEHOLDER = /\{(channel|chat|thread|title|jobId|runId|key)\}/g;
export const ADAPTER_TIMEOUT_MS = 60_000;

const fill = (value: string, values: AdapterValues) => value.replace(PLACEHOLDER, (_all, name: keyof AdapterValues) => values[name]);

/**
 * Fills the placeholders, then takes out every empty argument together with the option that introduced it.
 * Only a literal option of the configuration counts as an introducer (`--thread {thread}`): a value that
 * merely starts with a dash, like a negative chat id in a positional slot, is never removed. The
 * executable (first item) is never filled: a job title must not choose what runs.
 */
export function expandArgv(argv: string[], values: AdapterValues): string[] {
  const out: string[] = [];
  let introducer = false;
  argv.forEach((template, index) => {
    const item = index === 0 ? template : fill(template, values);
    if (item !== "") {
      out.push(item);
      introducer = index > 0 && /^-/.test(template) && !PLACEHOLDER_TEST.test(template);
      return;
    }
    if (introducer && out.length > 1) out.pop();
    introducer = false;
  });
  return out;
}

export function adapterCall(config: AdapterConfig, values: AdapterValues, stdin: string, baseEnv: Record<string, string | undefined> = withoutGatewayToken(process.env)): AdapterCall {
  const argv = expandArgv(config.argv, values);
  const executable = argv[0];
  // A bare name is looked up on the PATH once, here: what runs is a path, never a shell word.
  const resolved = executable && !isAbsolute(executable) ? Bun.which(executable) : executable;
  if (!resolved) throw new Error(`The delivery adapter "${executable ?? ""}" was not found.`);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseEnv)) if (typeof value === "string") env[name] = value;
  for (const [name, value] of Object.entries(config.env)) env[name] = fill(value, values);
  env.TOPICS_DELIVERY_KEY = values.key;
  env.TOPICS_JOB_ID = values.jobId;
  env.TOPICS_JOB_RUN_ID = values.runId;
  return { argv: [resolved, ...argv.slice(1)], env, stdin };
}

export interface SpawnLimits {
  /** Hard limit on the whole call. */
  timeoutMs: number;
  /** How long the pipes may stay open after the process itself is gone. */
  pipeGraceMs: number;
}
const DEFAULT_LIMITS: SpawnLimits = { timeoutMs: ADAPTER_TIMEOUT_MS, pipeGraceMs: 2_000 };

/** The process and everything it started: its own group on a POSIX system, the tree on Windows. */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", timeout: 5_000 });
    else process.kill(-pid, "SIGKILL");
  } catch { /* already gone */ }
}

/** Reads a pipe into text as it comes, so what was written before a kill is still there. */
function collect(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    try { for await (const chunk of stream) text += decoder.decode(chunk, { stream: true }); } catch { /* a closed pipe ends the read */ }
  })();
  return { done, text: () => text };
}

const after = (ms: number) => new Promise<"late">((resolve) => { setTimeout(() => resolve("late"), ms).unref?.(); });

/**
 * Production runner. The process leads a group of its own so a grandchild that
 * keeps stdout open cannot hold the sweep: past the time limit, or past a short
 * grace once the process itself is gone, the group is killed and the call is
 * reported as `timedOut` (it may have gone out, so nobody sends it again).
 */
export function createSpawnAdapter(limits: SpawnLimits = DEFAULT_LIMITS): AdapterRunner {
  return async (call) => {
    const child = Bun.spawn(call.argv, { env: call.env, stdin: new TextEncoder().encode(call.stdin), stdout: "pipe", stderr: "pipe", detached: true });
    const out = collect(child.stdout);
    const err = collect(child.stderr);
    let timedOut = false;
    const exited = await Promise.race([child.exited.then(() => "exited" as const), after(limits.timeoutMs)]);
    if (exited === "late") {
      timedOut = true;
      killTree(child.pid);
      await Promise.race([child.exited, after(limits.pipeGraceMs)]);
    }
    const piped = await Promise.race([Promise.all([out.done, err.done]).then(() => "closed" as const), after(limits.pipeGraceMs)]);
    if (piped === "late") {
      timedOut = true;
      killTree(child.pid);
    }
    return { exitCode: child.exitCode ?? -1, signalCode: child.signalCode ?? null, timedOut, stdout: out.text(), stderr: err.text() };
  };
}

export const spawnAdapter: AdapterRunner = createSpawnAdapter();
