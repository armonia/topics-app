/**
 * Browser tab inventory — enumerate EVERY live browser pane the server can
 * reach, not just the one bound to a given session.
 *
 * The app has two kinds of reachable pane, and this module unions them:
 *   - native WKWebView panes (Tauri, the primary shell): every one registers
 *     itself in the `nativeDelegateRegistry` on mount, so `listDelegated()` is
 *     the authoritative inventory of live native panes.
 *   - headless CDP/Playwright contexts (web/dev builds): `browserService`
 *     tracks them via `listContexts()`.
 *
 * Metadata (url/title) is resolved ON DEMAND at list time — a delegated
 * `browser_status` for native panes, the `listContexts()` row for CDP — rather
 * than stored in the registry: storing it would need a client→server frame on
 * every navigation and would still go stale the moment the user browses. A
 * list-tabs call is rare and small-N, so a per-pane status round-trip (capped
 * by a short race so a wedged pane can't hang the whole list) is exact and cheap.
 *
 * Pure + dependency-injected (only a type import) so the union / labelling /
 * fallback logic is unit-tested without a server, DB, or live pane. The route
 * (server/routes/topics.ts) builds the deps closure from the real singletons.
 */
import type { Topic } from "./types";

export interface BrowserTabInfo {
  /** The BrowserService/CDP contextId — pass this as the `contextId` arg of any
   *  browser_* tool (or close_browser_pane / browser_focus_tab) to target it. */
  contextId: string;
  url: string;
  title: string;
  /** Human-friendly label: topic name, terminal name — cwd, or a URL hostname. */
  label: string;
  kind: "topic" | "terminal" | "other";
  /** True when this is the calling session's OWN pane. */
  isOwn: boolean;
}

export interface TabInventoryDeps {
  /** Ids of live native (delegated) panes — nativeDelegateRegistry.listDelegated. */
  listDelegated(): string[];
  /** Headless CDP/Playwright contexts — browserService.listContexts (id/url/title). */
  listContexts(): { id: string; url: string; title: string }[];
  /** Resolve a topic whose id IS the contextId (default per-topic isolation). */
  getTopicById(id: string): Topic | null;
  /** Resolve a topic whose custom browserState.contextId equals the contextId. */
  findTopicByContextId(contextId: string): Topic | null;
  /** Resolve a terminal session by id (contextId `term-<id>` → this). */
  getTerminalSessionById(id: string): { id: string; name: string; cwd: string } | undefined;
  /** Resolve a task-owned browser ctx (`task-<id8>-…`) → the owning task's text,
   *  for the "Task: <text>" label. Null when the prefix matches no task. */
  getTaskByContextId(contextId: string): { text: string } | null;
  /** Fetch fresh {url,title} from a live native pane (delegated browser_status). */
  fetchNativeStatus(contextId: string): Promise<{ url?: string; title?: string } | null>;
  /** Cap for the per-pane status round-trip (default 2000ms). */
  statusTimeoutMs?: number;
}

/** posix basename without pulling in `path` (cwd is a posix path on the shells). */
function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Hostname of a URL, or "" if it isn't a parseable absolute URL. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Union of live native registrations + headless CDP/Playwright contexts.
 * A `Set` dedupes the Tauri case where the same topic contextId is both
 * registry-registered AND has (or lazily created) a headless context.
 */
export function collectLiveContextIds(
  deps: Pick<TabInventoryDeps, "listDelegated" | "listContexts">,
): Set<string> {
  const ids = new Set<string>(deps.listDelegated());
  for (const c of deps.listContexts()) ids.add(c.id);
  return ids;
}

/** Resolve label + kind for one contextId (topic → terminal `term-<id>` → other). */
export function labelForContext(
  contextId: string,
  deps: TabInventoryDeps,
  meta?: { url?: string; title?: string },
): { label: string; kind: BrowserTabInfo["kind"] } {
  const byId = deps.getTopicById(contextId);
  if (byId) return { label: byId.name, kind: "topic" };

  const byCtx = deps.findTopicByContextId(contextId);
  if (byCtx) return { label: byCtx.name, kind: "topic" };

  // Task-owned browser tab (`task-<id8>-…`, feature-flagged): label it by the
  // owning task's text so `browser_list_tabs` reads "Task: <title>" instead of
  // a bare hostname. Kept `kind:"other"` (no union churn) — the label carries
  // the meaning. Guard on the hex id8 shape so a non-task ctx that happens to
  // start with "task-" never triggers a spurious DB lookup.
  if (/^task-[0-9a-f]{1,32}-/i.test(contextId)) {
    const task = deps.getTaskByContextId(contextId);
    if (task) return { label: task.text ? `Task: ${task.text}` : "Task", kind: "other" };
  }

  const termMatch = /^term-(.+)$/.exec(contextId);
  if (termMatch) {
    const term = deps.getTerminalSessionById(termMatch[1]);
    if (term) {
      const dir = baseName(term.cwd);
      return { label: dir ? `${term.name} — ${dir}` : term.name, kind: "terminal" };
    }
  }

  const title = meta?.title?.trim();
  const host = meta?.url ? hostnameOf(meta.url) : "";
  return { label: title || host || contextId, kind: "other" };
}

/** Race a promise against a timeout that resolves to `null` (never rejects). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * List every live browser tab, own-first. `ownContextId` marks the caller's own
 * pane (may be null — a pane-less session can still list). Metadata resolution:
 * for a delegated (native) pane, race `fetchNativeStatus` against a short
 * timeout so one wedged pane can't stall the list; fall back to the
 * `listContexts()` row (if any), else empty url/title.
 */
export async function listBrowserTabs(
  deps: TabInventoryDeps,
  ownContextId: string | null,
): Promise<BrowserTabInfo[]> {
  const timeoutMs = deps.statusTimeoutMs ?? 2000;
  const ids = [...collectLiveContextIds(deps)];
  const delegated = new Set(deps.listDelegated());
  const cdp = new Map(deps.listContexts().map((c) => [c.id, c]));

  const tabs = await Promise.all(
    ids.map(async (contextId): Promise<BrowserTabInfo> => {
      let url = "";
      let title = "";
      if (delegated.has(contextId)) {
        const status = await withTimeout(deps.fetchNativeStatus(contextId), timeoutMs);
        if (status && typeof status === "object") {
          url = typeof status.url === "string" ? status.url : "";
          title = typeof status.title === "string" ? status.title : "";
        }
      }
      if (!url && !title) {
        const row = cdp.get(contextId);
        if (row) {
          url = row.url ?? "";
          title = row.title ?? "";
        }
      }
      const { label, kind } = labelForContext(contextId, deps, { url, title });
      return { contextId, url, title, label, kind, isOwn: contextId === ownContextId };
    }),
  );

  // Own-first, then topic → terminal → other, stable within each group.
  const rank: Record<BrowserTabInfo["kind"], number> = { topic: 0, terminal: 1, other: 2 };
  return tabs
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      if (a.t.isOwn !== b.t.isOwn) return a.t.isOwn ? -1 : 1;
      const r = rank[a.t.kind] - rank[b.t.kind];
      return r !== 0 ? r : a.i - b.i;
    })
    .map((x) => x.t);
}
