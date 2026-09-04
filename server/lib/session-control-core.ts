/**
 * Session-control side-effect cores — the tool-shaped successors to the
 * {{TOPIC_SWITCH}} / {{TOPIC_NEW}} markers (spec: replace-markers-with-tools).
 *
 * These are the CHAT-TOPIC switch/create cores, extracted so BOTH surfaces that
 * drive them share one implementation instead of duplicating the broadcast
 * shape:
 *   - the Layer-1 HTTP endpoints in server/routes/topics.ts (hit by the MCP
 *     bridge tools for claude-code/codex), and
 *   - the SDK-passthrough dispatcher in server/control-tools.ts (claude/openai).
 *
 * Project bind/open/create cores are NOT here: they live inside the
 * createTopicsRouter closure (they reach closure-local resolveProjectRef /
 * bindTopicToProject / moveTerminalPaneToProject), and the SDK dispatcher reuses
 * those via the ChatDeps it already receives. Only the topic switch/create logic
 * — which depends solely on the passed-in helpers below — is genuinely shareable
 * as a pure function.
 *
 * Each core returns a small structured result the caller maps to its own
 * response shape (HTTP status / tool-result string). They perform the broadcasts
 * themselves so the UI converges identically no matter which surface called.
 */
import type { Topic } from "../types";
import type { OutboundMessage } from "../../shared/ws-outbound";

/** The subset of AppContext the switch/create cores dereference. */
export interface SessionControlDeps {
  getTopicById: (id: string) => Topic | null;
  loadTopics: () => { topics: Record<string, Topic> };
  saveSingleTopic: (topic: Topic) => void;
  slugify: (name: string) => string;
  broadcastToAll: (message: OutboundMessage) => void;
}

export type SwitchTopicResult =
  | { ok: true; toTopicId: string }
  | { ok: false; code: "not_found" | "archived"; message: string };

/**
 * Switch the user's view from `current` to an EXISTING topic by id. UI-only: it
 * emits the `topic:switch` broadcast (same shape the marker path used) but does
 * NOT migrate the in-flight message — a tool call can't reproduce the marker's
 * mid-turn surgery, and switch is UI-only by design.
 *
 * Errors are structured so the HTTP endpoint can map "not_found"→404 and
 * "archived"→400 (AC-01: an archived target IS there, it's just not switchable).
 */
export function switchTopicCore(
  current: Topic,
  targetId: string,
  deps: SessionControlDeps,
): SwitchTopicResult {
  const target = deps.getTopicById(targetId);
  if (!target) return { ok: false, code: "not_found", message: "target topic not found" };
  if (target.archived) return { ok: false, code: "archived", message: "target topic is archived" };
  deps.broadcastToAll({
    type: "topic:switch",
    fromTopicId: current.id,
    fromSessionKey: current.sessionKey,
    toTopicId: target.id,
    toSessionKey: target.sessionKey,
  });
  return { ok: true, toTopicId: target.id };
}

/**
 * Create a NEW chat topic titled `title`, inheriting `current`'s project
 * binding, and switch the user to it. Emits `topic:created` THEN `topic:switch`
 * (order matters — the client renders the tab before focusing it). Returns the
 * new topic so callers can echo its id.
 */
export function createTopicCore(
  current: Topic,
  title: string,
  deps: SessionControlDeps,
): { topic: Topic } {
  const data = deps.loadTopics();
  const id = crypto.randomUUID();
  const newTopic: Topic = {
    id,
    name: title,
    slug: deps.slugify(title),
    parentId: null,
    links: [],
    sessionKey: "topic:" + id.slice(0, 8),
    color: "#5865f2",
    icon: "MessageSquare",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
    systemPrompt: "",
    contextFiles: [],
    pinnedMessages: [],
    sortOrder: Object.keys(data.topics).length,
  } as Topic;
  if (current.projectPath) newTopic.projectPath = current.projectPath;
  deps.saveSingleTopic(newTopic);
  deps.broadcastToAll({ type: "topic:created", topic: newTopic });
  deps.broadcastToAll({
    type: "topic:switch",
    fromTopicId: current.id,
    fromSessionKey: current.sessionKey,
    toTopicId: newTopic.id,
    toSessionKey: newTopic.sessionKey,
  });
  return { topic: newTopic };
}

export interface DetachedTopicOptions {
  name: string;
  /** Bind the topic to a project (its agent turn runs in this project's cwd). */
  projectPath?: string;
  /** Run the agent inside this git worktree instead of the project root. */
  worktreeId?: string;
  /** Per-topic system prompt (e.g. the task-scoped instructions). */
  systemPrompt?: string;
  /** Reasoning-effort tier for the topic's claude spawn (`--effort <tier>`, migration 033). */
  effort?: string;
  /** Model override for the topic's spawns (`--model`); absent = provider default. */
  model?: string;
  /**
   * Which agent runs the topic: absent = the default provider. The board sets
   * it to "codex" to work a card on the OpenAI CLI next to the Claude fleet
   * (a second quota, and a second opinion on mechanical work).
   */
  provider?: string | null;
  /**
   * Livello di autonomia della chat, cioè il `--permission-mode` dello spawn.
   *
   * ESPLICITO e non lasciato al default della colonna, per una ragione che vale
   * solo qui: un agente dispacciato dalla board non ha NESSUNO a cui chiedere.
   * Da quando il canale di permesso esiste (`server/lib/permission-bridge.ts`)
   * una modalità che chiede apre un pannello in chat e aspetta — e per una chat
   * che l'umano non ha aperto quel pannello è un task fermo in silenzio.
   * Vedi il chiamante in `server.ts` per la scelta e il perché.
   *
   * ASSENTE = `yolo` (DETACHED_TOPIC_AUTONOMY), ed è tutto il motivo per cui
   * questa opzione esiste: vedi `createDetachedTopic`.
   */
  autonomyLevel?: Topic["autonomyLevel"];
  /**
   * Born CLOSED (archived: true). In the 2-state topic model an open (non-
   * archived) topic IS a tab on every client — a dispatcher-spawned agent
   * session must not pop tabs; it lives in the sidebar until the human opens
   * it from the task drawer (which un-archives it).
   */
  background?: boolean;
  /**
   * Presentation-only: keep `projectPath` (cwd) but render as a standalone
   * (ungrouped) chat — the dispatcher sets this for catch-all "generale"
   * sessions so a project-less task doesn't spawn a phantom project node.
   */
  standalone?: boolean;
  /**
   * MCP fleet scoping for the topic's Claude Code session (migration 049).
   * 'bridge-only' = only the per-session topics bridge (dispatch tool
   * profile); absent = inherit the user's full fleet (interactive default).
   */
  mcpPolicy?: string;
}

/**
 * Autonomy a dispatcher-spawned agent is born with.
 *
 * NOT the interactive default (`ask`, migration 001): `ask` maps to
 * `--permission-mode plan` (server/lib/autonomy-mode.ts), and in plan mode the
 * CLI refuses every tool not declared read-only — the agent cannot edit a file,
 * cannot commit, cannot even call `get_task`. An agent born there burns its
 * turns explaining that it is unable to work. It happened four times on
 * 2026-08-04/05 (tasks 46480579 and 8f635484), with this exact shape:
 *
 *   «Cannot call mcp__topics__get_task while in plan mode … I have no
 *   ExitPlanMode … a relaunch in yolo is needed»
 *
 * Patching `topics.autonomy_level` afterwards does NOT rescue a live session:
 * `--permission-mode` is an argv flag fixed at spawn, so the row flips to
 * `yolo` while the running child stays in plan mode. The tier has to be right
 * when the topic is BORN — which is here.
 *
 * A human-created topic is unaffected: it goes through `createTopicCore` / the
 * POST route and keeps inheriting the `ask` default.
 */
export const DETACHED_TOPIC_AUTONOMY: NonNullable<Topic["autonomyLevel"]> = "yolo";

/**
 * Create a NEW chat topic WITHOUT switching to it — emits only `topic:created`,
 * never `topic:switch`, so it appears as a background tab without stealing focus.
 * Used by the task dispatcher, which needs a topic bound to an explicit project
 * (and optionally a worktree) with no "current" topic to inherit from.
 *
 * Born in `yolo` unless told otherwise (DETACHED_TOPIC_AUTONOMY): this is the
 * birth of an AGENT session, and the interactive `ask` default would hand it a
 * permission mode in which it cannot edit, commit, or reach the board.
 */
export function createDetachedTopic(
  opts: DetachedTopicOptions,
  deps: SessionControlDeps,
): { topic: Topic } {
  const data = deps.loadTopics();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const newTopic: Topic = {
    id,
    name: opts.name,
    slug: deps.slugify(opts.name),
    parentId: null,
    links: [],
    sessionKey: "topic:" + id.slice(0, 8),
    color: "#5865f2",
    icon: "MessageSquare",
    createdAt: now,
    updatedAt: now,
    archived: opts.background === true,
    systemPrompt: opts.systemPrompt ?? "",
    contextFiles: [],
    pinnedMessages: [],
    sortOrder: Object.keys(data.topics).length,
  } as Topic;
  if (opts.projectPath) newTopic.projectPath = opts.projectPath;
  if (opts.worktreeId) newTopic.worktreeId = opts.worktreeId;
  if (opts.effort) newTopic.effort = opts.effort;
  if (opts.model) newTopic.model = opts.model;
  if (opts.provider) (newTopic as Topic & { provider?: string | null }).provider = opts.provider;
  if (opts.standalone) newTopic.standalone = true;
  if (opts.mcpPolicy) newTopic.mcpPolicy = opts.mcpPolicy;
  // Always written, never left to the persistence fallback: `saveSingleTopic`
  // resolves an absent tier to 'ask' (server/utils.ts), i.e. plan mode, i.e. an
  // agent that cannot work. See DETACHED_TOPIC_AUTONOMY.
  //
  // Il ramo di questo checkout aveva la forma condizionale — `if
  // (opts.autonomyLevel) …` — che è precisamente il bug: senza l'opzione non
  // scriveva niente e il tier cadeva su 'ask'. Vince la versione di main.
  newTopic.autonomyLevel = opts.autonomyLevel ?? DETACHED_TOPIC_AUTONOMY;
  deps.saveSingleTopic(newTopic);
  deps.broadcastToAll({ type: "topic:created", topic: newTopic });
  return { topic: newTopic };
}
