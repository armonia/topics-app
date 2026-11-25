import { useSyncExternalStore } from 'react';
import { apiFetch } from '../lib/shell/net';
import { isTranslatableSentence, splitSentences } from '../../../shared/reasoning-sentences';

/**
 * The reasoning sentences the server translated into the chat language.
 *
 * A translation is stored under the exact (trimmed) text of the sentence it
 * replaces, so a row finds it by cutting its own text with the same function the
 * server cut it with (`shared/reasoning-sentences.ts`) and looking each piece up.
 * That makes the two sources interchangeable: the WebSocket frames that arrive
 * while the model writes, and the answer of `POST /api/reasoning/translate` for
 * a settled block, both end up here and a row cannot tell them apart.
 *
 * A row with no entry shows its original text, which is also what happens when
 * the server has nothing to translate with.
 */

/** Old sentences leave first: a long session must not grow this without bound. */
const MAX_ENTRIES = 4000;
/** After "not available" the server is not asked again for this long. */
const UNAVAILABLE_BACKOFF_MS = 5 * 60_000;

const entries = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
let unavailableUntil = 0;
/** Blocks already sent to the server, so a re-render never asks twice. */
const asked = new Set<string>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
const getVersion = () => version;

/** Stores one translated sentence. The same pair twice changes nothing and does not notify. */
export function rememberReasoningTranslation(source: string, text: string): void {
  const key = source.trim();
  if (!key || entries.get(key) === text) return;
  entries.delete(key);
  entries.set(key, text);
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  version++;
  for (const listener of listeners) listener();
}

/** Re-renders the component whenever a translation lands. */
export function useReasoningTranslationsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

interface AppliedTranslation {
  /** The text with every translated sentence swapped in; the original where there is none. */
  text: string;
  /** How many sentences were swapped. Zero means `text` is the original. */
  count: number;
}

/** Swaps the translated sentences into `content`, keeping the whitespace around each one. */
export function applyReasoningTranslations(content: string): AppliedTranslation {
  // The common case, nothing translated yet: no need to cut the text at all.
  if (entries.size === 0) return { text: content, count: 0 };
  let count = 0;
  let text = '';
  for (const part of splitSentences(content)) {
    const core = part.trim();
    const translated = core ? entries.get(core) : undefined;
    if (translated === undefined) {
      text += part;
      continue;
    }
    count++;
    const start = part.indexOf(core);
    text += part.slice(0, start) + translated + part.slice(start + core.length);
  }
  return { text, count };
}

/**
 * Asks the server for the translation of a settled block, once per block. Used
 * when a person opens a row: the sentences that stream live arrive by themselves.
 */
export async function requestReasoningTranslation(content: string): Promise<void> {
  if (!content.trim() || asked.has(content) || Date.now() < unavailableUntil) return;
  if (!splitSentences(content).some(isTranslatableSentence)) return;
  asked.add(content);
  try {
    const res = await apiFetch('/api/reasoning/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: content }),
    });
    if (!res.ok) {
      // A failed ask may be tried again the next time the row opens.
      asked.delete(content);
      return;
    }
    const data = (await res.json()) as { available?: boolean; sentences?: Array<{ source: string; text: string }> };
    if (data.available === false) {
      unavailableUntil = Date.now() + UNAVAILABLE_BACKOFF_MS;
      asked.delete(content);
      return;
    }
    for (const s of data.sentences ?? []) rememberReasoningTranslation(s.source, s.text);
  } catch {
    asked.delete(content);
  }
}

/** @internal Test seam: back to an empty store. */
export function resetReasoningTranslations(): void {
  entries.clear();
  asked.clear();
  unavailableUntil = 0;
  version++;
  for (const listener of listeners) listener();
}
