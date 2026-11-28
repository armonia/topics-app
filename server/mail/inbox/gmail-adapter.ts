/**
 * THE REFERENCE ADAPTER FOR GMAIL, on the `gws` CLI (rule P1).
 *
 * `list` asks for the messages after the cursor (the newest `internalDate` seen,
 * minus a short overlap so a message that landed late is still caught; the
 * unique key of the table drops the repeats), reads every page of the answer
 * and hands the messages back oldest first. It never trims the list: a window
 * with more pages than `MAX_PAGES` is an error of the round, not a silent hole.
 * Only headers are asked for (`format=metadata`): the body is never read here.
 *
 * The `gws` call is injected, so the contract suite runs it on recorded answers.
 */
import type { ContractMessage, ListAdapter, ListRequest, ListResponse } from "./contract";
import { AdapterError } from "./contract";

export const OVERLAP_MS = 60_000;
const MAX_PAGES = 20;
const PAGE_SIZE = 100;
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

export function createGmailList(gws: GwsCall): ListAdapter {
  return async (request: ListRequest): Promise<ListResponse> => {
    const from = request.cursor && Number.isFinite(Number(request.cursor)) ? Number(request.cursor) - OVERLAP_MS : request.sinceMs;
    const q = `after:${Math.max(0, Math.floor(from / 1000))}`;
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new AdapterError("the window has more pages than the adapter reads");
      const answer = (await gws("messages", "list", { userId: "me", q, maxResults: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) })) as { messages?: Array<{ id?: string }>; nextPageToken?: string } | null;
      for (const entry of answer?.messages ?? []) if (entry.id) ids.push(entry.id);
      pageToken = answer?.nextPageToken;
      if (!pageToken) break;
    }
    const messages: ContractMessage[] = [];
    for (const id of ids) {
      const full = (await gws("messages", "get", { userId: "me", id, format: "metadata", metadataHeaders: HEADERS })) as GmailMessage;
      messages.push(toContract(full));
    }
    messages.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    const newest = messages.length ? Date.parse(messages[messages.length - 1]!.receivedAt) : null;
    const previous = request.cursor && Number.isFinite(Number(request.cursor)) ? Number(request.cursor) : null;
    const cursor = newest === null ? request.cursor : String(previous === null ? newest : Math.max(previous, newest));
    return { messages, cursor, more: false, expired: false };
  };
}
