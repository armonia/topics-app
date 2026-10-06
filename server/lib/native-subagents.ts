/**
 * Sub-agents on the Topics engine (openspec/changes/subagent-nativi).
 *
 * WHY. Since MSEL-06 chats run on the native engine, but `spawn_agent` always
 * opened a Claude CLI in a PTY: a 160-820 MB process per child, a trust dialog
 * to accept, a prompt that could get lost in the seed. On 04/10 Attilio:
 * «ancora vedo agenti claude code invece che topics». allow-italian: verbatim quote from Attilio
 *
 * WHAT A NATIVE CHILD IS. A chat of its own: a topic with its session key,
 * pinned to the engine (`provider: "topics"`), whose turn starts from the chat
 * route in this process, like the parent's wake-up and the goal loop. Not a
 * turn nested inside the parent's: depth, budget, UI channel and cancellation
 * it already has like any chat (CHAT-NTOOL-03).
 *
 * WHAT STAYS AS IT WAS. The `subagents` row, the caps, result dedup, the
 * foreground wait and the parent's wake-up are the CLI children's: here only
 * how a turn ends is read (from the chat, not from a transcript) and handed
 * to `reportNativeChildTurn`.
 *
 * WITH NO PROCESS THERE IS NOTHING TO PARK. A CLI child stays up 15 minutes
 * past its result and then retires; a native one is already `retired` at its
 * turn's end: it holds no slot, and `send_to_agent` sends it the next turn.
 */
import { getDatabase } from "../db";
import type { StoredMessage, Topic } from "../types";
import type { SubAgentOutcome } from "./subagent-result";
import { getSubagent, insertSubagent, runningSubagents, setSubagentState, type SubagentRow } from "./subagent-store";
import { noteChildSeeded, reportNativeChildTurn, runtimeOf } from "./subagent-runtime";
import { readTurnEnd } from "../providers/turn-end-registry";
import { internalAbortRequest, internalRequest } from "./abort-cause";

type ChatRoute = (req: Request, url: URL, pathname: string, method: string) => Response | null | Promise<Response | null>;

/** What the server lends this module; wired once from `server.ts`. */
export interface NativeSubagentDeps {
  /** The router that answers `/api/chat` and `/api/chat/abort`. */
  route: ChatRoute;
  /** A turn in flight on the session (`activeStreams`). */
  isBusy(sessionKey: string): boolean;
  getTopicBySessionKey(sessionKey: string): Topic | null;
  /** Persist a topic and tell the windows (`topic:created` on a new one). */
  saveTopic(topic: Topic, created: boolean): void;
  loadMessages(sessionKey: string): StoredMessage[];
  /** The engine can take a turn now: false sends the spawn down the CLI road. */
  engineReady(): boolean;
  /** A person opened this child's chat: it stays open when its turn ends. */
  engaged?(topicId: string): boolean;
  log?(msg: string): void;
}

let deps: NativeSubagentDeps | null = null;
export function configureNativeSubagents(d: NativeSubagentDeps | null): void {
  deps = d;
}

/** The engine can run a child now: wired, and connected. */
export function nativeSubagentsAvailable(): boolean {
  if (!deps) return false;
  try { return deps.engineReady(); } catch { return false; }
}

export { engineToolsOfProfile } from "./subagent-tool-policy";

/**
 * The aliases `spawn_agent` accepts, in the model the engine runs: the newest
 * of each family in the proven catalog (`MODELS` in
 * `providers/native/provider.ts`). A full id passes through; one the engine
 * cannot run is dropped by the chat route, which falls back to the default.
 */
const ENGINE_ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", fable: "claude-fable-5-1", haiku: "claude-haiku-4-5-20251001",
};

export function engineModelOf(model: string | null): string | null {
  if (!model) return null;
  const m = /^(opus|sonnet|fable|haiku)(\[1m\])?$/.exec(model.trim().toLowerCase());
  if (!m) return model;
  const id = ENGINE_ALIASES[m[1]!]!;
  // Only these two run the long window on the engine today.
  return m[2] && (id === "claude-opus-5-5" || id === "claude-sonnet-5-5") ? `${id}[1m]` : id;
}

/**
 * Where a native child stands: the project (and worktree) of its chat. The
 * engine works in the chat's project, not in some random folder, and a
 * `projectPath` widens the file routes to that folder: that is why a `cwd`
 * Topics does not know as a project never becomes a child's home. `ok: false`
 * means the child stays on the CLI, or is refused when the caller asked for
 * the engine.
 */
export function nativeChildPlace(input: {
  explicitCwd: string | null;
  parentTopic: Pick<Topic, "projectPath" | "worktreeId"> | null;
  parentCwd: string | null;
  knownProject: (path: string) => boolean;
}): { ok: true; projectPath: string | null; worktreeId: string | null } | { ok: false; reason: string } {
  const { explicitCwd, parentTopic, parentCwd, knownProject } = input;
  if (explicitCwd) {
    if (explicitCwd === parentTopic?.projectPath || knownProject(explicitCwd)) return { ok: true, projectPath: explicitCwd, worktreeId: null };
    return { ok: false, reason: `cwd ${explicitCwd} is not a project Topics knows` };
  }
  if (parentTopic) return { ok: true, projectPath: parentTopic.projectPath ?? null, worktreeId: parentTopic.worktreeId ?? null };
  if (parentCwd && knownProject(parentCwd)) return { ok: true, projectPath: parentCwd, worktreeId: null };
  return { ok: false, reason: `the parent's directory${parentCwd ? ` ${parentCwd}` : ""} is not a project Topics knows` };
}

// ── This process's state ───────────────────────────────────────────────────────

/** Children whose turn this process is driving: their stop must not be read as an end. */
const driving = new Set<string>();
/** Children stopped by their parent (its `stop_agent`, or a person's Stop on it). */
const stoppedByParent = new Set<string>();

const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); });

/** How long a spawn waits for the chat route to take the first turn: normally milliseconds. */
const DISPATCH_WAIT_MS = 30_000;

// ── The spawn ──────────────────────────────────────────────────────────────────

export interface NativeSpawn {
  id: string;
  parentSessionKey: string;
  name: string;
  prompt: string;
  /** The directory the child works in: the parent's, a `cwd` asked for, or its worktree. */
  cwd: string;
  /** The parent chat, when it is one: the child takes its autonomy and colour. */
  parentTopic: Topic | null;
  /** The child chat's project, decided by the route: null = a chat without one, like its parent. */
  projectPath: string | null;
  worktreeId: string | null;
  branch: string | null;
  model: string | null;
  effort: string | null;
  agentType: string | null;
  /** The profile's own instructions, as the child's system prompt. */
  instructions: string | null;
  tools: string[] | null;
  promptSnippet: string | null;
}

/**
 * The child's chat is born and its first turn starts. It returns once the
 * first turn has been handed to the chat route (an answer received, even a
 * refusal): the caller knows the turn left, not just that the chat exists.
 * The turn then runs on its own, and its outcome follows the road of all
 * children (the parent's wake-up, or `read_agent` for a terminal parent). If
 * the route does not answer within the cap, it returns anyway: the turn stays
 * in flight as before, and the spawn never hangs on a wedged engine.
 */
export async function spawnNativeChild(s: NativeSpawn): Promise<{ sessionKey: string; topic: Topic }> {
  if (!deps) throw new Error("native sub-agents are not wired");
  const now = new Date().toISOString();
  const parent = s.parentTopic;
  const topic: Topic = {
    id: s.id,
    name: s.name,
    slug: s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || s.id.slice(0, 8),
    parentId: null,
    links: [],
    sessionKey: `topic:${s.id.slice(0, 8)}`,
    color: parent?.color ?? "#5865f2",
    icon: "Bot",
    createdAt: now,
    updatedAt: now,
    archived: false,
    systemPrompt: s.instructions ?? "",
    contextFiles: [],
    pinnedMessages: [],
    // The engine, spelled out: a child must not fall through to the CLI on a default.
    provider: "topics",
    // Projected from `subagents` on every later read; set here too because the
    // row is written after this save, and the broadcast carries this object.
    subagentOf: s.parentSessionKey,
    model: s.model,
    effort: s.effort,
    ...(parent?.autonomyLevel ? { autonomyLevel: parent.autonomyLevel } : {}),
    ...(s.worktreeId ? { worktreeId: s.worktreeId } : {}),
    // The child stands where the parent stands (SUBAGENT-17); a worktree child
    // keeps the project for the sidebar and works in its checkout.
    ...(s.projectPath ? { projectPath: s.projectPath } : {}),
    ...(parent?.standalone ? { standalone: true } : {}),
  } as Topic;
  deps.saveTopic(topic, true);
  insertSubagent(getDatabase(), {
    id: s.id, parentSessionKey: s.parentSessionKey, name: s.name, model: s.model, agentType: s.agentType, effort: s.effort,
    promptSnippet: s.promptSnippet, cwd: s.cwd, branch: s.branch, claudeSessionId: null, createdAt: now,
    runtime: "topics", sessionKey: topic.sessionKey, tools: s.tools,
  });
  let dispatch!: () => void;
  const dispatched = new Promise<void>((resolve) => { dispatch = resolve; });
  void driveTurn(s.id, s.prompt, dispatch);
  // The chat exists already; what the caller waits for is the turn leaving:
  // bounded, so a wedged engine costs one warning, not a hung spawn.
  await Promise.race([
    dispatched,
    sleep(DISPATCH_WAIT_MS).then(() => {
      deps?.log?.(`spawn ${s.id}: the chat route did not take the first turn within ${DISPATCH_WAIT_MS} ms, answering anyway`);
    }),
  ]);
  return { sessionKey: topic.sessionKey, topic };
}

/**
 * The next turn: `send_to_agent` on a native child. A child mid-turn refuses
 * (409): its outcome arrives on its own, and two turns on the same chat never
 * queue here. A finished, retired or stopped one restarts from its chat.
 */
export function sendToNativeChild(row: SubagentRow, input: string): { ok: true; resumed: boolean } | { ok: false; status: number; error: string } {
  if (!deps) return { ok: false, status: 503, error: "native sub-agents are not wired" };
  if (!row.sessionKey) return { ok: false, status: 410, error: `sub-agent "${row.name}" has no chat` };
  if (driving.has(row.id) || deps.isBusy(row.sessionKey)) {
    return { ok: false, status: 409, error: `sub-agent "${row.name}" is still working on its turn: its result will arrive by itself` };
  }
  const resumed = row.state !== "running";
  const topic = deps.getTopicBySessionKey(row.sessionKey);
  if (topic?.archived) deps.saveTopic({ ...topic, archived: false, updatedAt: new Date().toISOString() }, false);
  void driveTurn(row.id, input);
  return { ok: true, resumed };
}

/**
 * `stop_agent` (or the parent's Stop): the running turn is cancelled the way
 * of every Stop, and its outcome leaves as `stopped` from the parent. An idle
 * child produces no second outcome (SUBAGENT-11). `archive` takes the chat out
 * of view the way the CLI closed its pane; `send_to_agent` reopens it.
 */
export async function stopNativeChild(row: SubagentRow, opts: { archive: boolean }): Promise<void> {
  if (!deps || !row.sessionKey) return;
  const sessionKey = row.sessionKey;
  stoppedByParent.add(row.id);
  if (driving.has(row.id) || deps.isBusy(sessionKey)) {
    const req = internalAbortRequest(sessionKey, "user");
    const url = new URL(req.url);
    await Promise.resolve(deps.route(req, url, url.pathname, "POST")).catch((err) => deps?.log?.(`stop ${row.id}: ${err instanceof Error ? err.message : String(err)}`));
  } else {
    stoppedByParent.delete(row.id);
  }
  setSubagentState(getDatabase(), row.id, "stopped");
  if (opts.archive) {
    const topic = deps.getTopicBySessionKey(sessionKey);
    if (topic && !topic.archived) deps.saveTopic({ ...topic, archived: true, updatedAt: new Date().toISOString() }, false);
  }
}

/**
 * A person's Stop on the parent also stops the native children working for
 * it: without this, that turn would run on and wake the parent that had just
 * stopped. The chats stay open; the children are picked up again with
 * `send_to_agent`. Returns how many it stopped.
 */
export async function stopNativeChildrenOf(parentSessionKey: string): Promise<number> {
  if (!deps) return 0;
  let stopped = 0;
  for (const row of runningSubagents(getDatabase(), parentSessionKey)) {
    if (row.runtime !== "topics" || !row.sessionKey) continue;
    if (!driving.has(row.id) && !deps.isBusy(row.sessionKey)) continue;
    await stopNativeChild(row, { archive: false });
    stopped++;
  }
  return stopped;
}

// ── The turn ───────────────────────────────────────────────────────────────────

/** The assistant rows written for the turn that started at `sinceMs`. */
function turnRows(sessionKey: string, sinceMs: number): StoredMessage[] {
  const rows = deps?.loadMessages(sessionKey) ?? [];
  // One second of slack: the row's timestamp is the server's clock, as ours.
  return rows.filter((m) => m.role === "assistant" && Date.parse(m.timestamp) >= sinceMs - 1_000);
}

/** How a turn of a child chat ended, read from the chat: its end, and its last words. */
export function nativeTurnOutcome(input: {
  end: { end: string; detail?: string } | null;
  text: string;
  routeError?: string | null;
  stopped: boolean;
}): SubAgentOutcome {
  const text = input.text.trim();
  if (input.routeError) return { status: "failed", partial: false, text, reason: { code: "api-error", detail: input.routeError } };
  // The parent's stop never wakes it (`resultWakesParent`); a person's Stop on
  // the child's own chat does, like a closed tab of a CLI child.
  if (input.stopped) return { status: "stopped", partial: true, text, reason: { code: "stopped-by-parent" } };
  if (input.end?.end === "cancelled") return { status: "stopped", partial: true, text };
  if (!input.end) {
    // No end on record: a turn that left words behind is read as done, the
    // way the CLI's last `end_turn` is; one that left nothing was cut.
    return text ? { status: "completed", partial: false, text } : { status: "failed", partial: true, text, reason: { code: "exited-mid-turn" } };
  }
  if (input.end.end === "end_turn") return { status: "completed", partial: false, text };
  return { status: "failed", partial: true, text, reason: { code: "api-error", detail: input.end.detail ? `${input.end.end}: ${input.end.detail}` : input.end.end } };
}

/**
 * The turn of a child: sent through the chat route, drained, read, reported.
 * `onDispatched` fires once the route call settles (an answer or a throw):
 * the spawn answers on it, so a 200 means the turn left, not just that the
 * chat exists.
 */
async function driveTurn(id: string, text: string, onDispatched?: () => void): Promise<void> {
  const d = deps;
  const row0 = getSubagent(getDatabase(), id);
  if (!d || !row0?.sessionKey) { onDispatched?.(); return; }
  const sessionKey = row0.sessionKey;
  driving.add(id);
  stoppedByParent.delete(id);
  setSubagentState(getDatabase(), id, "running");
  noteChildSeeded(id, { working: true });
  const sentAt = Date.now();
  let routeError: string | null = null;
  let resp: Response | null = null;
  try {
    const url = new URL("http://localhost/api/chat");
    resp = await d.route(
      internalRequest(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: text }] }),
      }),
      url, "/api/chat", "POST",
    );
  } catch (err) {
    routeError = err instanceof Error ? err.message : String(err);
  }
  onDispatched?.();
  try {
    if (!resp?.ok) {
      // A throw above already named the failure; this names a refusal.
      if (!routeError) {
        const body = resp ? await resp.json().catch(() => null) as { error?: unknown } | null : null;
        routeError = `the chat route answered ${resp?.status ?? "nothing"}${typeof body?.error === "string" ? `: ${body.error}` : ""}`;
      }
    } else if (resp.body) {
      // The stream is the turn: read to its end. The route keeps writing the
      // rows on its own, a reader that walked away would change nothing.
      const reader = resp.body.getReader();
      for (;;) { const r = await reader.read(); if (r.done) break; }
    }
    // The stream can close a beat before the route lets the session go.
    for (let i = 0; i < 120 && d.isBusy(sessionKey); i++) await sleep(250);
  } catch (err) {
    routeError = err instanceof Error ? err.message : String(err);
  }
  await reportTurn(id, sentAt, routeError);
  driving.delete(id);
}

/** Read the turn that started at `sentAt` off the child's chat and hand it to the parent. */
async function reportTurn(id: string, sentAt: number, routeError: string | null, lost = false): Promise<void> {
  const db = getDatabase();
  const row = getSubagent(db, id);
  if (!row?.sessionKey) return;
  const recorded = readTurnEnd(row.sessionKey);
  const end = recorded && recorded.atMs >= sentAt - 1_000 ? recorded.info : null;
  const rows = turnRows(row.sessionKey, sentAt);
  const last = rows.at(-1);
  const byParent = stoppedByParent.delete(id);
  const outcome: SubAgentOutcome = lost && !end
    ? { status: "lost", partial: true, text: last?.content ?? "", reason: { code: "exited-mid-turn" } }
    : nativeTurnOutcome({ end, text: last?.content ?? "", routeError, stopped: byParent });
  const durationMs = last?.latencyMs ?? (last ? Date.parse(last.timestamp) - sentAt : null);
  reportNativeChildTurn(
    { id, name: row.name, cwd: row.cwd, parentSessionKey: row.parentSessionKey },
    row.turnsReported + 1,
    outcome,
    { model: (last as { model?: string } | undefined)?.model ?? row.model, durationMs: durationMs != null && durationMs >= 0 ? durationMs : null },
    { stoppedByParent: byParent },
  );
  // No process to park: the turn is over, the slot is free. A stop already
  // wrote `stopped`, and that is what it stays.
  const retiredNow = getSubagent(db, id)?.state === "running";
  if (retiredNow) setSubagentState(db, id, "retired");
  runtimeOf(id).phase = "finished";
  // Like the Agent tool's children: a turn that ended on its own, its result delivered, leaves the view.
  // `send_to_agent` brings it back (it unarchives). A stopped child stays to be read, and so does
  // one the person opened.
  const topic = retiredNow && outcome.status === "completed" ? deps?.getTopicBySessionKey(row.sessionKey) : null;
  if (deps && topic && !topic.archived && !deps.engaged?.(topic.id)) {
    deps.saveTopic({ ...topic, archived: true, updatedAt: new Date().toISOString() }, false);
  }
}

/**
 * After a restart: native children still `running` have no process to find
 * again, but their turn may restart with the chats' own resume. The chat is
 * watched for a minute: a living turn is awaited and reported, one that does
 * not come back is reported `lost` with what it had written.
 */
export async function adoptNativeChildrenAtBoot(opts: { waitMs?: number; pollMs?: number } = {}): Promise<void> {
  const d = deps;
  if (!d) return;
  const waitMs = opts.waitMs ?? 60_000;
  const pollMs = opts.pollMs ?? 1_000;
  const rows = runningSubagents(getDatabase()).filter((r) => r.runtime === "topics" && r.sessionKey && !driving.has(r.id));
  await Promise.all(rows.map(async (row) => {
    const sessionKey = row.sessionKey!;
    const since = Date.parse(row.reportedAt ?? row.createdAt) || 0;
    noteChildSeeded(row.id, { working: true });
    const until = Date.now() + waitMs;
    while (!d.isBusy(sessionKey) && Date.now() < until) await sleep(pollMs);
    if (!d.isBusy(sessionKey)) {
      await reportTurn(row.id, since, null, true);
      return;
    }
    driving.add(row.id);
    while (d.isBusy(sessionKey)) await sleep(pollMs);
    await reportTurn(row.id, since, null);
    driving.delete(row.id);
  }));
}

// ── read_agent ───────────────────────────────────────────────────────────────

/**
 * `read_agent` on a native child: its answers and its tool calls, from the
 * chat. The offset is a row index, not a byte: it is the unit the chat has,
 * and the caller passes it back unread.
 */
export function readNativeChildOutput(row: SubagentRow, since: number): { events: Array<{ type: "assistant" | "tool_use"; text?: string; name?: string; input?: unknown }>; nextOffset: number; source: "chat" } {
  const rows = row.sessionKey && deps ? deps.loadMessages(row.sessionKey) : [];
  const start = Number.isFinite(since) && since >= 0 && since <= rows.length ? since : 0;
  const events: Array<{ type: "assistant" | "tool_use"; text?: string; name?: string; input?: unknown }> = [];
  for (const m of rows.slice(start)) {
    if (m.role !== "assistant") continue;
    for (const t of m.toolCalls ?? []) events.push({ type: "tool_use", name: t.name, input: t.args });
    if (m.content) events.push({ type: "assistant", text: m.content });
  }
  return { events, nextOffset: rows.length, source: "chat" };
}

/** Test seam: forget what this process drives. */
export function _resetNativeSubagents(): void {
  driving.clear();
  stoppedByParent.clear();
  deps = null;
}
