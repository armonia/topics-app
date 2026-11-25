/** Process tools: run_script and the list, read, wait and stop of tracked processes. */
import { httpJson } from "./topics-http";
import type { ParsedArgs } from "./topics-http";
import type { ProcessOutputResp, ProcessWaitResp, RunScriptResp, ScriptRow, ScriptsResp } from "./bridge-shared";

export async function callRunScript(
  args: ParsedArgs,
  toolArgs: { script?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.script !== "string" || !toolArgs.script) {
    throw new Error("run_script: 'script' (string) is required");
  }
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/scripts/run`;
  const body = await httpJson<RunScriptResp>(args, "POST", path, { scriptName: toolArgs.script }, fetchImpl);
  if (typeof body?.processId !== "string") {
    throw new Error("run_script: server did not return a processId");
  }
  return `started · processId=${body.processId} · pid=${body.pid ?? "?"} — read output with read_process_output(process_id="${body.processId}")`;
}

export async function callListProcesses(
  args: ParsedArgs,
  _toolArgs: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/scripts`;
  const body = await httpJson<ScriptsResp>(args, "GET", path, undefined, fetchImpl);
  const scripts = Array.isArray(body?.scripts) ? body.scripts : [];
  if (!scripts.length) return "No processes running or recent.";
  return scripts.map((s: ScriptRow) => {
    const ports = Array.isArray(s.ports) && s.ports.length ? ` ports=${s.ports.join(",")}` : "";
    const exit = s.exitCode !== undefined && s.exitCode !== null ? ` exit=${s.exitCode}` : "";
    return `[${s.status}] ${s.scriptName} id=${s.processId} pid=${s.pid ?? "?"}${ports}${exit}`;
  }).join("\n");
}

export async function callReadProcessOutput(
  args: ParsedArgs,
  toolArgs: { process_id?: unknown; offset?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.process_id !== "string" || !toolArgs.process_id) {
    throw new Error("read_process_output: 'process_id' (string) is required");
  }
  const offset = typeof toolArgs.offset === "number" ? toolArgs.offset : 0;
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/scripts/${encodeURIComponent(toolArgs.process_id)}/output?offset=${offset}`;
  const body = await httpJson<ProcessOutputResp>(args, "GET", path, undefined, fetchImpl);

  let output = typeof body?.output === "string" ? body.output : "";
  const MAX = 8000;
  let head = "";
  if (output.length > MAX) {
    output = output.slice(-MAX);
    head = "…(truncated, showing tail; call again with the returned offset to page)\n";
  }
  const exit = body?.exitCode !== undefined && body?.exitCode !== null ? ` exit=${body.exitCode}` : "";
  const footer = `[offset=${body?.offset ?? 0} status=${body?.status ?? "?"}${body?.done ? " done" : ""}${exit}]`;
  return `${head}${output}\n${footer}`;
}

/**
 * L'attesa vista dal ponte MCP. Il lavoro vero e' della rotta, che tiene aperta
 * la richiesta; qui si compone la risposta in modo che una scadenza si legga
 * come «ancora vivo» e non come un guasto — la differenza fra un agente che
 * richiama con il cursore giusto e uno che si ferma credendo di aver rotto
 * qualcosa.
 */
export async function callWaitForProcess(
  args: ParsedArgs,
  toolArgs: { process_id?: unknown; until?: unknown; timeout_ms?: unknown; offset?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.process_id !== "string" || !toolArgs.process_id) {
    throw new Error("wait_for_process: 'process_id' (string) is required");
  }
  const qs = new URLSearchParams();
  if (typeof toolArgs.offset === "number") qs.set("offset", String(toolArgs.offset));
  if (typeof toolArgs.timeout_ms === "number") qs.set("timeout_ms", String(toolArgs.timeout_ms));
  if (typeof toolArgs.until === "string" && toolArgs.until) qs.set("until", toolArgs.until);
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/scripts/${encodeURIComponent(toolArgs.process_id)}/wait?${qs}`;

  // Il margine sopra il tetto della rotta: se scade questo vuol dire che a non
  // rispondere e' il server, non il processo atteso.
  const budget = (typeof toolArgs.timeout_ms === "number" ? Math.min(toolArgs.timeout_ms, 240_000) : 120_000) + 20_000;
  // A stopped turn of the native runtime closes the request: left open, the
  // loop sat in it for minutes and the route's watch still counted the wake
  // as taken.
  const deadline = AbortSignal.timeout(budget);
  const signal = args.turnSignal ? AbortSignal.any([deadline, args.turnSignal]) : deadline; // allow-any: the method that joins two signals, not the type
  const body = await httpJson<ProcessWaitResp>(args, "GET", path, undefined, fetchImpl, signal);

  let output = typeof body?.output === "string" ? body.output : "";
  const MAX = 8000;
  let head = "";
  if (output.length > MAX) {
    output = output.slice(-MAX);
    head = "…(truncated, showing tail; re-read from the returned offset to page)\n";
  }
  const reason = body?.reason ?? "timeout";
  const secs = Math.round((body?.waitedMs ?? 0) / 1000);
  const exit = body?.exitCode !== undefined && body?.exitCode !== null ? ` exit=${body.exitCode}` : "";
  // A match on the last lines of a process that has ended: the route settles
  // its wake on this answer, so the outcome has to be in it.
  const ended = body?.status !== undefined && body.status !== "running";
  const verdict = reason === "exit"
    ? `finished after ${secs}s · status=${body?.status ?? "?"}${exit}`
    : reason === "match"
      ? `matched after ${secs}s · ${ended ? `finished · status=${body.status}${exit}` : "still running"}`
      : `STILL RUNNING after ${secs}s (not an error) · call wait_for_process again with offset=${body?.offset ?? 0}`;
  const lost = body?.truncatedLines ? ` dropped=${body.truncatedLines}` : "";
  return `${head}${output}\n[reason=${reason} offset=${body?.offset ?? 0}${lost}] ${verdict}`;
}

export async function callStopProcess(
  args: ParsedArgs,
  toolArgs: { process_id?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (typeof toolArgs?.process_id !== "string" || !toolArgs.process_id) {
    throw new Error("stop_process: 'process_id' (string) is required");
  }
  const path = `/api/sessions/${encodeURIComponent(args.sessionKey)}/scripts/${encodeURIComponent(toolArgs.process_id)}/stop`;
  await httpJson<{ ok?: boolean }>(args, "POST", path, {}, fetchImpl);
  return `stopped ${toolArgs.process_id}`;
}
