/**
 * An agent hit a login wall and asked the person to sign in (`request_login`).
 * The tab is brought forward, the window is raised so it catches the eye, and
 * when asked the topic is popped out into its own window first.
 *
 * Pure over injected effects, so the order is tested without a DOM or a shell;
 * `handleLoginRequestLive` wires the real surfaces.
 */
import { isTauri } from './shell/index';
import { tauriInvoke } from './shell/tauri';
import { popOutTopics } from './popOutTopic';
import { focusBrowserContextLive } from './focusBrowserContext';

export interface LoginRequest {
  contextId: string;
  url: string;
  detached: boolean;
  topicId?: string;
}

export interface LoginRequestEffects {
  /** Brings the tab to the front wherever it lives (layout, task drawer, sheet). */
  focusTab(contextId: string): void;
  /** Pops the topic out into its own window. True when a window opened. */
  popOut(topicId: string): Promise<boolean>;
  /** Raises the main window above the others. */
  raiseWindow(): void;
}

export interface LoginRequestOutcome {
  detached: boolean;
}

export async function handleLoginRequest(req: LoginRequest, fx: LoginRequestEffects): Promise<LoginRequestOutcome> {
  fx.focusTab(req.contextId);
  // Raise first: a detached window born after it stays on top of the main one.
  fx.raiseWindow();
  const detached = req.detached && !!req.topicId ? await fx.popOut(req.topicId) : false;
  return { detached };
}

export function handleLoginRequestLive(req: LoginRequest): Promise<LoginRequestOutcome> {
  return handleLoginRequest(req, {
    focusTab: (contextId) => { void focusBrowserContextLive({ contextId, reopen: false }); },
    popOut: (topicId) => popOutTopics([topicId]),
    raiseWindow: () => {
      if (isTauri) void tauriInvoke('window_focus_label', { label: 'main' }).catch(() => {});
      window.focus();
    },
  });
}
