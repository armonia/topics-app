/**
 * Sub-agents on the Topics engine (openspec/changes/subagent-nativi).
 *
 * WHY. Since MSEL-06 chats run on the native engine, but `spawn_agent` still
 * opened a Claude CLI in a PTY: a 160-820 MB process per child, a trust dialog
 * to accept, a prompt that could get lost in the seed. On 04/10 the user said
 * they still saw Claude Code agents instead of Topics ones.
 *
 * WHAT A NATIVE CHILD IS. A chat of its own: a topic with its own session key,
 * pinned to the engine (`provider: "topics"`), whose turn starts from the chat
 * route in this process, like the parent's wake and the goal loop. Not a turn
 * nested inside the parent's: depth, budget, a channel to the UI and
 * cancellation it already has, like any chat (CHAT-NTOOL-03).
 *
 * WHAT STAYS AS IT WAS. The `subagents` row, the caps, the result dedup, the
 * foreground wait and the parent's wake are the CLI children's: this module
 * only reads how a turn ended (from the chat, not a transcript) and hands it
 * to `reportNativeChildTurn`.
 *
 * NO PROCESS, NOTHING TO PARK. A CLI child stays up 15 minutes after its result
 * and then retires; a native one is already `retired` when its turn ends: it
 * holds no slot, and `send_to_agent` sends it the next turn.
 */
import { getDatabase } from "../db";
import type { StoredMessage, Topic } from "../types";
import type { SubAgentOutcome } from "./subagent-result";
import { getSubagent, getSubagentBySessionKey, insertSubagent, isSubagentEngaged, moveSubagentToEngine, runningSubagents, setSubagentState, type SubagentRow } from "./subagent-store";
import { noteChildSeeded, reportNativeChildTurn, runtimeOf } from "./subagent-runtime";
import { onTurnEnd, readTurnEnd } from "../providers/turn-end-registry";
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
  /** Take a finished child's chat out of view, through the same door as any archive. */
  archive?(topic: Topic): void;
  /**
   * Background work of the child's own chat (a command, a CLI task) that will
   * wake it: until it ends the child is not done. Its own children are counted
   * apart, from `subagents`.
   */
  backgroundWork?(sessionKey: string): boolean;
  log?(msg: string): void;
}

let deps: NativeSubagentDeps | null = null;
let stopListening: (() => void) | null = null;
export function configureNativeSubagents(d: NativeSubagentDeps | null): void {
  deps = d;
  stopListening?.();
  stopListening = d ? onTurnEnd((sessionKey) => onNativeChildChatTurnEnd(sessionKey)) : null;
}

/** The engine can run a child now: wired, and connected. */
export function nativeSubagentsAvailable(): boolean {
  if (!deps) return false;
  try { return deps.engineReady(); } catch { return false; }
}

export { engineToolsOfProfile } from "./subagent-tool-policy";

/**
 * The aliases `spawn_agent` accepts, mapped to the model the engine runs: the
 * newest of each family in the tested catalog (`MODELS` in
 * `providers/native/provider.ts`). A full id passes as is; one the engine does
 * not run is dropped by the chat route, which falls back to the default.
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
 * Where a native child lives: its chat's project (and worktree). The engine
 * works in the chat's project, not in any folder, and a `projectPath` widens
 * the file routes to that folder: so a `cwd` Topics does not know as a project
 * never becomes a native child's home. `ok: false` = the child stays on the
 * CLI, or is refused if the caller asked for the engine.
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

// ── This process's state ─────────────────────────────────────────────────────

/** Children whose turn this process is driving: their stop must not be read as an end. */
const driving = new Set<string>();
/** Children stopped by their parent (its `stop_agent`, or a person's Stop on it). */
const stoppedByParent = new Set<string>();
/** Children the boot is adopting, with the start of the turn a restart may have cut. */
const adopting = new Map<string, number>();

const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); });

// ── Spawn ────────────────────────────────────────────────────────────────────

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
  /** Why it runs on the engine: `asked` by the call, or the `default`. */
  runtimeReason?: "asked" | "default";
  /**
   * A CLI child moving to the engine: its row is updated, not replaced, so the
   * turns it already reported and its pending results stay its own.
   */
  migrate?: boolean;
}

/**
 * Creates the child's chat and starts its first turn. Returns as soon as the
 * chat exists: the turn runs on its own and its result takes every child's
 * road (the parent's wake, or `read_agent` for a terminal parent).
 */
export function spawnNativeChild(s: NativeSpawn): { sessionKey: string; topic: Topic } {
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
    // The engine, declared: a child must not fall onto the CLI through a default.
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
  if (s.migrate) {
    moveSubagentToEngine(getDatabase(), s.id, { sessionKey: topic.sessionKey, tools: s.tools, model: s.model });
  } else {
    insertSubagent(getDatabase(), {
      id: s.id, parentSessionKey: s.parentSessionKey, name: s.name, model: s.model, agentType: s.agentType, effort: s.effort,
      promptSnippet: s.promptSnippet, cwd: s.cwd, branch: s.branch, claudeSessionId: null, createdAt: now,
      runtime: "topics", sessionKey: topic.sessionKey, tools: s.tools, runtimeReason: s.runtimeReason ?? "default",
    });
  }
  void driveTurn(s.id, s.prompt);
  return { sessionKey: topic.sessionKey, topic };
}

/**
 * The next turn: `send_to_agent` on a native child. A child mid-turn refuses
 * (409): its result arrives by itself, and two turns on one chat are not
 * queued here. A finished, retired or stopped one resumes from its chat.
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
  // A turn cut by a restart that the boot is still waiting for: close it now as
  // `lost`, then send. Left to the adoption, the new turn was taken for the
  // old one, reported twice, and the cut turn never said it was lost.
  const cutAt = adopting.get(row.id);
  if (cutAt !== undefined) {
    adopting.delete(row.id);
    driving.add(row.id);
    void reportTurn(row.id, cutAt, null, true)
      .catch((err) => deps?.log?.(`report ${row.id}: ${err instanceof Error ? err.message : String(err)}`))
      .then(() => driveTurn(row.id, input));
    return { ok: true, resumed };
  }
  void driveTurn(row.id, input);
  return { ok: true, resumed };
}

/**
 * `stop_agent` (or the parent's Stop): the turn in flight is cancelled the way
 * every Stop is, and its result goes out as `stopped` by the parent. A stopped
 * child yields no second result (SUBAGENT-11). `archive` takes the chat out of
 * view, as the CLI closed its pane; `send_to_agent` reopens it.
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
    if (topic && !topic.archived) {
      if (deps.archive) deps.archive(topic);
      else deps.saveTopic({ ...topic, archived: true, updatedAt: new Date().toISOString() }, false);
    }
  }
}

/**
 * A person's Stop on the parent also stops the native children working for
 * it: without this, their turn went on and woke the parent just stopped. The
 * chats stay open, the children resume with `send_to_agent`. Returns how many
 * it stopped.
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

// ── Turn ─────────────────────────────────────────────────────────────────────

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

/** The turn of a child: sent through the chat route, drained, read, reported. */
async function driveTurn(id: string, text: string): Promise<void> {
  const d = deps;
  const row0 = getSubagent(getDatabase(), id);
  if (!d || !row0?.sessionKey) return;
  const sessionKey = row0.sessionKey;
  driving.add(id);
  stoppedByParent.delete(id);
  setSubagentState(getDatabase(), id, "running");
  noteChildSeeded(id, { working: true });
  const sentAt = Date.now();
  let routeError: string | null = null;
  try {
    const url = new URL("http://localhost/api/chat");
    const resp = await d.route(
      internalRequest(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: text }] }),
      }),
      url, "/api/chat", "POST",
    );
    if (!resp?.ok) {
      const body = resp ? await resp.json().catch(() => null) as { error?: unknown } | null : null;
      routeError = `the chat route answered ${resp?.status ?? "nothing"}${typeof body?.error === "string" ? `: ${body.error}` : ""}`;
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
  try {
    await reportTurn(id, sentAt, routeError);
  } catch (err) {
    d.log?.(`report ${id}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Never left behind: an id stuck here refused every later send with a 409.
    driving.delete(id);
  }
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
  // A child that delegated (a grandchild still working) or left a command
  // running is not done: its own wake turn reports again. Retired or archived
  // here, that wake was refused and the final result never reached the root
  // (SUBAGENT-19).
  if (getSubagent(db, id)?.state === "running" && stillWorkingFor(row.sessionKey)) {
    runtimeOf(id).phase = "working";
    return;
  }
  // No process to park: the turn is over, the slot is free. A stop already
  // wrote `stopped`, and that is what it stays.
  const retiredNow = getSubagent(db, id)?.state === "running";
  if (retiredNow) setSubagentState(db, id, "retired");
  runtimeOf(id).phase = "finished";
  // Like the Agent tool's children: a turn that ended on its own, its result delivered, leaves the view.
  // `send_to_agent` brings it back (it unarchives). A stopped child stays to be read, and so does
  // one a person engaged with (focused or opened), on record so a restart keeps it.
  const topic = retiredNow && outcome.status === "completed" ? deps?.getTopicBySessionKey(row.sessionKey) : null;
  if (deps && topic && !topic.archived && !isSubagentEngaged(db, id)) {
    if (deps.archive) deps.archive(topic);
    else deps.saveTopic({ ...topic, archived: true, updatedAt: new Date().toISOString() }, false);
  }
}

/** Grandchildren still running, or background work that owes this chat a wake. */
function stillWorkingFor(sessionKey: string): boolean {
  if (runningSubagents(getDatabase(), sessionKey).length > 0) return true;
  try { return deps?.backgroundWork?.(sessionKey) === true; } catch { return false; }
}

/**
 * Any turn of a native child's chat that this module did not send: the wake
 * when a grandchild's result or a command lands, or a person writing in it.
 * It is reported to the parent like a driven turn; before, the result of a
 * delegation two levels down stopped at the child (SUBAGENT-19).
 */
export function onNativeChildChatTurnEnd(sessionKey: string): void {
  const d = deps;
  if (!d) return;
  const row = getSubagentBySessionKey(getDatabase(), sessionKey);
  if (!row || row.runtime !== "topics" || driving.has(row.id) || adopting.has(row.id)) return;
  const since = Date.parse(row.reportedAt ?? row.createdAt) || 0;
  driving.add(row.id);
  void (async () => {
    try {
      // The end is recorded a beat before the route lets the session go.
      for (let i = 0; i < 120 && d.isBusy(sessionKey); i++) await sleep(250);
      if (getSubagent(getDatabase(), row.id)?.state !== "stopped") setSubagentState(getDatabase(), row.id, "running");
      await reportTurn(row.id, since, null);
    } catch (err) {
      d.log?.(`report ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      driving.delete(row.id);
    }
  })();
}

/**
 * After a restart: native children still `running` have no process to find,
 * but their turn may have restarted with the chat resume. The chat is watched
 * for a minute: a live turn is awaited and reported, one that never comes back
 * is reported `lost` with what it had written.
 */
export async function adoptNativeChildrenAtBoot(opts: { waitMs?: number; pollMs?: number } = {}): Promise<void> {
  const d = deps;
  if (!d) return;
  const waitMs = opts.waitMs ?? 60_000;
  const pollMs = opts.pollMs ?? 1_000;
  const rows = runningSubagents(getDatabase()).filter((r) => r.runtime === "topics" && r.sessionKey && !driving.has(r.id));
  // Claimed before any wait: a `send_to_agent` in this minute closes the cut
  // turn itself (see `sendToNativeChild`) and the adoption lets it go.
  for (const row of rows) adopting.set(row.id, Date.parse(row.reportedAt ?? row.createdAt) || 0);
  await Promise.all(rows.map(async (row) => {
    const sessionKey = row.sessionKey!;
    const since = adopting.get(row.id) ?? 0;
    noteChildSeeded(row.id, { working: true });
    const until = Date.now() + waitMs;
    while (adopting.has(row.id) && !d.isBusy(sessionKey) && Date.now() < until) await sleep(pollMs);
    if (!adopting.delete(row.id)) return; // a send took it over
    if (!d.isBusy(sessionKey)) {
      // Waiting on its own children or a command: their wake reports it.
      if (stillWorkingFor(sessionKey)) return;
      await reportTurn(row.id, since, null, true);
      return;
    }
    driving.add(row.id);
    try {
      while (d.isBusy(sessionKey)) await sleep(pollMs);
      await reportTurn(row.id, since, null);
    } finally {
      driving.delete(row.id);
    }
  }));
}

// ── read_agent ───────────────────────────────────────────────────────────────

/**
 * `read_agent` on a native child: its answers and its tool calls, from the
 * chat. The offset is a row index, not a byte: that is the chat's unit, and
 * the caller passes it back without reading it.
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
  adopting.clear();
  stopListening?.();
  stopListening = null;
  deps = null;
}
