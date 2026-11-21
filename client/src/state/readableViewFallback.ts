import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/shell/net';
import { shapeSignature, type ReadableView } from '../../../shared/readable-view';

/**
 * Asks the server for the model's layout of a shape the pure matcher did not
 * place. At most one request per structural signature per page (the server
 * caches across pages), so a re-render never costs a call. Until the answer
 * lands the caller keeps showing the original text.
 */
const answers = new Map<string, ReadableView | null>();
const pending = new Map<string, Promise<ReadableView | null>>();

function request(toolName: string, value: unknown, model: string): Promise<ReadableView | null> {
  const key = `${toolName}::${shapeSignature(value)}`;
  const known = pending.get(key);
  if (known) return known;
  const p = apiFetch('/api/readable-view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolName, value, ...(model ? { model } : {}) }),
  })
    .then(async (r) => (r.ok ? ((await r.json()) as { view: ReadableView | null }).view : null))
    .catch(() => null)
    .then((view) => { answers.set(key, view); return view; });
  pending.set(key, p);
  return p;
}

export function useFallbackView(toolName: string, value: unknown, enabled: boolean, model: string): ReadableView | null {
  const [answer, setAnswer] = useState<{ value: unknown; view: ReadableView | null } | null>(null);
  useEffect(() => {
    if (!enabled || value === undefined) return;
    let live = true;
    void request(toolName, value, model).then((view) => { if (live) setAnswer({ value, view }); });
    return () => { live = false; };
  }, [toolName, value, enabled, model]);
  // An answer belongs to the value it was asked for: a stale one is never shown.
  return enabled && answer && answer.value === value ? answer.view : null;
}
