import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/shell/net';
import type { ReadableView } from '../../../shared/readable-view';

/**
 * Asks the server for the model's layout of a shape the pure matcher did not
 * place. At most one request per distinct result per page (the server
 * caches the shape, so only a new shape costs a model call). The answer is a
 * NDJSON stream of fuller and fuller layouts: each line is drawn as it
 * arrives. Until the first one lands the caller keeps showing the original.
 */
const seen = new Map<string, Promise<void>>();
const latest = new Map<string, ReadableView | null>();
const listeners = new Map<string, Set<(view: ReadableView | null) => void>>();

/** Reads a NDJSON body line by line, handing every complete line to `onLine`. */
async function readNdjson(res: Response, onLine: (line: { view?: ReadableView; done?: boolean }) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(JSON.parse(line) as { view?: ReadableView; done?: boolean });
      nl = buffer.indexOf('\n');
    }
    if (done) break;
  }
}

function request(key: string, toolName: string, value: unknown): void {
  if (seen.has(key)) return;
  const publish = (view: ReadableView | null) => {
    latest.set(key, view);
    listeners.get(key)?.forEach((l) => l(view));
  };
  seen.set(key, apiFetch('/api/readable-view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolName, value }),
  })
    .then((r) => (r.ok ? readNdjson(r, (line) => { if (line.view) publish(line.view); }) : undefined))
    .catch(() => undefined));
}

export function useFallbackView(toolName: string, value: unknown): ReadableView | null {
  // Keyed by the value itself: the server caches the shape, but the numbers on screen must be this result's.
  const key = `${toolName}::${JSON.stringify(value)}`;
  const [answer, setAnswer] = useState<{ value: unknown; view: ReadableView | null } | null>(null);
  useEffect(() => {
    if (value === undefined) return;
    const set = listeners.get(key) ?? new Set();
    const l = (view: ReadableView | null) => setAnswer({ value, view });
    set.add(l);
    listeners.set(key, set);
    const known = latest.get(key);
    if (known) l(known);
    request(key, toolName, value);
    return () => { set.delete(l); };
  }, [key, toolName, value]);
  // An answer belongs to the value it was asked for: a stale one is never shown.
  return answer && answer.value === value ? answer.view : null;
}
