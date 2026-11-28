/**
 * THE ADAPTER CONTRACT (rule P1): one command, JSON on stdin, JSON on stdout.
 *
 *   {"op":"list","cursor":<text|null>,"sinceMs":<epoch ms>,"limit":<n>}
 *     -> {"messages":[Message...],"cursor":<text|null>,"more":<bool>,"expired":<bool>}
 *   {"op":"read","id":"..."}  -> {"body":"..."}
 *   {"op":"draft",...}        -> {"id":"..."}   (optional)
 *
 * `expired: true` means the cursor is no longer known to the provider: the core
 * asks again with no cursor and a window start (`sinceMs`), never "from now".
 * The core calls `list` only here; `read` and `draft` belong to later tracks.
 */
import { createSpawnAdapter, type AdapterResult, type AdapterRunner } from "../../schedule/deliver/adapter";
import { withoutGatewayToken } from "../../lib/child-env";
import type { Mailbox } from "./mailboxes";

export const LIST_TIMEOUT_MS = 30_000;
export const LIST_LIMIT = 100;
const SUBJECT_MAX = 300;
const SNIPPET_MAX = 200;

export interface ContractMessage {
  id: string;
  threadId: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  authResults: string | null;
  sentAt: string | null;
  receivedAt: string;
}

export interface ListRequest { cursor: string | null; sinceMs: number; limit: number }
export interface ListResponse { messages: ContractMessage[]; cursor: string | null; more: boolean; expired: boolean }

/** One list call: the thing the core needs from an adapter, real or fake. */
export type ListAdapter = (request: ListRequest) => Promise<ListResponse>;

export class AdapterError extends Error {}

const str = (value: unknown) => (typeof value === "string" ? value : "");
const orNull = (value: unknown) => (typeof value === "string" && value ? value : null);
const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);

function messageOf(raw: unknown): ContractMessage {
  if (!raw || typeof raw !== "object") throw new AdapterError("a message is not an object");
  const item = raw as Record<string, unknown>;
  const id = str(item.id).trim();
  const from = str(item.from).trim();
  const receivedAt = str(item.receivedAt);
  if (!id) throw new AdapterError("a message has no id");
  if (!from) throw new AdapterError(`message ${id} has no sender`);
  if (!receivedAt || Number.isNaN(Date.parse(receivedAt))) throw new AdapterError(`message ${id} has no valid receivedAt`);
  return {
    id,
    threadId: orNull(item.threadId),
    messageId: orNull(item.messageId),
    inReplyTo: orNull(item.inReplyTo),
    from,
    to: Array.isArray(item.to) ? item.to.filter((entry): entry is string => typeof entry === "string") : [],
    subject: clip(str(item.subject), SUBJECT_MAX),
    snippet: clip(str(item.snippet), SNIPPET_MAX),
    authResults: orNull(item.authResults),
    sentAt: orNull(item.sentAt),
    receivedAt: new Date(receivedAt).toISOString(),
  };
}

/** Checks what an adapter wrote. Anything off is an error of the round: nothing of it is kept. */
export function parseListResponse(stdout: string): ListResponse {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new AdapterError("the adapter did not answer JSON"); }
  if (!value || typeof value !== "object") throw new AdapterError("the adapter answer is not an object");
  const body = value as Record<string, unknown>;
  const expired = body.expired === true;
  if (!Array.isArray(body.messages)) {
    if (expired) return { messages: [], cursor: null, more: false, expired };
    throw new AdapterError("the adapter answer has no messages list");
  }
  const messages = body.messages.map(messageOf);
  const cursor = body.cursor === null || body.cursor === undefined ? null : str(body.cursor) || null;
  return { messages, cursor, more: body.more === true, expired };
}

/** The adapter of a mailbox as a command: argv from the setting, the request on stdin. */
export function commandListAdapter(box: Mailbox, runner: AdapterRunner = createSpawnAdapter({ timeoutMs: LIST_TIMEOUT_MS, pipeGraceMs: 2_000 })): ListAdapter {
  return async (request) => {
    const adapter = box.adapter;
    if (!adapter) throw new AdapterError(`mailbox ${box.name} has no adapter`);
    const executable = adapter.argv[0] ?? "";
    const resolved = executable.includes("/") || executable.includes("\\") ? executable : Bun.which(executable);
    if (!resolved) throw new AdapterError(`the adapter "${executable}" was not found`);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(withoutGatewayToken(process.env))) if (typeof value === "string") env[name] = value;
    Object.assign(env, adapter.env, { TOPICS_MAILBOX: box.name });
    const result: AdapterResult = await runner({ argv: [resolved, ...adapter.argv.slice(1)], env, stdin: JSON.stringify({ op: "list", ...request }) });
    if (result.timedOut) throw new AdapterError("the adapter went over its time limit");
    if (result.exitCode !== 0) throw new AdapterError(`the adapter exited with code ${result.exitCode}`);
    return parseListResponse(result.stdout);
  };
}
