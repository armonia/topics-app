import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';

/** The four kinds of a message the kit shows: a toast, a notification. */
export type NoticeTone = 'ok' | 'info' | 'warn' | 'error';

/** One glyph per kind, the same in a toast, a notification and the legend. */
export const NOTICE_ICON: Record<NoticeTone, LucideIcon> = {
  ok: CircleCheck,
  info: Info,
  warn: TriangleAlert,
  error: CircleAlert,
};

/** The tint of that glyph, legible on the surface in both themes. */
export const NOTICE_TEXT: Record<NoticeTone, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  info: 'text-sky-600 dark:text-sky-400',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-rose-600 dark:text-rose-400',
};
