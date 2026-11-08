/**
 * Spans of time in the project menu's words, apart from the components so the
 * menu's files export components only (fast refresh).
 */
import type { useT } from '../../hooks/useT';

type Tr = ReturnType<typeof useT>;

/** A span of time in the menu's words: minutes, then hours, then days. */
export function spanWords(tr: Tr, ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return tr('projectHub.span.min', { n: Math.max(1, min) });
  const h = Math.round(min / 60);
  if (h < 48) return tr('projectHub.span.h', { n: h });
  return tr('projectHub.span.d', { n: Math.round(h / 24) });
}
