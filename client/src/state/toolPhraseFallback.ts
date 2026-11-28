import { useSyncExternalStore } from 'react';
import { apiFetch } from '../lib/shell/net';
import { toolPhrase, type Phrase } from '../../../shared/tool-phrase';

/**
 * The model's phrase for an MCP tool name `shared/tool-phrase.ts` only
 * guessed. Asked once per tool name per page (the server caches by name, so a
 * new tool costs one model call ever); until it lands, or when the fallback is
 * off, the humanized name stays. Only third-party `mcp__` names are asked.
 */
const learned = new Map<string, Phrase | null>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function ask(rawName: string, args: Record<string, unknown> | undefined): void {
  if (asked.has(rawName) || !rawName.startsWith('mcp__')) return;
  asked.add(rawName);
  apiFetch('/api/tool-phrase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolName: rawName, argKeys: Object.keys(args ?? {}) }),
  })
    .then(async (r) => (r.ok ? ((await r.json()) as { phrase: Phrase | null }).phrase : null))
    .catch(() => null)
    .then((phrase) => {
      learned.set(rawName, phrase);
      version++;
      for (const l of listeners) l();
    });
}

/** `toolPhrase` plus the model's answer for a tool that was only guessed; asks once, silently. */
export function phraseFor(rawName: string, tool: string, args: Record<string, unknown> | undefined): Phrase {
  const phrase = toolPhrase(rawName, tool, args, learned.get(rawName));
  if (phrase.guessed && !asked.has(rawName)) ask(rawName, args);
  return phrase;
}

/** Re-renders the caller when a learned phrase arrives. */
export function useLearnedPhrases(): number {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => void listeners.delete(l); },
    () => version,
    () => version,
  );
}
