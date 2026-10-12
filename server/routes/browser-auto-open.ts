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
 * `browser_status` probe, and a topic with no persisted url (nothing to
 * show — today's headless dispatch stays).
 *
 * Never fails the op: when the opening fails or no pane attaches in time,
 * the tool still dispatches onto the headless context.
 */
import type { BrowserService } from "../browser-service";
import type { Topic } from "../types";
import type { OpenPaneFlowOptions } from "./browser-open-pane-flow";

/** Page ops that must never mount a pane: pure status reads. */
const NO_AUTO_OPEN_OPS: ReadonlySet<string> = new Set(["browser_status"]);

export interface AutoOpenPaneDeps {
  /** Same liveness notion `open-pane` waits on: a viewer or executor socket. */
  paneAttachedTo: (contextId: string) => boolean;
  /** The shared opening sequence (browser-open-pane-flow.ts). */
  openPaneFlow: (opts: OpenPaneFlowOptions) => Promise<Response>;
  /** Marks the topic as navigated, as the chat branch of open-pane does. */
  markNavigated: (topicId: string) => void;
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
  if (op.contextId.startsWith("term-")) return;
  if (NO_AUTO_OPEN_OPS.has(op.toolName)) return;
  if (deps.paneAttachedTo(op.contextId)) return;
  const url = topic.browserState?.url;
  if (!url) return;
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
