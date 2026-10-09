/**
 * A fake `muse exec --json`, a real process.
 *
 * It serves the provider tests, and the point is that it is a PROCESS: the
 * part that truly breaks in a stdio integration is not the semantics, it is
 * everything else — the spawn, the env, the prompt from file, line framing,
 * the child dying mid-turn. A fake in-process peer never touches those pieces.
 *
 * It replays the events measured on the meta provider on 06/10
 * (`muse/WIRE.md`, `muse/fixtures/meta-tool.jsonl`): `payload_type` +
 * `payload` envelope, deltas to concatenate, tools via task events +
 * `tool.result`, and the `run.terminal.*` close.
 *
 * Prompt text drives it (`TOOL`, `SLOW`, `CRASH`, `FAIL`, `NOTERMINAL`): so a
 * test reads in one line and no separate control channel is needed.
 * `--prompt-file` is genuinely read, because that is how the provider passes
 * the prompt; the sid echoes in the text, because that is how the tests verify
 * resume without looking inside the provider.
 *
 * Launched as `bun <this file>` behind a wrapper — see
 * `muse-integration.test.ts`.
 */
import { readFileSync } from "fs";

const argv = process.argv.slice(2);
function flag(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

const sessionId = flag("--session-id") ?? "no-sid";
const promptFile = flag("--prompt-file");
const prompt = promptFile ? readFileSync(promptFile, "utf8") : "";

let seq = 0;
const commandId = "cmd-fake-1";

function emit(payloadType: string, payload: Record<string, unknown>): void {
  seq += 1;
  process.stdout.write(JSON.stringify({
    schema_version: 1,
    id: `fake-${seq}`,
    stream: { kind: "session", id: sessionId },
    sequence: seq,
    recorded_at: 1780531400000000 + seq,
    record_type: "event",
    durability: "durable",
    causation_id: commandId,
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  }) + "\n");
}

function taskEvent(payloadType: string, taskId: string, event: Record<string, unknown>): void {
  emit(payloadType, { task_id: taskId, event: { task_id: taskId, ...event } });
}

// Opening of every turn, like the real one.
emit("runtime.command.accepted", { kind: "command_accepted", command_id: commandId, client_id: null, command_kind: "turn.submit" });
emit("session.run.linked", { kind: "session_run_linked", command_id: commandId, run_stream: { kind: "run", id: commandId } });
emit("run.model.configured", {
  kind: "run_model_configured", command_id: commandId, run_stream: { kind: "run", id: commandId },
  provider_id: "meta", profile_id: "tbh", model_id: "muse-spark-1.3-contributor", display_label: "muse-spark-1.3-contributor", source: "startup",
});
emit("turn.input.user", { kind: "turn_input_user", command_id: commandId, run_stream: { kind: "run", id: commandId }, prompt: prompt.slice(0, 60) });
emit("run.lifecycle.started", { kind: "run_started", command_id: commandId, run_stream: { kind: "run", id: commandId }, prompt: prompt.slice(0, 60) });

const hasHistory = prompt.includes("## Current message");
// `MCP`: echoes the bridge the CLI would mount, read from where the real CLI
// reads it ($XDG_CONFIG_HOME/muse/settings.json), so a test sees the spawn env
// and not a helper's return value.
let mcpTag = "";
if (prompt.includes("MCP")) {
  const dir = process.env.XDG_CONFIG_HOME;
  let bridge = "none";
  try {
    const settings = JSON.parse(readFileSync(`${dir}/muse/settings.json`, "utf8"));
    const topics = settings.mcpServers?.topics;
    if (topics) bridge = `${topics.transport}:${(topics.args as string[]).find((a) => a.startsWith("--session-key=")) ?? "?"}`;
  } catch { /* no staged config: bridge stays "none" */ }
  mcpTag = ` mcp=${bridge}`;
}
const tag = `[sid=${sessionId} history=${hasHistory ? "yes" : "no"}${mcpTag}]`;

if (prompt.includes("TOOL")) {
  const task = "task-fake-read";
  const call = "call_fake1";
  taskEvent("task.lifecycle.proposed", task, { kind: "proposed", task_kind: "tool.read_file" });
  taskEvent("task.lifecycle.side_effect_intent", task, {
    kind: "side_effect_intent", operation: "tool:read_file",
    idempotency_key: `tool:${call}`, policy_decision: "allow:policy",
  });
  taskEvent("task.lifecycle.started", task, { kind: "started" });
  taskEvent("task.lifecycle.output", task, { kind: "output", chunk: "fake file contents", final_result: true });
  taskEvent("task.lifecycle.completed", task, { kind: "completed" });
  emit("tool.result", {
    kind: "tool_result", command_id: commandId, run_stream: { kind: "run", id: commandId },
    call_id: call, text: "fake file contents",
    correlation_facts: { tool_name: "read_file", outcome: "success" },
  });
}

if (prompt.includes("SLOW")) {
  // Announces it has ENTERED the slow turn before hanging: the test must
  // know the turn is ALIVE before aborting it, and the only thing observable
  // from outside is what arrives via the handler. Without this chunk only
  // `await Bun.sleep(150)` would remain, a timed wait that under load is not
  // enough (same lesson as `acp/fake-agent.fixture.ts`).
  emit("run.output.delta", { kind: "run_output_delta", command_id: commandId, run_stream: { kind: "run", id: commandId }, text: "slow:started" });
  await new Promise(() => {});
}

if (prompt.includes("CRASH")) {
  // Dies mid-turn with a nasty stderr line: the provider must log it and
  // NOT forward it to the UI.
  process.stderr.write("fake-muse: boom token sk-secret path /etc/passwd\n");
  process.exit(3);
}

if (prompt.includes("FAIL")) {
  emit("run.terminal.failed", { kind: "run_terminal", command_id: commandId, run_stream: { kind: "run", id: commandId }, terminal: "failed", text: "", reason: "fake model exploded" });
  process.exit(1);
}

if (!prompt.includes("NOTERMINAL")) {
  const head = `echo ${tag} `;
  const tail = prompt.slice(0, 40);
  emit("run.output.delta", { kind: "run_output_delta", command_id: commandId, run_stream: { kind: "run", id: commandId }, text: head });
  emit("run.output.delta", { kind: "run_output_delta", command_id: commandId, run_stream: { kind: "run", id: commandId }, text: tail });
  emit("run.terminal.completed", { kind: "run_terminal", command_id: commandId, run_stream: { kind: "run", id: commandId }, terminal: "completed", text: head + tail, reason: null });
}
process.exit(0);
