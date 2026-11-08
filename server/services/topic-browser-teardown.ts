/**
 * A topic's browser window dies with the topic.
 *
 * WHY IT EXISTS. `topic-browser:<topicId>` is born the first time a topic opens
 * its browser window and, left alone, it never dies: archiving a topic strips
 * the topic OUT of the shared ui_state records (`purgeTopicFromUiState`), but
 * this key is not shared, it is the topic's own row, and a rewrite has nothing
 * to rewrite. It is the same shape that made `task-browser-*` grow to 30,8% of
 * the init snapshot (see `services/task-tab-teardown.ts`, which fixes the twin
 * one level down). Here the row is dropped outright, because unlike a task a
 * topic really is gone from every surface once archived.
 *
 * WHERE IT IS CALLED. Inside `purgeTopicFromUiState` (routes/topics.ts), which
 * is step 3 of `archiveTopicFully` and the ONE door every archive path already
 * goes through: the human DELETE route, the dispatcher pruning attempt topics,
 * and the repair pass over an already archived topic. Hooking the service
 * itself into each of those would be three places to forget.
 *
 * WHAT IT GUARANTEES. After it, for that topic:
 *   1. the `topic-browser:<topicId>` row does not exist,
 *   2. the sheets that were inside the window are closed on every device
 *      (`browser:close-pane`) and their headless contexts destroyed,
 *   3. the clients forget the key — that is `topic:archived`, which the archive
 *      broadcasts anyway and `useTaskBrowserTabsSync` now listens to. Without
 *      it a client with an open window re-PUTs the key from its debounce a
 *      second later, and the row outlives the topic after all.
 *
 * CONTEXTS, NOT ONLY BYTES. The sheets are read BEFORE the delete: once the row
 * is gone nobody knows those contextIds ever existed, and a live headless
 * context nobody can reach is the expensive half of the leak. `promoted` is
 * deliberately left alone: those panes live in `pane-store-v2` and the shared
 * purge above is what removes them.
 *
 * UNARCHIVING DOES NOT BRING THE WINDOW BACK, and it should not: the pages it
 * held were closed here. The topic comes back with no window, which is the
 * state a topic that never opened one has.
 */
import type { Database } from "bun:sqlite";

export const TOPIC_BROWSER_PREFIX = "topic-browser:";

/** The single `ui_state` key a topic owns for its browser window. */
export function topicBrowserKeyFor(topicId: string): string {
  return `${TOPIC_BROWSER_PREFIX}${topicId}`;
}

export interface TopicBrowserTeardownDeps {
  db: Database;
  /** `broadcastToAll`. Absent means no frame (the boot sweep has no clients). */
  broadcastToAll?: (msg: any) => void;
  /**
   * `browserService.destroyContext`. Best-effort and not awaited: a context
   * that never really existed rejects, and that must not fail the archive.
   */
  destroyContext?: (contextId: string) => Promise<void> | void;
}

export interface TopicBrowserTeardownReport {
  /** The keys actually deleted (empty when the topic had no window). */
  keysDeleted: string[];
  /** Bytes of `key + value` freed: the measure that counts, not the rows. */
  bytesFreed: number;
  /** The contextIds released, in the order they were closed. */
  contextsReleased: string[];
}

const EMPTY_REPORT: TopicBrowserTeardownReport = { keysDeleted: [], bytesFreed: 0, contextsReleased: [] };

/** The sheets of a persisted window, defensively: the row is untrusted JSON. */
function sheetContextIds(value: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return []; }
  if (!parsed || typeof parsed !== "object") return [];
  const tabs = (parsed as { tabs?: unknown }).tabs;
  if (!Array.isArray(tabs)) return [];
  const ids: string[] = [];
  for (const tab of tabs) {
    const id = (tab as { contextId?: unknown } | null)?.contextId;
    if (typeof id === "string" && id) ids.push(id);
  }
  return ids;
}

/**
 * Drop the browser window of the given topics and release the contexts behind
 * their sheets. Synchronous on the database (one IMMEDIATE transaction, like
 * every `ui_state` write), best-effort on everything else.
 */
export function purgeTopicBrowserState(
  deps: TopicBrowserTeardownDeps,
  topicIds: readonly string[],
): TopicBrowserTeardownReport {
  const ids = [...new Set(topicIds.filter((id): id is string => !!id))];
  if (!ids.length) return { ...EMPTY_REPORT };

  const keys = ids.map(topicBrowserKeyFor);
  const placeholders = keys.map(() => "?").join(",");

  let found: { key: string; value: string }[] = [];
  try {
    found = deps.db
      .transaction(() => {
        const rows = deps.db
          .query(`SELECT key, value FROM ui_state WHERE key IN (${placeholders})`)
          .all(...keys) as { key: string; value: string }[];
        if (!rows.length) return [];
        deps.db.run(`DELETE FROM ui_state WHERE key IN (${placeholders})`, keys);
        return rows;
      })
      .immediate();
  } catch (err) {
    // Not swallowed, but it must not fail the archive: the topic IS archived,
    // and a coherent board with a dirty registry nobody knows about is worse
    // than a logged failure.
    console.error(
      `[topic-browser] teardown failed for topicIds=${ids.join(",")}:`,
      err instanceof Error ? err.message : err,
    );
    return { ...EMPTY_REPORT };
  }

  if (!found.length) return { ...EMPTY_REPORT };

  const contexts = found.flatMap((row) => sheetContextIds(row.value));
  for (const contextId of contexts) {
    try { deps.broadcastToAll?.({ type: "browser:close-pane", contextId }); } catch { /* best-effort */ }
    try {
      const p = deps.destroyContext?.(contextId);
      if (p && typeof (p as Promise<void>).catch === "function") {
        void (p as Promise<void>).catch(() => { /* no headless context: native pane */ });
      }
    } catch { /* idem */ }
  }

  return {
    keysDeleted: found.map((r) => r.key),
    bytesFreed: found.reduce((n, r) => n + r.key.length + r.value.length, 0),
    contextsReleased: contexts,
  };
}
