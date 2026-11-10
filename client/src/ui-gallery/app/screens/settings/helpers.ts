/**
 * What the pages of Settings share that is not a component: who may change
 * things, how a moment is written, whether a job is running.
 */
import type { ScreenCtx } from '../../kit';

/** The controls of a settings page are off only for people without the `admin` permission. */
export function adminGate(ctx: ScreenCtx) {
  const admin = ctx.can('admin');
  return { admin, disabled: !admin, title: ctx.deniedTitle('admin') };
}

/** `06/11 03:00` from an ISO date-time, read as written (no time zone arithmetic). */
export function stamp(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`;
}

/** `06/11/2026` from `2026-11-06`. */
export function dayText(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
}

/** `06/11` from `2026-11-06`. */
export function shortDay(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

/** Whether a job of this id is running now. */
export function isRunning(ctx: ScreenCtx, id: string): boolean {
  return ctx.job(id)?.status === 'running';
}

/** A network range as `a.b.c.d/n`: four octets up to 255 and a mask up to 32. */
export function isCidr(text: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text.trim());
  if (!m) return false;
  return m.slice(1, 5).every((o) => Number(o) <= 255) && Number(m[5]) <= 32;
}
