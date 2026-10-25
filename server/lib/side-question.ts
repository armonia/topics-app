import type { Database } from "bun:sqlite";
import type { AIProvider } from "../providers";
import type { Topic } from "../types";
import { isSideQuestionTopicId, SIDE_QUESTION_TOPIC_PREFIX } from "../../shared/chat-fork";

export interface SideQuestionCleanupDeps {
  db: Database;
  getTopic: (id: string) => Topic | null;
  isStreaming: (sessionKey: string) => unknown;
  resolveProvider: (topic: Topic) => AIProvider;
  stopAgentProcesses?: (sessionKey: string) => void;
  now?: () => number;
}

const SIDE_QUESTION_TTL_MS = 10 * 60 * 1000;
const SESSION_COLUMNS = ["session_key", "parent_session_key"];
const TOPIC_COLUMNS = ["topic_id", "assigned_topic_id", "created_by_topic_id", "source_id", "target_id", "entity_id", "parent_id", "parent_topic_id"];

/** Delete every persisted reference to an ephemeral question and its CLI session. */
export async function deleteSideQuestion(
  deps: SideQuestionCleanupDeps,
  topic: Topic,
): Promise<void> {
  if (!isSideQuestionTopicId(topic.id)) throw new Error("not an ephemeral side question");
  if (deps.isStreaming(topic.sessionKey)) throw new Error("side question is still running");

  const fork = deps.db.prepare("SELECT runtime FROM chat_forks WHERE session_key = ?").get(topic.sessionKey) as { runtime?: string } | undefined;
  if (fork?.runtime !== "claude-cli") throw new Error("not a Claude side question");

  const provider = deps.resolveProvider(topic) as AIProvider & { discardEphemeralSession?: (key: string) => Promise<void> };
  if (!provider.discardEphemeralSession) throw new Error("Claude provider cannot discard ephemeral sessions");
  await provider.discardEphemeralSession(topic.sessionKey);
  deps.stopAgentProcesses?.(topic.sessionKey);

  const tables = deps.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  const transaction = deps.db.transaction(() => {
    deps.db.exec("PRAGMA defer_foreign_keys = ON");
    for (const { name } of tables) {
      const columns = deps.db.query(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      const predicates: string[] = [];
      const values: string[] = [];
      for (const column of SESSION_COLUMNS) {
        if (names.has(column)) { predicates.push(`${quoteIdentifier(column)} = ?`); values.push(topic.sessionKey); }
      }
      for (const column of TOPIC_COLUMNS) {
        if (names.has(column)) { predicates.push(`${quoteIdentifier(column)} = ?`); values.push(topic.id); }
      }
      if (name === "notification_log" && names.has("target_kind") && names.has("target_id")) {
        predicates.push("(target_kind = 'topic' AND target_id = ?)");
        values.push(topic.id);
      }
      if (name === "notification_log" && names.has("group_key")) {
        predicates.push("group_key = ?");
        values.push(`topic:${topic.id}`);
      }
      if (name === "subject_attention" && names.has("subject")) {
        predicates.push("subject = ?");
        values.push(`topic:${topic.id}`);
      }
      if (predicates.length) deps.db.prepare(`DELETE FROM ${quoteIdentifier(name)} WHERE ${predicates.join(" OR ")}`).run(...values);
    }
    deps.db.prepare("DELETE FROM topics WHERE id = ?").run(topic.id);
  });
  transaction();
}

/** Remove stale questions at boot and before a new one is opened. */
export async function cleanupStaleSideQuestions(deps: SideQuestionCleanupDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const cutoff = now - SIDE_QUESTION_TTL_MS;
  let removed = 0;
  for (const topic of sideQuestionTopics(deps)) {
    if (deps.isStreaming(topic.sessionKey)) continue;
    const createdAt = Date.parse(topic.createdAt);
    if (!Number.isFinite(createdAt) || createdAt >= cutoff) continue;
    // One that cannot go must not keep the others: each is tried, and the failure is said.
    try {
      await deleteSideQuestion(deps, topic);
      removed++;
    } catch (err) {
      console.warn(`[side-question] stale ${topic.id} not removed: ${(err as Error).message}`);
    }
  }
  return removed;
}

/**
 * Only the side questions' rows, by a range on the primary key. Hydrating every
 * topic to find them read the whole table at boot and before every question.
 */
function sideQuestionTopics(deps: SideQuestionCleanupDeps): Topic[] {
  const from = SIDE_QUESTION_TOPIC_PREFIX;
  const to = from.slice(0, -1) + String.fromCharCode(from.charCodeAt(from.length - 1) + 1);
  const rows = deps.db.query("SELECT id FROM topics WHERE id >= ? AND id < ?").all(from, to) as Array<{ id: string }>;
  return rows.map((row) => deps.getTopic(row.id)).filter((topic): topic is Topic => topic !== null);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
