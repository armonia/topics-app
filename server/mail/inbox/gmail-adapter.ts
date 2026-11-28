/**
 * THE REFERENCE ADAPTER FOR GMAIL, on the `gws` CLI (rule P1).
 *
 * `list` asks for the messages after the cursor (the newest `internalDate` seen,
 * minus a short overlap so a message that landed late is still caught; the
 * unique key of the table drops the repeats), reads every page of ids and
 * fetches only the OLDEST chunk (at most `limit`), answering `more: true` while
 * the window holds more: every call moves the cursor, so a busy mailbox or a
 * long stop is caught up over a few rounds instead of never. It never trims the
 * list: a window with more pages than `MAX_PAGES` is an error of the round, not
 * a silent hole.
 * Only headers are asked for (`format=metadata`): the body is never read here.
 *
 * The `gws` call is injected, so the contract suite runs it on recorded answers.
 */
import type { ContractMessage, ListAdapter, ListRequest, ListResponse } from "./contract";
import { AdapterError } from "./contract";

export const OVERLAP_MS = 60_000;
const MAX_PAGES = 20;
const PAGE_SIZE = 500;
// One `messages.get` per message is one `gws` process: a chunk stays well inside the 30 s of a list call.
const CHUNK = 25;
const PARALLEL_GETS = 5;
const HEADERS = ["From", "To", "Subject", "Message-ID", "In-Reply-To", "Date", "Authentication-Results"];

/** Runs `gws gmail users <resource> <method> --params <json>` and returns the parsed JSON answer. */
export type GwsCall = (resource: "messages", method: "list" | "get", params: Record<string, unknown>) => Promise<unknown>;

interface GmailHeader { name?: string; value?: string }
interface GmailMessage { id?: string; threadId?: string; snippet?: string; internalDate?: string; payload?: { headers?: GmailHeader[] } }

function headerOf(message: GmailMessage, name: string): string {
  const wanted = name.toLowerCase();
  return message.payload?.headers?.find((header) => header.name?.toLowerCase() === wanted)?.value?.trim() ?? "";
}

/** `Name <a@b.c>` or `a@b.c`: only the address, lower-cased, is kept for comparing. */
export function addressOf(value: string): string {
  const angle = /<([^>]+)>/.exec(value);
  return (angle?.[1] ?? value).trim().toLowerCase();
}

function toContract(message: GmailMessage): ContractMessage {
  const id = message.id ?? "";
  const internal = Number(message.internalDate);
  if (!id || !Number.isFinite(internal)) throw new AdapterError("a Gmail message has no id or internalDate");
  const date = headerOf(message, "Date");
  const sent = date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null;
  return {
    id,
    threadId: message.threadId ?? null,
    messageId: headerOf(message, "Message-ID") || null,
    inReplyTo: headerOf(message, "In-Reply-To") || null,
    from: addressOf(headerOf(message, "From")),
    to: headerOf(message, "To").split(",").map(addressOf).filter(Boolean),
    subject: headerOf(message, "Subject"),
    snippet: message.snippet ?? "",
    authResults: headerOf(message, "Authentication-Results") || null,
    sentAt: sent,
    receivedAt: new Date(internal).toISOString(),
  };
}

/**
 * Where a call starts. A plain cursor (`<ms>`) is the steady state: the query
 * starts an overlap before it. A catch-up cursor (`<fromMs>@<lastId>`) keeps the
 * SAME query of the previous call and the id of the newest message it returned:
 * Gmail lists newest first, so the oldest end of a fixed query is stable while
 * new mail lands on top, and the next chunk starts right after that id.
 */
function startOf(request: ListRequest): { fromMs: number; lastId: string | null } {
  const cursor = request.cursor ?? "";
  const catchUp = /^(\d+)@(.+)$/.exec(cursor);
  if (catchUp) return { fromMs: Number(catchUp[1]), lastId: catchUp[2]! };
  if (cursor && Number.isFinite(Number(cursor))) return { fromMs: Number(cursor) - OVERLAP_MS, lastId: null };
  return { fromMs: request.sinceMs, lastId: null };
}

/** Runs `work` on every item with at most `width` calls in flight, keeping the order. */
async function mapLimited<T, R>(items: T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => { while (next < items.length) { const index = next++; out[index] = await work(items[index]!); } };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
  return out;
}

export function createGmailList(gws: GwsCall): ListAdapter {
  return async (request: ListRequest): Promise<ListResponse> => {
    const { fromMs, lastId } = startOf(request);
    const q = `after:${Math.max(0, Math.floor(fromMs / 1000))}`;
    const newestFirst: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new AdapterError("the window has more pages than the adapter reads");
      const answer = (await gws("messages", "list", { userId: "me", q, maxResults: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) })) as { messages?: Array<{ id?: string }>; nextPageToken?: string } | null;
      for (const entry of answer?.messages ?? []) if (entry.id) newestFirst.push(entry.id);
      pageToken = answer?.nextPageToken;
      if (!pageToken) break;
    }
    const ids = newestFirst.reverse();
    // An id that is gone (deleted meanwhile) restarts the fixed query from its oldest end: the unique key drops what is already in.
    const start = lastId ? ids.indexOf(lastId) + 1 : 0;
    const size = Math.max(1, Math.min(request.limit, CHUNK));
    const chunk = ids.slice(start, start + size);
    const more = start + size < ids.length;
    const messages = await mapLimited(chunk, PARALLEL_GETS, async (id) => toContract((await gws("messages", "get", { userId: "me", id, format: "metadata", metadataHeaders: HEADERS })) as GmailMessage));
    messages.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    if (more) return { messages, cursor: `${fromMs}@${chunk[chunk.length - 1]}`, more: true, expired: false };
    const newest = messages.length ? Date.parse(messages[messages.length - 1]!.receivedAt) : null;
    const previous = !lastId && request.cursor && Number.isFinite(Number(request.cursor)) ? Number(request.cursor) : null;
    // An empty last chunk of a catch-up keeps its query start: the next round reads that stretch again, never past it.
    const fallback = previous ?? (lastId ? fromMs + OVERLAP_MS : null);
    const cursor = newest === null ? (fallback === null ? request.cursor : String(fallback)) : String(Math.max(previous ?? newest, newest));
    return { messages, cursor, more: false, expired: false };
  };
}
