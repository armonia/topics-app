/**
 * SARIM edition: the crumbs of every pane header follow one rule, so the
 * reader always knows where a page sits and can go up from it.
 *
 * Everything that belongs to the organization starts with its name (the org
 * crumb opens the settings, Organization section: the page about SARIM itself). The
 * preferences belong to the person, so they start with their own section
 * instead. Every crumb but the last one opens its place; on a phone only the
 * place itself is shown, the header is too narrow for the trail.
 */
import type { CrumbModel } from '../../ui/types';
import type { ScreenCtx } from '../app/kit';
import { SP } from './paths';

/** One step of the trail: its words, and what it opens (an address, or a direct action when no address says it; none for the place itself). */
export interface Crumb {
  label: string;
  to?: string;
  detail?: string;
  onSelect?: () => void;
}

const crumb = (ctx: ScreenCtx, c: Crumb): CrumbModel => ({
  label: c.label,
  detail: c.detail,
  /* A crumb that names the page on show opens nothing: pressing it would change nothing. */
  onSelect: c.onSelect ?? (c.to && c.to !== ctx.path ? () => ctx.go(c.to as string) : undefined),
});

/** The crumbs of a page of the organization: `SARIM / <trail>`. */
export function orgCrumbs(ctx: ScreenCtx, trail: Crumb[]): CrumbModel[] {
  if (ctx.phone && trail.length) return [crumb(ctx, trail[trail.length - 1])];
  return [crumb(ctx, { label: ctx.copy.sarimAdmin.settings.org, to: SP.settings('organizzazione') }), ...trail.map((c) => crumb(ctx, c))];
}

/** The crumbs of a page of the person: `Preferenze / <trail>`, no organization in front. */
export function personCrumbs(ctx: ScreenCtx, trail: Crumb[]): CrumbModel[] {
  if (ctx.phone && trail.length) return [crumb(ctx, trail[trail.length - 1])];
  return trail.map((c) => crumb(ctx, c));
}
