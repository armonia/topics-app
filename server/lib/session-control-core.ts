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

/** The subset of AppContext the switch/create cores dereference. */
export interface SessionControlDeps {
  getTopicById: (id: string) => Topic | null;
  loadTopics: () => { topics: Record<string, Topic> };
  saveSingleTopic: (topic: Topic) => void;
  slugify: (name: string) => string;
  broadcastToAll: (message: object) => void;
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
}

/**
 * Create a NEW chat topic WITHOUT switching to it — emits only `topic:created`,
 * never `topic:switch`, so it appears as a background tab without stealing focus.
 * Used by the task dispatcher, which needs a topic bound to an explicit project
 * (and optionally a worktree) with no "current" topic to inherit from.
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
    archived: false,
    systemPrompt: opts.systemPrompt ?? "",
    contextFiles: [],
    pinnedMessages: [],
    sortOrder: Object.keys(data.topics).length,
  } as Topic;
  if (opts.projectPath) newTopic.projectPath = opts.projectPath;
  if (opts.worktreeId) newTopic.worktreeId = opts.worktreeId;
  if (opts.effort) newTopic.effort = opts.effort;
  deps.saveSingleTopic(newTopic);
  deps.broadcastToAll({ type: "topic:created", topic: newTopic });
  return { topic: newTopic };
}
