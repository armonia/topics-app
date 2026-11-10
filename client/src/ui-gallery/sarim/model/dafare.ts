/**
 * What the inbox shows is a filter, not an address: the list, the kanban and
 * the cards per stage all read the same state, kept under one key. A redirect
 * (`../redirects.ts`) or a screen that wants «the cards of this flow, in this
 * stage» writes that state and opens a view; the view reads it back.
 */
import type { FilterToken, ListFilterState } from '../../app/filters';
import { EMPTY_FILTERS } from '../../app/filters';
import type { ScreenCtx } from '../../app/kit';
import { addDays } from '../../../ui/fixtures/org/clock';
import { SP } from '../paths';

/** The days ahead «Entro 7 giorni» looks, in «Da fare» and in «Dati» alike. (allow-italian: quotes the Italian interface) */
export const DUE_SOON_DAYS = 7;

/** The first day that is NOT «entro 7 giorni»: the one rule for both, late days included (a day before this one counts). (allow-italian: quotes the Italian interface) */
export function dueSoonBefore(today: string): string {
  return addDays(today, DUE_SOON_DAYS + 1);
}

/** Where the filters of the inbox are kept (`ctx.ui`). */
export const INBOX_FILTERS_KEY = 'sarim.dafare.filters';

/** The fields of the inbox a token may name; values are ids (a flow, a stage). */
export const FLOW_FIELD = 'flusso'; // allow-italian: field id of the filter state, compared by value
export const STAGE_FIELD = 'stato'; // allow-italian: field id of the filter state, compared by value

const token = (field: string, value: string): FilterToken => ({ id: `${field}:${value}`, field, op: 'is', value });

/** The filter state with a flow and/or a stage set; nothing set is the empty state. */
export function inboxFilters(flow?: string, stage?: string): ListFilterState {
  const tokens = [flow ? token(FLOW_FIELD, flow) : undefined, stage ? token(STAGE_FIELD, stage) : undefined].filter((t): t is FilterToken => Boolean(t));
  return tokens.length ? { ...EMPTY_FILTERS, tokens } : EMPTY_FILTERS;
}

export type DaFareView = 'list' | 'kanban' | 'stages';

export function daFarePath(view: DaFareView): string {
  return view === 'kanban' ? SP.inboxKanban() : view === 'stages' ? SP.inboxStages() : SP.inbox();
}

/** Opens a view of «Da fare» with a flow and/or a stage on the filter. (allow-italian: quotes the Italian interface) */
export function openDaFare(ctx: ScreenCtx, opts: { view?: DaFareView; flow?: string; stage?: string } = {}): void {
  ctx.ui<ListFilterState>(INBOX_FILTERS_KEY, EMPTY_FILTERS)[1](inboxFilters(opts.flow, opts.stage));
  ctx.go(daFarePath(opts.view ?? 'list'));
}
