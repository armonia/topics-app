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
import { cancelled, type TurnEndInfo } from "../providers/stop-reason";
import { claimTurnReport, getSubagent, getSubagentBySessionKey, insertSubagent, isSubagentEngaged, lastReportedTurnStatus, lastUnreportedTurn, moveSubagentToEngine, recordTurnStarted, runningSubagents, setSubagentState, subagentRuntimeReason, turnWasReported, type SubagentRow } from "./subagent-store";
import { migratedChildPromptFor } from "./subagent-migration";
import { childPhase, cliChildPhaseNow, noteChildSeeded, reportNativeChildTurn, runtimeOf, subagentWakeOwed } from "./subagent-runtime";
import { onTurnEnd, onTurnStart, type TurnStartMeta } from "../providers/turn-end-registry";
import { internalAbortRequest, internalRequest } from "./abort-cause";
import { profileInstructions, type AgentProfile } from "./agent-profiles";
import { engineToolsOfProfile } from "./subagent-tool-policy";

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
  /** Bring a child's chat back into view, undoing every mark the archive left (`reopenTopicFully`). */
  reopen?(topic: Topic): void;
  /**
   * Background work of the child's own chat (a command, a CLI task) that will
   * wake it: until it ends the child is not done. Its own children are counted
   * apart, from `subagents`.
   */
  backgroundWork?(sessionKey: string): boolean;
  /** Stop the child chat's own commands that would wake it: its Stop leaves nothing to wake it. */
  stopBackgroundWork?(sessionKey: string): void;
  /** How often a child waiting on its own work is looked at again (default 5 s). */
  waitPollMs?: number;
  log?(msg: string): void;
  /** Whether the boot's resume can still resend the chat's cut turn (`cutTurnResumable`). Absent: it cannot. */
  cutTurnResumable?(sessionKey: string): Promise<boolean>;
}

let deps: NativeSubagentDeps | null = null;
let stopListening: (() => void) | null = null;
export function configureNativeSubagents(d: NativeSubagentDeps | null): void {
  deps = d;
  stopListening?.();
  if (!d) { stopListening = null; return; }
  const offStart = onTurnStart((sessionKey, turnId, meta) => onNativeChildChatTurnStart(sessionKey, turnId, meta));
  const offEnd = onTurnEnd((sessionKey, info) => onNativeChildChatTurnEnd(sessionKey, info));
  stopListening = () => { offStart(); offEnd(); };
}

/** The CLI half of a tree stop, wired by the terminal router (it owns the PTYs). */
let stopCliChild: ((id: string) => void) | null = null;
export function setCliChildStopper(fn: ((id: string) => void) | null): void {
  stopCliChild = fn;
}

/** The engine can run a child now: wired, and connected. */
export function nativeSubagentsAvailable(): boolean {
  if (!deps) return false;
  try { return deps.engineReady(); } catch { return false; }
}

export { engineToolsOfProfile };

/**
 * What a child takes from its profile and its model on the engine: the
 * profile's own instructions as its system prompt, its tools, the engine's
 * model id. The same for a spawn and for a CLI child moving to the engine.
 */
export function engineLaunchOf(
  profile: Pick<AgentProfile, "path" | "tools"> | null,
  model: string | null,
): Pick<NativeSpawn, "instructions" | "tools" | "model"> {
  return {
    instructions: profile ? profileInstructions(profile) : null,
    tools: engineToolsOfProfile(profile?.tools),
    model: engineModelOf(model),
  };
}

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

export type ChildRuntime =
  | { ok: true; runtime: "topics"; place: { projectPath: string | null; worktreeId: string | null } }
  | { ok: true; runtime: "claude-code"; note: string | null }
  | { ok: false; status: number; error: string };

/**
 * The runtime of a `spawn_agent` call: the engine, unless the call asks for
 * the CLI or the engine cannot take it. Falling back to the CLI is said in the
 * answer (`note`), never silently; a call that asked for the engine is refused
 * instead.
 */
export function childRuntimeFor(asked: unknown, place: () => ReturnType<typeof nativeChildPlace>): ChildRuntime {
  if (asked !== undefined && asked !== "topics" && asked !== "claude-code") {
    return { ok: false, status: 400, error: `unknown runtime "${String(asked)}": use "topics" or "claude-code"` };
  }
  if (asked === "claude-code") return { ok: true, runtime: "claude-code", note: null };
  const available = nativeSubagentsAvailable();
  const where = available ? place() : null;
  if (!where?.ok) {
    const why = where ? where.reason : "the Topics engine is not available";
    if (asked === "topics") return { ok: false, status: available ? 400 : 503, error: `cannot start a sub-agent on the Topics engine: ${why}` };
    return { ok: true, runtime: "claude-code", note: `claude-code (${why})` };
  }
  return { ok: true, runtime: "topics", place: { projectPath: where.projectPath, worktreeId: where.worktreeId } };
}

// ── This process's state ─────────────────────────────────────────────────────

/** Children whose turn this process is sending (`send_to_agent`, the spawn): a second send is refused. */
const driving = new Set<string>();
/** The key each driven turn carries in its request (`clientMessageId`): only that turn is the driven one. */
const drivenKeys = new Map<string, string>();
/** Driven keys whose turn the chat route opened: a route that answered without one sent nothing. */
const startedKeys = new Set<string>();

/**
 * The one turn each child's chat has open, from its start (`recordTurnStart`)
 * to the first end recorded on the chat. `driven`: the turn this module sent.
 * `suspended`: cut by the server's shutdown, which is no outcome; the resume
 * after the boot reports it, or the adoption closes it as `lost`.
 */
interface OpenTurn { turnId: string; driven: boolean; suspended?: boolean }
const openTurn = new Map<string, OpenTurn>();
/**
 * Children stopped mid-turn by their parent (its `stop_agent`, or a person's
 * Stop above it), with the turn whose result the Stop still owes: the only
 * result a stopped child sends, marked `stoppedByParent`. Null = a driven turn
 * the chat route had not opened yet: its start names it.
 */
const stopTurns = new Map<string, string | null>();
/** Children the boot is adopting: a turn a restart may have cut, not yet read. */
const adopting = new Set<string>();

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
  void driveTurn(s.id, s.prompt, { refusalIsResult: true });
  return { sessionKey: topic.sessionKey, topic };
}

/**
 * `send_to_agent` on an ended CLI child: it is not relit as Claude Code. If
 * the engine can take it, it comes back native with the same id, its row
 * updated (turns and pending results kept), its profile's instructions and
 * tools, and its work as context. A child whose call asked for `claude-code`
 * resumes where it was asked to run, and so does one the engine cannot place
 * or start: null, and the caller relights the CLI.
 */
export async function moveCliChildToEngine(row: SubagentRow, input: string, from: {
  parentTopic: Topic | null;
  parentCwd: string | null;
  knownProject: (path: string) => boolean;
  profileOf: (cwd: string, agentType: string) => AgentProfile | null;
}): Promise<{ sessionKey: string } | null> {
  if (!nativeSubagentsAvailable() || subagentRuntimeReason(getDatabase(), row.id) === "asked") return null;
  const place = nativeChildPlace({ explicitCwd: row.cwd || null, parentTopic: from.parentTopic, parentCwd: from.parentCwd, knownProject: from.knownProject });
  if (!place.ok) return null;
  try {
    const child = spawnNativeChild({
      id: row.id, parentSessionKey: row.parentSessionKey, name: row.name,
      prompt: await migratedChildPromptFor(row, input),
      cwd: row.cwd, parentTopic: from.parentTopic, projectPath: place.projectPath, worktreeId: place.worktreeId, branch: row.branch,
      ...engineLaunchOf(row.agentType ? from.profileOf(row.cwd, row.agentType) : null, row.model),
      effort: row.effort, agentType: row.agentType,
      promptSnippet: row.promptSnippet,
      migrate: true,
    });
    deps?.log?.(`${row.id} (${row.name}) moved from the CLI to the Topics engine: ${child.sessionKey}`);
    return { sessionKey: child.sessionKey };
  } catch (err) {
    deps?.log?.(`moving ${row.id} to the engine failed, it resumes on the CLI: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * The next turn: `send_to_agent` on a native child. A child mid-turn refuses
 * (409): its result arrives by itself, and two turns on one chat are not
 * queued here. A finished, retired or stopped one resumes from its chat. The
 * answer waits for the chat route's: a turn that got there first is a 409 for
 * the parent, never an `ok` for a turn that was not sent.
 */
export async function sendToNativeChild(row: SubagentRow, input: string): Promise<{ ok: true; resumed: boolean } | { ok: false; status: number; error: string }> {
  if (!deps) return { ok: false, status: 503, error: "native sub-agents are not wired" };
  if (!row.sessionKey) return { ok: false, status: 410, error: `sub-agent "${row.name}" has no chat` };
  // A report still on its way is the same answer: the result arrives by itself.
  if (driving.has(row.id) || deps.isBusy(row.sessionKey) || reportChains.has(row.id)) {
    return { ok: false, status: 409, error: `sub-agent "${row.name}" is still working on its turn: its result will arrive by itself` };
  }
  const resumed = row.state !== "running";
  const topic = deps.getTopicBySessionKey(row.sessionKey);
  // The unarchive's own door: the flag alone left the retirement fact, and the
  // next boot's reconcile archived the child again under its live turn.
  if (topic?.archived) {
    if (deps.reopen) deps.reopen(topic);
    else deps.saveTopic({ ...topic, archived: false, updatedAt: new Date().toISOString() }, false);
  }
  // A turn cut by a restart, still suspended (the adoption's minute, or a
  // resume deferred by a provider hold): the new message supersedes it. It is
  // closed now, once, as `lost`, and the resume no longer resends it (its turn
  // is reported). A child that had reported and was only waiting on its own
  // work lost nothing.
  adopting.delete(row.id);
  const cut = openTurn.has(row.id) ? null : unreportedTurnOf(row);
  if (cut) {
    try { reportTurn(row.id, cut, { end: null, lost: true }); } catch (err) { deps.log?.(`report ${row.id}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  const sent = await driveTurn(row.id, input, { refusalIsResult: false });
  return sent.ok ? { ok: true, resumed } : sent;
}

/** Every live child under a session, native or CLI, and theirs below them. */
interface LiveTree { native: SubagentRow[]; cli: SubagentRow[] }

/**
 * Read at once, with no await: the tree a Stop marks before it does anything
 * that yields. A parked CLI child (its turn over, its PTY kept for a resume)
 * has nothing to stop: only the tree below it has.
 */
function liveTreeUnder(sessionKey: string, into: LiveTree = { native: [], cli: [] }): LiveTree {
  for (const row of runningSubagents(getDatabase(), sessionKey)) {
    if (row.runtime === "topics") {
      into.native.push(row);
      if (row.sessionKey) liveTreeUnder(row.sessionKey, into);
      continue;
    }
    // A CLI child's own children hang under its id.
    liveTreeUnder(row.id, into);
    if (cliChildPhaseNow(row) !== "finished") into.cli.push(row);
  }
  return into;
}

/**
 * The child is `stopped`, and the result its Stop owes is pinned: the turn its
 * chat has open and has not reported, or the driven turn the chat route has
 * not opened yet (null). A child with nothing in flight is owed nothing.
 */
function markStopped(row: SubagentRow): string | null {
  const db = getDatabase();
  setSubagentState(db, row.id, "stopped");
  stopWatchingChild(row.id);
  adopting.delete(row.id);
  const open = openTurn.get(row.id)?.turnId;
  // A turn a restart cut, still waiting for the resume, has no end to come:
  // the Stop's result is its one result, said now.
  const suspended = open === undefined && !driving.has(row.id) ? unreportedTurnOf(row) : null;
  const owed = open !== undefined ? (turnWasReported(db, row.id, open) ? undefined : open) : (driving.has(row.id) ? null : suspended ?? undefined);
  if (owed === undefined) stopTurns.delete(row.id);
  else stopTurns.set(row.id, owed);
  return suspended;
}

/**
 * The Stop of a tree. Every native node is `stopped` before the first await:
 * a turn that ended while the Stop was busy with another node read a child
 * still `running`, and its result woke the root after the Stop. Then the
 * working CLI nodes lose their PTY, the commands that would wake a chat stop,
 * and the turns in flight are cancelled the way every Stop is.
 */
async function stopTree(tree: LiveTree): Promise<void> {
  const d = deps;
  if (!d) return;
  for (const row of tree.native) {
    const suspended = markStopped(row);
    if (suspended) void enqueueReport(row.id, async () => reportTurn(row.id, suspended, { end: cancelled("user", "a Stop on a turn a restart cut") }));
  }
  const log = (id: string, err: unknown) => d.log?.(`stop ${id}: ${err instanceof Error ? err.message : String(err)}`);
  for (const row of tree.cli) {
    try { stopCliChild?.(row.id); } catch (err) { log(row.id, err); }
  }
  for (const row of tree.native) {
    const sessionKey = row.sessionKey;
    if (!sessionKey) continue;
    try { d.stopBackgroundWork?.(sessionKey); } catch (err) { log(row.id, err); }
    if (driving.has(row.id) || d.isBusy(sessionKey)) {
      const req = internalAbortRequest(sessionKey, "user");
      const url = new URL(req.url);
      await Promise.resolve(d.route(req, url, url.pathname, "POST")).catch((err) => log(row.id, err));
    }
  }
}

/**
 * `stop_agent` (or the parent's Stop): the turn in flight is cancelled the way
 * every Stop is, and its result goes out once, as `stopped` by the parent. A
 * stopped child yields no other result (SUBAGENT-11), and neither does the
 * tree below it. `archive` takes the chat out of view, as the CLI closed its
 * pane; `send_to_agent` reopens it.
 */
export async function stopNativeChild(row: SubagentRow, opts: { archive: boolean }): Promise<void> {
  if (!deps || !row.sessionKey) return;
  const tree = liveTreeUnder(row.sessionKey);
  tree.native.unshift(row);
  await stopTree(tree);
  if (opts.archive) {
    const topic = deps.getTopicBySessionKey(row.sessionKey);
    if (topic && !topic.archived) {
      if (deps.archive) deps.archive(topic);
      else deps.saveTopic({ ...topic, archived: true, updatedAt: new Date().toISOString() }, false);
    }
  }
}

/**
 * A person's Stop on the parent stops the whole live tree under it: the
 * children working, those waiting on their own children, and those children.
 * Without this, a turn went on, or a grandchild's result woke a waiting child,
 * and the parent just stopped was woken. The chats stay open, the children
 * resume with `send_to_agent`. Returns how many direct children it stopped.
 */
export async function stopNativeChildrenOf(parentSessionKey: string): Promise<number> {
  if (!deps) return 0;
  const tree = liveTreeUnder(parentSessionKey);
  await stopTree(tree);
  return [...tree.native, ...tree.cli].filter((r) => r.parentSessionKey === parentSessionKey).length;
}

// ── Turn ─────────────────────────────────────────────────────────────────────

/** The user row that opened the turn `turnId`, and the assistant rows of it: up to the next user row. */
function turnOf(sessionKey: string, turnId: string): { opener: StoredMessage | null; rows: StoredMessage[] } {
  const all = deps?.loadMessages(sessionKey) ?? [];
  const at = all.findIndex((m) => m.id === turnId);
  if (at < 0) return { opener: null, rows: [] };
  const next = all.findIndex((m, i) => i > at && m.role === "user");
  return { opener: all[at]!, rows: all.slice(at + 1, next < 0 ? undefined : next).filter((m) => m.role === "assistant") };
}

/** Stops the machine decided (a watchdog, a frozen stream, a stall): said with the reason, never a person's. */
const MACHINE_CUTS = new Set(["watchdog", "stall", "wall-clock", "superseded"]);

/**
 * How a turn of a child chat ended: from the cause of its end, never from
 * whether it left words behind. A cut turn's last row is often a notice.
 */
export function nativeTurnOutcome(input: {
  end: { end: string; cause?: string; detail?: string } | null;
  text: string;
  routeError?: string | null;
  stopped: boolean;
}): SubAgentOutcome {
  const text = input.text.trim();
  if (input.routeError) return { status: "failed", partial: false, text, reason: { code: "api-error", detail: input.routeError } };
  // The parent's stop never wakes it (`resultWakesParent`); a person's Stop on
  // the child's own chat does, like a closed tab of a CLI child.
  if (input.stopped) return { status: "stopped", partial: true, text, reason: { code: "stopped-by-parent" } };
  if (!input.end) return { status: "failed", partial: true, text, reason: { code: "exited-mid-turn" } };
  if (input.end.end === "cancelled") {
    return input.end.cause && MACHINE_CUTS.has(input.end.cause)
      ? { status: "stopped", partial: true, text, reason: { code: "swept" } }
      : { status: "stopped", partial: true, text };
  }
  if (input.end.end === "end_turn") return { status: "completed", partial: false, text };
  return { status: "failed", partial: true, text, reason: { code: "api-error", detail: input.end.detail ? `${input.end.end}: ${input.end.detail}` : input.end.end } };
}

type RouteAnswer = { ok: true } | { ok: false; status: number; error: string };

/**
 * The turn of a child, sent through the chat route. The promise answers as
 * soon as the route does: a refusal (a 409, another turn got there first) is
 * the caller's to say. The rest runs on: the stream drained, the turn
 * reported by its end. `refusalIsResult`: the spawn, which already answered
 * its caller, reports a refusal as the turn's `failed` result instead.
 */
function driveTurn(id: string, text: string, opts: { refusalIsResult: boolean }): Promise<RouteAnswer> {
  let answered!: (a: RouteAnswer) => void;
  const answer = new Promise<RouteAnswer>((r) => { answered = r; });
  void runDrivenTurn(id, text, opts, answered);
  return answer;
}

async function runDrivenTurn(id: string, text: string, opts: { refusalIsResult: boolean }, answered: (a: RouteAnswer) => void): Promise<void> {
  const d = deps;
  const db = getDatabase();
  const row0 = getSubagent(db, id);
  if (!d || !row0?.sessionKey) { answered({ ok: false, status: 410, error: "the sub-agent has no chat" }); return; }
  const sessionKey = row0.sessionKey;
  // Before any await: a Stop from here on owes this turn's result (`markStopped`),
  // and only the turn carrying this key is the driven one (`onNativeChildChatTurnStart`).
  const key = `drive:${crypto.randomUUID()}`;
  driving.add(id);
  drivenKeys.set(id, key);
  stopTurns.delete(id);
  setSubagentState(db, id, "running");
  noteChildSeeded(id, { working: true });
  let routeError: string | null = null;
  let status = 0;
  try {
    const url = new URL("http://localhost/api/chat");
    const resp = await d.route(
      internalRequest(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: text }], clientMessageId: key }),
      }),
      url, "/api/chat", "POST",
    );
    status = resp?.status ?? 0;
    if (!resp?.ok) {
      const body = resp ? await resp.json().catch(() => null) as { error?: unknown } | null : null;
      routeError = `the chat route answered ${resp?.status ?? "nothing"}${typeof body?.error === "string" ? `: ${body.error}` : ""}`;
    } else if (!startedKeys.has(key)) {
      // The route answered itself (a chat command): no turn, nothing for the child.
      await resp.body?.cancel().catch(() => {});
      routeError = "the chat route answered without opening a turn";
    } else {
      answered({ ok: true });
      if (resp.body) {
        // The stream is the turn: read to its end. The route keeps writing the
        // rows on its own, a reader that walked away would change nothing.
        const reader = resp.body.getReader();
        for (;;) { const r = await reader.read(); if (r.done) break; }
      }
      // The stream can close a beat before the route lets the session go.
      for (let i = 0; i < 120 && d.isBusy(sessionKey); i++) await sleep(250);
    }
  } catch (err) {
    routeError = err instanceof Error ? err.message : String(err);
  }
  try {
    if (routeError && !opts.refusalIsResult) {
      // Nothing was sent: the parent hears it from its own call, and the child
      // goes back to how it was, unless another turn holds its chat now.
      answered({ ok: false, status: status >= 400 ? status : 502, error: routeError });
      if (!openTurn.has(id) && getSubagent(db, id)?.state === "running" && row0.state !== "running") {
        setSubagentState(db, id, row0.state);
        runtimeOf(id).phase = "finished";
      }
      return;
    }
    answered({ ok: true });
    // Its end reports it (`onNativeChildChatTurnEnd`). Left here: a turn the
    // chat route refused or never opened, named here, and a turn still open
    // with no end, which never came. A suspended one waits for the boot.
    await (reportChains.get(id) ?? Promise.resolve());
    const open = openTurn.get(id);
    let turnId: string | null = null;
    if (open?.driven && !open.suspended) {
      turnId = open.turnId;
      openTurn.delete(id);
    } else if (routeError) {
      turnId = `drive:${crypto.randomUUID()}`;
      if (stopTurns.get(id) === null) stopTurns.set(id, turnId);
    }
    if (turnId) {
      const named = turnId;
      await enqueueReport(id, async () => reportTurn(id, named, { end: null, routeError }));
    }
  } finally {
    // Never left behind: an id stuck here refused every later send with a 409.
    driving.delete(id);
    drivenKeys.delete(id);
    startedKeys.delete(key);
  }
}

/**
 * Hand the turn `turnId` to the parent, read off the child's chat between the
 * user row that opened it and the next one. One turn, one result: the turn is
 * claimed in `subagent_reported_turns` first, and a second report of it, in
 * this process or after a restart, goes nowhere. A stopped child sends only
 * the result its Stop owes, marked `stoppedByParent`.
 */
function reportTurn(id: string, turnId: string, opts: { end: TurnEndInfo | null; routeError?: string | null; lost?: boolean }): void {
  const db = getDatabase();
  const row = getSubagent(db, id);
  if (!row?.sessionKey) return;
  const byParent = row.state === "stopped";
  if (byParent && stopTurns.get(id) !== turnId) return;
  const { opener, rows } = turnOf(row.sessionKey, turnId);
  const last = rows.at(-1);
  const outcome: SubAgentOutcome = opts.lost && !opts.end
    ? { status: "lost", partial: true, text: last?.content ?? "", reason: { code: "exited-mid-turn" } }
    : nativeTurnOutcome({ end: opts.end, text: last?.content ?? "", routeError: opts.routeError ?? null, stopped: byParent });
  if (claimTurnReport(db, id, turnId, outcome.status)) {
    if (byParent) stopTurns.delete(id);
    const durationMs = last?.latencyMs ?? (last && opener ? Date.parse(last.timestamp) - Date.parse(opener.timestamp) : null);
    reportNativeChildTurn(
      { id, name: row.name, cwd: row.cwd, parentSessionKey: row.parentSessionKey },
      row.turnsReported + 1,
      outcome,
      { model: (last as { model?: string } | undefined)?.model ?? row.model, durationMs: durationMs != null && durationMs >= 0 ? durationMs : null },
      { stoppedByParent: byParent },
    );
  }
  // A later turn is open on the chat already: that turn closes the child.
  if (openTurn.has(id)) return;
  // A child that delegated (a grandchild still working) or left a command
  // running is not done: its own wake turn reports again. Retired or archived
  // here, that wake was refused and the final result never reached the root
  // (SUBAGENT-19). Looked at again until the work is over (`watchWaitingChild`).
  const completed = outcome.status === "completed";
  if (getSubagent(db, id)?.state === "running" && stillWorkingFor(row.sessionKey)) {
    runtimeOf(id).phase = "working";
    watchWaitingChild(id, completed);
    return;
  }
  closeTurn(id, completed);
}

/**
 * The turn is over and nothing is owed to the chat any more. No process to
 * park: the slot is free. A stop already wrote `stopped`, and that is what it
 * stays. Like the Agent tool's children, a turn that ended on its own, its
 * result delivered, leaves the view; `send_to_agent` brings it back. A stopped
 * child stays to be read, and so does one a person engaged with, or one whose
 * turn did not complete.
 */
function closeTurn(id: string, completed: boolean): void {
  const db = getDatabase();
  const row = getSubagent(db, id);
  if (!row?.sessionKey) return;
  const retiredNow = row.state === "running";
  if (retiredNow) setSubagentState(db, id, "retired");
  runtimeOf(id).phase = "finished";
  const topic = retiredNow && completed ? deps?.getTopicBySessionKey(row.sessionKey) : null;
  if (deps && topic && !topic.archived && !isSubagentEngaged(db, id)) {
    if (deps.archive) deps.archive(topic);
    else deps.saveTopic({ ...topic, archived: true, updatedAt: new Date().toISOString() }, false);
  }
}

/**
 * Work that will wake this chat: a child of it not seen finished, a result of
 * one not yet delivered (the same reading as the parent's own wake state,
 * `subagentWakeState`), or background work of its own. A CLI grandchild stays
 * `running` 15 minutes after its result, parked: counting the row, not the
 * phase, kept the child waiting for good.
 */
function stillWorkingFor(sessionKey: string): boolean {
  if (subagentWakeOwed(sessionKey)) return true;
  try { return deps?.backgroundWork?.(sessionKey) === true; } catch { return false; }
}

/** Children waiting on their own work, looked at again until it is over. */
const waitWatches = new Map<string, ReturnType<typeof setInterval>>();

/**
 * A child kept `running` because its work is not over is looked at again
 * every `waitPollMs`. Its wake turn reports it and closes it the normal way;
 * if the work ends without one (a grandchild retired or lost, a wake the
 * route refused, a command whose wake an earlier turn already took), the
 * child is closed here instead of holding its slot and its parent's wait for
 * good, the way its last turn ended (`completed`) deciding the archive.
 */
function watchWaitingChild(id: string, completed: boolean): void {
  if (waitWatches.has(id) || !deps) return;
  const timer = setInterval(() => {
    const d = deps;
    const row = getSubagent(getDatabase(), id);
    if (!d || !row?.sessionKey || row.state !== "running") { stopWatchingChild(id); return; }
    // A turn of its own is open or being reported: that path closes it.
    if (driving.has(id) || adopting.has(id) || openTurn.has(id) || reportChains.has(id) || d.isBusy(row.sessionKey)) return;
    if (stillWorkingFor(row.sessionKey)) return;
    stopWatchingChild(id);
    // Its last turn was reported already: nothing new to say, only the slot to free.
    closeTurn(id, completed);
  }, deps.waitPollMs ?? 5_000);
  (timer as { unref?: () => void }).unref?.();
  waitWatches.set(id, timer);
}

function stopWatchingChild(id: string): void {
  const timer = waitWatches.get(id);
  if (timer) clearInterval(timer);
  waitWatches.delete(id);
}

/** The reports of each child's turns, one chain per child: in order. */
const reportChains = new Map<string, Promise<void>>();

function enqueueReport(id: string, job: () => Promise<void>): Promise<void> {
  const next: Promise<void> = (reportChains.get(id) ?? Promise.resolve()).then(job)
    .catch((err) => { deps?.log?.(`report ${id}: ${err instanceof Error ? err.message : String(err)}`); })
    .finally(() => { if (reportChains.get(id) === next) reportChains.delete(id); });
  reportChains.set(id, next);
  return next;
}

/**
 * A turn opened on a child's chat: it is the chat's one open turn. It is the
 * driven turn only when it carries the key this module sent. On a stopped
 * child only a person's own message reopens it, as `send_to_agent` does, so
 * its results and its delegations work again (SUBAGENT-22); a machine's turn
 * (a resume, a goal nudge, a wake) leaves it stopped and says nothing. On a
 * retired one any turn sets it to work again.
 */
function onNativeChildChatTurnStart(sessionKey: string, turnId: string, meta: TurnStartMeta): void {
  const d = deps;
  if (!d) return;
  const db = getDatabase();
  const row = getSubagentBySessionKey(db, sessionKey);
  if (!row || row.runtime !== "topics") return;
  const driven = driving.has(row.id) && meta.key != null && meta.key === drivenKeys.get(row.id);
  if (driven) startedKeys.add(meta.key!);
  openTurn.set(row.id, { turnId, driven });
  recordTurnStarted(db, row.id, turnId);
  if (row.state === "stopped") {
    // A driven turn a Stop reached before the route opened it: its result is the Stop's.
    if (driven) {
      if (stopTurns.get(row.id) === null) stopTurns.set(row.id, turnId);
      return;
    }
    if (!meta.byPerson) return;
    stopTurns.delete(row.id);
    const topic = d.getTopicBySessionKey(sessionKey);
    if (topic?.archived) {
      if (d.reopen) d.reopen(topic);
      else d.saveTopic({ ...topic, archived: false, updatedAt: new Date().toISOString() }, false);
    }
  } else if (row.state !== "retired") {
    return;
  }
  setSubagentState(db, row.id, "running");
  noteChildSeeded(row.id, { working: true });
}

/**
 * Any end recorded on a native child's chat closes its open turn, whatever
 * its cause (the turn's own end, the abort route, a watchdog, the stale-stream
 * sweep, an error) and whether or not it names the turn. An end with no open
 * turn is the second end of a closed one: ignored. An end naming another turn
 * is a late one (a cut turn slow to unwind): ignored. The server's shutdown is
 * no outcome: the turn stays open, suspended, for the boot. An end never puts
 * a child back to `running`: only a start does.
 */
export function onNativeChildChatTurnEnd(sessionKey: string, info: TurnEndInfo): void {
  const d = deps;
  if (!d) return;
  const db = getDatabase();
  const row = getSubagentBySessionKey(db, sessionKey);
  if (!row || row.runtime !== "topics") return;
  const open = openTurn.get(row.id);
  if (!open) return;
  if (info.turnId && info.turnId !== open.turnId) {
    d.log?.(`${row.id}: an end of turn ${info.turnId} while ${open.turnId} is open, ignored`);
    return;
  }
  // The engine was removed under it, not the process stopped: no resume comes.
  const engineGone = removedEngineTurns.delete(row.id) && info.cause === "server-shutdown";
  if (info.cause === "server-shutdown" && !engineGone) { open.suspended = true; return; }
  openTurn.delete(row.id);
  const end: TurnEndInfo = engineGone ? { end: "error", detail: ENGINE_REMOVED, turnId: info.turnId } : info;
  if (row.state === "stopped" && stopTurns.get(row.id) !== open.turnId) return;
  void enqueueReport(row.id, async () => {
    // The end is recorded before the route writes the turn's last words: wait
    // for the session to let go, or for the next turn, which can only open
    // once this one has.
    for (let i = 0; i < 120 && d.isBusy(sessionKey) && !openTurn.has(row.id); i++) await sleep(250);
    reportTurn(row.id, open.turnId, { end });
  });
}

const ENGINE_REMOVED = "the Topics engine was removed";
/** Children whose open turn the engine's removal cuts: its end is a failure, not a suspension. */
const removedEngineTurns = new Set<string>();

/**
 * The Topics engine is being removed (`DELETE /api/providers/topics`), not
 * the process stopped: called before its `stop()`. The turns it cuts end
 * `failed` (the engine was removed), since no boot will resume them; a turn
 * already suspended by an earlier shutdown is closed the same way now.
 */
export function nativeEngineRemoved(): void {
  for (const [id, open] of openTurn) {
    if (!open.suspended) { removedEngineTurns.add(id); continue; }
    openTurn.delete(id);
    void enqueueReport(id, async () => reportTurn(id, open.turnId, { end: { end: "error", detail: ENGINE_REMOVED, turnId: open.turnId } }));
  }
  // And the turns an earlier process's shutdown cut, waiting for a resume that cannot come now.
  for (const row of runningSubagents(getDatabase())) {
    if (row.runtime === "topics" && row.sessionKey && !openTurn.has(row.id)) abandonCutTurn(row.sessionKey, ENGINE_REMOVED);
  }
}

/**
 * The turn the chat holds that its parent never heard of: the last turn its
 * chat really opened (`recordTurnStarted`, written at the stream's start),
 * when it was not reported. Never read off the user rows: a row that opened
 * no turn (a refused request, one cut before its stream) is no turn, and no
 * `lost` is owed for it. A child that reported and is only waiting on its own
 * work has none: a restart cut nothing of it.
 */
function unreportedTurnOf(row: SubagentRow): string | null {
  return lastUnreportedTurn(getDatabase(), row.id);
}

/**
 * After a restart: native children still `running` have no process to find,
 * but their turn may come back with the boot's resume. The chat is watched
 * for a minute: a turn resumed is reported by its own end, once, for the turn
 * the shutdown suspended; one that never comes back is reported `lost` with
 * what it had written. A child that was only waiting on its own work lost no
 * turn: it goes back to waiting, or is closed the way its last reported turn
 * ended. A child stopped meanwhile is left alone.
 */
export async function adoptNativeChildrenAtBoot(opts: { waitMs?: number; pollMs?: number } = {}): Promise<void> {
  const d = deps;
  if (!d) return;
  const db = getDatabase();
  const waitMs = opts.waitMs ?? 60_000;
  const pollMs = opts.pollMs ?? 1_000;
  const rows = runningSubagents(db).filter((r) => r.runtime === "topics" && r.sessionKey && !driving.has(r.id));
  // Claimed before any wait: a `send_to_agent` in this minute closes the cut
  // turn itself (see `sendToNativeChild`), a Stop drops it, and the adoption
  // lets it go.
  for (const row of rows) adopting.add(row.id);
  await Promise.all(rows.map(async (row) => {
    const sessionKey = row.sessionKey!;
    noteChildSeeded(row.id, { working: true });
    const until = Date.now() + waitMs;
    while (adopting.has(row.id) && !d.isBusy(sessionKey) && Date.now() < until) await sleep(pollMs);
    if (!adopting.delete(row.id)) return;
    while (d.isBusy(sessionKey)) await sleep(pollMs);
    await (reportChains.get(row.id) ?? Promise.resolve());
    const cur = getSubagent(db, row.id);
    if (cur?.state !== "running" || openTurn.has(row.id)) return;
    const cut = unreportedTurnOf(cur);
    if (!cut) {
      // How its last turn ended, as the live path read it when it reported it:
      // `done` on the row also covers max_tokens, a refusal, the round cap.
      const completed = lastReportedTurnStatus(db, row.id) === "completed";
      if (stillWorkingFor(sessionKey)) watchWaitingChild(row.id, completed);
      else closeTurn(row.id, completed);
      return;
    }
    // The resume can still send it (a provider hold, a deferred sweep): it stays
    // suspended, and its one result is the resent turn's, or the `lost` of
    // `abandonCutTurn` when the resume gives it up.
    if (await d.cutTurnResumable?.(sessionKey).catch(() => false)) return;
    await enqueueReport(row.id, async () => reportTurn(row.id, cut, { end: null, lost: true }));
  }));
}

/**
 * The boot's resume gave a chat's last turn up for good (capped, archived,
 * out of its window). On a native child still `running` whose cut turn the
 * parent never heard of, that turn's one result: `lost`. A turn open, driven,
 * being adopted or reported is someone else's to close.
 */
export function abandonCutTurn(sessionKey: string, failure?: string): void {
  const d = deps;
  if (!d) return;
  const row = getSubagentBySessionKey(getDatabase(), sessionKey);
  if (!row || row.runtime !== "topics" || row.state !== "running") return;
  if (driving.has(row.id) || adopting.has(row.id) || openTurn.has(row.id) || reportChains.has(row.id) || d.isBusy(sessionKey)) return;
  const cut = unreportedTurnOf(row);
  if (!cut) return;
  // A refusal the chat route will repeat (no engine, a routing it cannot do): `failed`, with why.
  const end: TurnEndInfo | null = failure ? { end: "error", detail: failure, turnId: cut } : null;
  void enqueueReport(row.id, async () => reportTurn(row.id, cut, { end, lost: !end }));
}

// ── list_agents, read_agent ──────────────────────────────────────────────────

/** `list_agents`: native children have no terminal, their running rows are the live list. */
export function liveNativeChildren(parentSessionKey: string) {
  return runningSubagents(getDatabase(), parentSessionKey)
    .filter((r) => r.runtime === "topics")
    .map((r) => ({
      agentId: r.id, name: r.name, cwd: r.cwd, branch: r.branch, claudeSessionId: null, runtime: "topics" as const, sessionKey: r.sessionKey,
      busy: childPhase(r.id) !== "finished", state: "running" as const, phase: childPhase(r.id),
    }));
}

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
  drivenKeys.clear();
  startedKeys.clear();
  removedEngineTurns.clear();
  openTurn.clear();
  stopTurns.clear();
  adopting.clear();
  for (const id of [...waitWatches.keys()]) stopWatchingChild(id);
  reportChains.clear();
  stopListening?.();
  stopListening = null;
  deps = null;
}
