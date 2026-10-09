/**
 * The recap a respawned Claude CLI session reads before the next message: DB
 * driven, so the model picks up the thread after a doomed `--resume`. The
 * conversation itself comes from the shared handoff (`providers/handoff.ts`);
 * the prose-only replay below is the fallback when the store cannot rebuild
 * the thread.
 */
import { getDatabase } from "../../db";

/**
 * Maximum non-system turns to replay when recovering from a lost CLI session.
 * Mirrors codex's CODEX_HISTORY_TURN_CAP — 20 user/assistant turns is enough
 * for the model to pick up context without blowing the context window.
 */
const REPLAY_TURN_CAP = 20;

const REPLAY_CONTEXT_PREFIX = "[Chat messages since your last reply";
const REPLAY_BROWSER_MARKER = /\{\{BROWSER:.*?\}\}/g;
const REPLAY_TOPIC_SWITCH_MARKER = /\{\{TOPIC_SWITCH:[\w-]+\}\}\s*/g;
const REPLAY_TOPIC_NEW_MARKER = /\{\{TOPIC_NEW:[^}]+\}\}\s*/g;

export interface ReplayTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Walk the active branch of the `messages` table for `sessionKey` and return
 * the turns (excluding the very last one, which is the user's brand-new
 * message that the caller is about to send fresh).
 *
 * Why its own query rather than the history `assembleTopicContext` builds: the
 * provider has no access to the AppContext closure where loadActiveThread
 * lives — and adding a constructor-time DI parameter just for this would
 * ripple through provider/index/createProvider. A direct query against the
 * already-imported `getDatabase()` keeps the resilience layer self-contained.
 */
export function loadActiveBranchForReplay(sessionKey: string): ReplayTurn[] {
  let db: ReturnType<typeof getDatabase>;
  try {
    db = getDatabase();
  } catch {
    return [];
  }

  // Pull every persisted row for this session (skip partial/streaming rows;
  // they'd teach the model that truncation is OK).
  type Row = { id: string; role: string; content: string | null; parent_id: string | null; branch_index: number | null };
  const rows = db
    .prepare(
      `SELECT id, role, content, parent_id, branch_index
       FROM messages
       WHERE session_key = ? AND COALESCE(partial,0) = 0`,
    )
    .all(sessionKey) as Row[];
  if (rows.length === 0) return [];

  // Build parent → children map and walk the active branch from root.
  // For each parent we pick the child whose branch_index matches the
  // active branch row in `active_branches`; absent that, branch 0.
  const childrenOf = new Map<string | "__root__", Row[]>();
  for (const r of rows) {
    const key = r.parent_id ?? "__root__";
    const list = childrenOf.get(key) ?? [];
    list.push(r);
    childrenOf.set(key, list);
  }

  const activeRows: Row[] = [];
  let cursor: string | null = null;
  while (true) {
    // Both annotated on purpose: `cursor` is reassigned from `chosen.id` at the
    // bottom of this loop, so under `noImplicitAny` tsc sees key → candidates →
    // chosen → cursor → key and gives up (TS7022, "referenced in its own
    // initializer"). Naming the types cuts the cycle; they are what the map
    // already declares.
    const key: string = cursor ?? "__root__";
    const candidates: Row[] = childrenOf.get(key) ?? [];
    if (candidates.length === 0) break;
    let chosen: Row | undefined;
    if (candidates.length === 1) {
      chosen = candidates[0];
    } else {
      try {
        const lookupKey = cursor ?? "__root__";
        const active = db
          .prepare(
            "SELECT active_branch_index FROM active_branches WHERE parent_id = ? AND session_key = ?",
          )
          .get(lookupKey, sessionKey) as { active_branch_index: number } | undefined;
        const targetIdx = active?.active_branch_index ?? 0;
        chosen =
          candidates.find((c) => (c.branch_index ?? 0) === targetIdx) ?? candidates[0];
      } catch {
        chosen = candidates[0];
      }
    }
    if (!chosen) break;
    activeRows.push(chosen);
    cursor = chosen.id;
  }

  return activeRows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .filter((r) => !(r.content ?? "").startsWith(REPLAY_CONTEXT_PREFIX))
    .map((r) => ({
      role: r.role as "user" | "assistant",
      content: (r.content ?? "")
        .replace(REPLAY_BROWSER_MARKER, "")
        .replace(REPLAY_TOPIC_SWITCH_MARKER, "")
        .replace(REPLAY_TOPIC_NEW_MARKER, "")
        .trim(),
    }))
    .filter((t) => t.content.length > 0)
    // Exclude the last entry — it's the user's just-appended turn that
    // sendChatInternal will dispatch fresh as the new prompt.
    .slice(0, -1);
}

export function hasPriorMessagesInDB(sessionKey: string): boolean {
  let db: ReturnType<typeof getDatabase>;
  try {
    db = getDatabase();
  } catch {
    return false;
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
       WHERE session_key = ? AND role IN ('user','assistant') AND COALESCE(partial,0) = 0`,
    )
    .get(sessionKey) as { n: number } | undefined;
  // > 1 because the user's brand-new turn was just appended; we only need
  // *prior* context, not the message we're about to send.
  return (row?.n ?? 0) > 1;
}

/** The recap of a reset session, around the shared handoff (`providers/handoff.ts`). */
export function renderRecapPrologue(handoff: string): string {
  return [
    "[The CLI session was reset and lost its memory. Recap of the conversation so far. Read it carefully, then respond to the new message that follows.]",
    "",
    "<conversation_recap>",
    handoff,
    "</conversation_recap>",
    "",
  ].join("\n");
}

export function renderReplayPrologue(turns: ReplayTurn[]): string {
  const kept = turns.length > REPLAY_TURN_CAP ? turns.slice(-REPLAY_TURN_CAP) : turns;
  const truncated = kept.length < turns.length;
  const lines: string[] = [
    "[The CLI session was reset and lost its memory. Recap of the conversation so far. Read it carefully, then respond to the new message that follows.]",
    "",
    "<conversation_recap>",
  ];
  if (truncated) {
    lines.push(
      `_(Earlier ${turns.length - kept.length} turns omitted; only the most recent ${kept.length} are shown.)_`,
      "",
    );
  }
  for (const t of kept) {
    if (t.role === "user") {
      lines.push("**User:**", t.content, "");
    } else {
      lines.push("**Assistant:**", t.content, "");
    }
  }
  lines.push("</conversation_recap>", "");
  return lines.join("\n");
}
