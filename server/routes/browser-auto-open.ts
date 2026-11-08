/**
 * AUTO-OPEN ON A PAGE OP — the topic's mini browser mounts before the tool lands.
 *
 * The defect (seen 12/10): an agent's `screenshot`/`eval` on its own topic,
 * which had no mounted pane, drove a headless phantom for minutes while the
 * user saw no panel. Only an explicit `open-pane` made the mini browser
 * appear. The generic bridge dispatched straight onto the invisible context.
 *
 * The fix: when a page op arrives on the caller's OWN topic and no pane is
 * attached to that context, run the SAME opening sequence the chat branch of
 * `open-pane` runs (announce first, so a native pane can register as
 * delegate, then navigate), and only then dispatch the tool. The pane the op
 * lands on is the one the user watches.
 *
 * What never auto-opens: a `contextId` override (driving someone else's tab
 * must not rearrange the caller's window), a terminal `term-*` context (its
 * pane lives next to the terminal, not in the topic layout), the read-only
 * `browser_status` probe, a task topic (its tab lives in the task drawer
 * with `forceOpen: false` — a forced standalone pane would take it outside
 * the drawer, and task agents run unattended anyway), and a topic with
 * neither a persisted url nor a live context url (nothing to show — today's
 * headless dispatch stays).
 *
 * Which url is announced: the live context's own url when BrowserService
 * already has one for that contextId (the agent may have moved with
 * `browser_eval location.href=...` since the persisted url was written —
 * navigating back to the persisted one would destroy its state), the
 * persisted url only when no live context exists.
 *
 * At most one attempt per contextId every 60 s: with no Topics window
 * connected every op would otherwise pay the pane wait plus a navigation.
 * After a failed attempt the next ops in that window dispatch headless
 * directly.
 *
 * Never fails the op: when the opening fails or no pane attaches in time,
 * the tool still dispatches onto the headless context.
 */
import type { BrowserService } from "../browser-service";
import type { Topic } from "../types";
import type { OpenPaneFlowOptions } from "./browser-open-pane-flow";

/** Page ops that must never mount a pane: pure status reads. */
const NO_AUTO_OPEN_OPS: ReadonlySet<string> = new Set(["browser_status"]);

/** Minimum delay between two auto-open attempts on the same context. */
export const AUTO_OPEN_RETRY_MS = 60_000;

/** In-memory last-attempt timestamps, keyed by contextId. */
export type AutoOpenAttempts = Map<string, number>;

const sharedAttempts: AutoOpenAttempts = new Map();

export interface AutoOpenPaneDeps {
  /** Same liveness notion `open-pane` waits on: a viewer or executor socket. */
  paneAttachedTo: (contextId: string) => boolean;
  /** The shared opening sequence (browser-open-pane-flow.ts). */
  openPaneFlow: (opts: OpenPaneFlowOptions) => Promise<Response>;
  /** Marks the topic as navigated, as the chat branch of open-pane does. */
  markNavigated: (topicId: string) => void;
  /** True when the topic is a task dispatch (its tab lives in the drawer). */
  isTaskTopic: (topic: Topic) => boolean;
  /** Last auto-open attempt per contextId (defaults to a shared map). */
  attempts?: AutoOpenAttempts;
  /** Clock, injectable so tests can move past the retry window. */
  now?: () => number;
}

export interface AutoOpenPaneOp {
  toolName: string;
  /** Null when the caller is not a chat topic (terminal session, stranger). */
  topic: Topic | null;
  contextId: string;
  /** True when the caller passed an explicit `contextId` override. */
  hasOverride: boolean;
  service: BrowserService;
  /** The chat-branch announce: mounts the topic's mini browser. */
  announce: (url: string) => void;
}

/**
 * The live url of an already-running context, if it has navigated anywhere
 * worth keeping. Null when there is no context, no url yet, or it still sits
 * on the blank page a fresh context is born with.
 */
function liveContextUrl(service: BrowserService, contextId: string): string | null {
  let raw: unknown;
  try {
    raw = service.getUrl?.(contextId);
  } catch {
    return null;
  }
  const url = typeof raw === "object" && raw !== null ? (raw as { url?: unknown }).url : null;
  if (typeof url !== "string" || url === "" || url === "about:blank") return null;
  return url;
}

/**
 * Mount the topic's mini browser first when a page op would otherwise land
 * on an invisible context. Resolves without a value; failures stay silent
 * on purpose — the caller always dispatches afterwards (headless fallback).
 */
export async function maybeOpenPaneForPageOp(
  deps: AutoOpenPaneDeps,
  op: AutoOpenPaneOp,
): Promise<void> {
  if (op.hasOverride) return;
  const topic = op.topic;
  if (!topic) return;
  if (deps.isTaskTopic(topic)) return;
  if (op.contextId.startsWith("term-")) return;
  if (NO_AUTO_OPEN_OPS.has(op.toolName)) return;
  if (deps.paneAttachedTo(op.contextId)) return;
  const url = liveContextUrl(op.service, op.contextId) ?? topic.browserState?.url;
  if (!url) return;
  const attempts = deps.attempts ?? sharedAttempts;
  const now = (deps.now ?? Date.now)();
  const last = attempts.get(op.contextId);
  if (last !== undefined && now - last < AUTO_OPEN_RETRY_MS) return;
  attempts.set(op.contextId, now);
  deps.markNavigated(topic.id);
  try {
    await deps.openPaneFlow({
      contextId: op.contextId,
      url,
      projectPath: topic.projectPath ?? null,
      service: op.service,
      announce: op.announce,
    });
  } catch {
    // The pane never mounted: the tool below still runs headless.
  }
}
