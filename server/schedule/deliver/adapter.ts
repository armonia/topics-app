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
import { isAbsolute } from "node:path";
import type { AdapterConfig, Destination } from "./settings";

export interface AdapterValues extends Destination { title: string; jobId: string; runId: string; key: string }

export interface AdapterCall { argv: string[]; env: Record<string, string>; stdin: string }
export interface AdapterResult { exitCode: number; stdout: string; stderr: string }
/** Runs one call. Production spawns a process; tests record what they were given. */
export type AdapterRunner = (call: AdapterCall) => Promise<AdapterResult>;

const PLACEHOLDER = /\{(channel|chat|thread|title|jobId|runId|key)\}/g;
export const ADAPTER_TIMEOUT_MS = 60_000;

const fill = (value: string, values: AdapterValues) => value.replace(PLACEHOLDER, (_all, name: keyof AdapterValues) => values[name]);

/** Fills the placeholders, then takes out every empty argument together with the option that introduced it. */
export function expandArgv(argv: string[], values: AdapterValues): string[] {
  const out: string[] = [];
  for (const item of argv.map((arg) => fill(arg, values))) {
    if (item !== "") { out.push(item); continue; }
    if (out.length > 1 && out[out.length - 1].startsWith("-")) out.pop();
  }
  return out;
}

export function adapterCall(config: AdapterConfig, values: AdapterValues, stdin: string, baseEnv: Record<string, string | undefined> = process.env): AdapterCall {
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

export const spawnAdapter: AdapterRunner = async (call) => {
  const child = Bun.spawn(call.argv, { env: call.env, stdin: new TextEncoder().encode(call.stdin), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), ADAPTER_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); }
};
