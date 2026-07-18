import { pointerWithin, closestCorners, type CollisionDetection } from '@dnd-kit/core';
import { TASK_STATUSES, type TaskStatus } from '../../lib/board';

/**
 * "claude-opus-4-8" → "Opus 4.8" — strip the `claude-` prefix, capitalize the
 * family name, join the remaining numeric segments with dots as the version.
 * Generic on purpose: a new model id needs no update here.
 */
export function friendlyModelLabel(modelId: string): string {
  const parts = modelId.replace(/^claude-/, '').split('-');
  const name = parts[0] ? parts[0][0].toUpperCase() + parts[0].slice(1) : modelId;
  const version = parts.slice(1).join('.');
  return version ? `${name} ${version}` : name;
}

/**
 * Size a textarea to its content (and keep it sized while typing) so the
 * click-to-edit swap <p> ↔ <textarea> never shifts the layout: same font,
 * same padding, same height as the text it replaces.
 */
export const autoGrow = (el: HTMLTextAreaElement | null) => {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
};

/**
 * Two-stage collision for a board that mixes BIG droppables (columns) with
 * SMALL ones (sortable cards). Bare closestCorners compares corner distances,
 * so an EMPTY column loses against a nearby card in the adjacent column — a
 * drop aimed at Todo kept resolving onto the In Progress card ("me lo fa
 * mettere solo in progress"). Pointer-first fixes it: whatever the pointer is
 * INSIDE wins (a card beats its own column for precise insertion; an empty
 * column area is the column); corner distance only breaks ties when the
 * pointer is outside every droppable (fast flicks).
 */
export const boardCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  if (within.length) {
    const card = within.find((c) => !TASK_STATUSES.includes(String(c.id) as TaskStatus));
    return card ? [card] : within;
  }
  return closestCorners(args);
};

/** Compact chat timestamp: HH:MM today, dd/MM HH:MM otherwise. */
export function commentTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })} ${hm}`;
}

/**
 * "Ultimo aggiornamento" for a card/drawer title: relative while fresh, a clock
 * (same day) or date (older) once it ages — short enough to trail a title.
 * ora · 5m fa · 3h fa · HH:MM · dd/MM HH:MM.
 */
export function fmtUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const ms = Date.now() - d.getTime();
  if (ms < 45_000) return 'ora';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m fa`;
  const sameDay = d.toDateString() === new Date().toDateString();
  const h = Math.floor(m / 60);
  if (sameDay && h < 12) return `${h}h fa`;
  return commentTime(iso);
}

/** Compact duration: 42s · 7m · 1h12m. */
export const fmtMs = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
};

/** Live duration — seconds ALWAYS visible so the ticker is seen moving on
 *  in-progress cards (45s · 12m 05s · 1h 20m). fmtMs stays for static totals. */
export const fmtLive = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
};

/** Compact token count: 850 · 12.3k · 1.2M. */
export const fmtTok = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** Model id → compact tier label for the card chip (auto when unresolved). */
export const fmtModel = (m: string | null | undefined): string => {
  if (!m) return 'auto';
  const s = m.toLowerCase();
  if (s.includes('opus')) return 'opus';
  if (s.includes('sonnet')) return 'sonnet';
  if (s.includes('haiku')) return 'haiku';
  if (s.includes('fable')) return 'fable';
  return m.replace(/^claude-/, '').split('-')[0];
};
