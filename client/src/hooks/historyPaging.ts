import type { ChatMessage } from '../types';
import { mergeFetchedHistory } from './reconcileMessages';
import { isClientGeneratedMessageId } from './streamCatchupMerge';

/**
 * The two merges of a TAIL-FIRST open (`shared/history-paging.ts`), pure so
 * they test under bun:test without a store.
 *
 * `loadHistory` used to receive the whole thread and hand it to
 * `mergeFetchedHistory`, whose one job is to keep what arrived over the wire
 * DURING the fetch (an optimistic bubble, a `message:new`) by appending it after
 * the authoritative list. That rule is right for a whole thread and wrong for a
 * page: the local copy that painted the first frame can hold messages OLDER
 * than the page (the cache is written from the settled tail, the page is the
 * raw tail; while a turn streams the two differ by one), and appending those
 * would put the head of the chat after its end.
 *
 * So the page is merged in two halves around a PIVOT - the first local message
 * the page also has - and the older page is merged around a BOUNDARY - the
 * oldest message of the first page, which is also the `before` cursor the
 * server was asked with. Everything is by id; the server's rows win.
 */

/** `true` for a row the server has already named. */
function durable(m: ChatMessage): boolean {
  return !!m.id && !isClientGeneratedMessageId(m.id);
}

/** Parsed once for the disjoint case; `NaN` when the timestamp is unusable. */
function at(m: ChatMessage): number {
  return Date.parse(m.timestamp ?? '');
}

/**
 * The first page of a thread laid over what the pane already holds.
 *
 * Local durable messages the page does not have are OLDER than the page when
 * they sit before the pivot (or, with no pivot at all, when their timestamp
 * precedes the page's oldest row) and are kept IN FRONT; the older page will
 * replace them with the server's copy when it lands, so they only have to be
 * in the right half. Everything from the pivot on goes through
 * `mergeFetchedHistory`, exactly as a whole thread did: optimistic echoes are
 * dropped, a placeholder for the streaming turn is dropped, and a `message:new`
 * that landed during the fetch stays at the end.
 */
export function mergeHistoryPage(existing: ChatMessage[], page: ChatMessage[]): ChatMessage[] {
  if (existing.length === 0) return page;
  const pageIds = new Set<string>();
  for (const m of page) if (m.id) pageIds.add(m.id);

  const pivot = existing.findIndex((m) => !!m.id && pageIds.has(m.id));
  let older: ChatMessage[];
  let rest: ChatMessage[];
  if (pivot >= 0) {
    older = existing.slice(0, pivot).filter(durable);
    rest = existing.slice(pivot);
  } else {
    // Disjoint: the chat moved on by more than a page while this pane was
    // away, OR something landed during the fetch. Only the clock tells them
    // apart. A row with no usable timestamp is treated as recent, which is
    // the direction that keeps a message on screen rather than hiding it.
    const oldest = page.length > 0 ? at(page[0]) : NaN;
    const isOlder = (m: ChatMessage) => durable(m) && Number.isFinite(oldest) && at(m) < oldest;
    older = existing.filter(isOlder);
    rest = existing.filter((m) => !isOlder(m));
  }
  const merged = mergeFetchedHistory(rest, page);
  return older.length > 0 ? [...older, ...merged] : merged;
}

/**
 * Does the pane already hold a row of this page? When it does AND the thread
 * was known complete before the page arrived, it still is: everything before
 * the page was already there, and the page only refreshed its tail.
 */
export function pageOverlapsExisting(existing: ChatMessage[], page: ChatMessage[]): boolean {
  if (existing.length === 0 || page.length === 0) return false;
  const pageIds = new Set<string>();
  for (const m of page) if (m.id) pageIds.add(m.id);
  return existing.some((m) => !!m.id && pageIds.has(m.id));
}

/**
 * The messages before `boundaryId` laid under what the pane holds from that
 * message on.
 *
 * Everything the pane held BEFORE the boundary is replaced by the server's
 * `older` rows: it came from the local copy and the server is the authority on
 * that stretch (a message deleted from another device must go; a stale copy
 * kept in front by `mergeHistoryPage` with a gap after it is closed). Rows of
 * `older` the pane already holds from the boundary on are dropped, which is
 * what makes an unknown-boundary answer (the server then sends the whole
 * thread) harmless. Returns `existing` itself when there is nothing to change,
 * and when the boundary is no longer in the list - the store was replaced by a
 * whole-thread reload in the meantime and this answer is stale.
 */
export function mergeOlderHistory(existing: ChatMessage[], older: ChatMessage[], boundaryId: string): ChatMessage[] {
  const pivot = existing.findIndex((m) => m.id === boundaryId);
  if (pivot < 0) return existing;
  const kept = existing.slice(pivot);
  const keptIds = new Set<string>();
  for (const m of kept) if (m.id) keptIds.add(m.id);
  const prefix = older.filter((m) => !!m.id && !keptIds.has(m.id));
  if (prefix.length === 0 && pivot === 0) return existing;
  return prefix.length > 0 ? [...prefix, ...kept] : kept;
}
