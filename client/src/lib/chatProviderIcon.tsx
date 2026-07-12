import { useSyncExternalStore } from 'react';
import { ClaudeIcon } from '@/components/Shared/ClaudeIcon';
import { CodexIcon } from '@/components/Shared/CodexIcon';
import { subscribeProvidersSnapshot, getProvidersSnapshotState } from './providersSnapshotStore';

/**
 * A chat's LEADING glyph — the small mark shown before its name in the tab bar,
 * the sidebar, the command palette, and the empty-conversation placeholder.
 *
 * Chats no longer carry a decorative, user-picked "topic icon" (the whole
 * MessageSquare / Rocket / Star… picker was removed). A chat now reads in the
 * SAME functional language as every other pane: the glyph reflects WHAT the pane
 * is. For a chat that's its backing AI provider — Claude (local) shows the
 * Claude mark, Codex shows the Codex mark — exactly like the terminal tabs brand
 * their Claude Code / Codex sessions. A cloud (OpenClaw) chat carries its own
 * Cloud badge in the trailing rail, so it returns null here (no double-mark), as
 * does any other/unknown provider (name-only, like an icon-less project favicon).
 */
export type ChatAgentBrand = 'claude' | 'codex' | null;

/**
 * Resolve a chat's brand from its persisted provider, falling back to the global
 * default (a topic with `provider: null` uses whatever the server defaults to —
 * `claude-code` in a normal Claude-first setup, so ordinary chats resolve to the
 * Claude mark).
 */
// eslint-disable-next-line react-refresh/only-export-components -- resolver + hook are colocated with the tiny ChatAgentIcon they feed; splitting a 3-symbol module for a dev-only HMR hint isn't worth it (same call as topicIcons.tsx)
export function resolveChatAgentBrand(
  provider: string | null | undefined,
  defaultProvider?: string | null,
): ChatAgentBrand {
  const p = (provider || defaultProvider || '').toLowerCase();
  if (p === 'claude' || p === 'claude-code' || p === 'claude-code-team') return 'claude';
  if (p === 'codex' || p === 'openai') return 'codex';
  // openclaw (cloud) → its Cloud badge is the identity; everything else → none.
  return null;
}

/**
 * The global default provider name (what a `provider: null` topic resolves to).
 * Lean external-store selector: a consumer only re-renders when the DEFAULT
 * itself changes (a string), so it's safe to call from the memoized sidebar rows
 * without the churn a full `useProvidersSnapshot()` subscription would cause.
 * Falls back to `claude-code` before the snapshot loads so the common case
 * paints the Claude mark immediately, with no first-frame flash.
 */
// eslint-disable-next-line react-refresh/only-export-components -- see resolveChatAgentBrand above; hook colocated with its consumer component
export function useDefaultProvider(): string {
  return useSyncExternalStore(
    subscribeProvidersSnapshot,
    readDefaultProvider,
    () => 'claude-code',
  );
}

function readDefaultProvider(): string {
  const snap = getProvidersSnapshotState().snapshot;
  return snap?.defaultProvider || snap?.providers.find((p) => p.isDefault)?.name || 'claude-code';
}

/**
 * Render the resolved brand glyph, or nothing. Returning null lets the icon slot
 * collapse to name-only — the same "no fake glyph" convention project favicons
 * follow. Claude keeps its brand orange (matching the Claude Code terminal tab);
 * Codex is mono ink (OpenAI's brand is monochrome).
 */
export function ChatAgentIcon({ brand, size = 14, className }: { brand: ChatAgentBrand; size?: number; className?: string }) {
  if (brand === 'claude') return <ClaudeIcon size={size} className={className ? `text-[#D97757] ${className}` : 'text-[#D97757]'} />;
  if (brand === 'codex') return <CodexIcon size={size} className={className} />;
  return null;
}
