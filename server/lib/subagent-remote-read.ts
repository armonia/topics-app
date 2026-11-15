/**
 * `read_agent` on a child whose run lives on a paired node (sottoagenti-nodo,
 * trace 4): there is no local transcript to tail, only the node's own report
 * on the run (`node-client.ts#readRun`), and its comments are this child's
 * output.
 *
 * Injected, not imported: same discipline as `subagent-remote-stop.ts`, so a
 * test hands in a fake node with no network at all.
 */
export interface ReadRemoteChildInput {
  machineId: string;
  runId: string;
  /** Cursor from the previous read (`nextOffset`), `undefined` = from the start. */
  since?: string;
  baseUrlOf: (machineId: string) => string | null;
  tokenOf: (machineId: string) => string | null;
  readRun: (input: { baseUrl: string; token: string; runId: string; since?: string }) => Promise<{
    comments: Array<{ id: string; content: string; createdAt: string }>;
  }>;
}

export interface RemoteChildReadEvent {
  type: "assistant";
  text: string;
}

export type ReadRemoteChildResult =
  | { ok: true; events: RemoteChildReadEvent[]; nextOffset: string; source: "node" }
  | { ok: false; reason: string };

/**
 * The cursor is the last comment's `createdAt` plus the ids already seen AT
 * that instant, as `<createdAt>|<id>,<id>`. The node answers `since` with the
 * comments created at or after it (`node-client.ts#readRun`), and comments
 * have no sequence number: without the ids, the last comment and any other
 * with the same timestamp came back at every read.
 */
function parseCursor(raw: string | undefined): { at?: string; seen: Set<string> } {
  if (!raw) return { seen: new Set() };
  const bar = raw.indexOf("|");
  if (bar < 0) return { at: raw, seen: new Set() };
  return { at: raw.slice(0, bar) || undefined, seen: new Set(raw.slice(bar + 1).split(",").filter(Boolean)) };
}

/**
 * One comment on the node's run = one assistant event here: the node's report
 * has no tool-call shape of its own, so there is nothing finer to split it
 * into. A node that cannot be reached answers `ok: false`, never a throw, so
 * the route says 502 instead of 500.
 */
export async function readRemoteChild(input: ReadRemoteChildInput): Promise<ReadRemoteChildResult> {
  const baseUrl = input.baseUrlOf(input.machineId);
  const token = input.tokenOf(input.machineId);
  if (!baseUrl || !token) return { ok: false, reason: "node address or token unavailable" };
  const cursor = parseCursor(input.since);
  let comments: Array<{ id: string; content: string; createdAt: string }>;
  try {
    ({ comments } = await input.readRun({ baseUrl, token, runId: input.runId, since: cursor.at }));
  } catch (err) {
    return { ok: false, reason: `node did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
  const fresh = comments.filter((c) => !(c.createdAt === cursor.at && cursor.seen.has(c.id)));
  const events = fresh.map((c) => ({ type: "assistant" as const, text: c.content }));
  const last = fresh.at(-1);
  if (!last) return { ok: true, events, nextOffset: input.since ?? "", source: "node" };
  const sameInstant = comments.filter((c) => c.createdAt === last.createdAt).map((c) => c.id);
  const carried = last.createdAt === cursor.at ? [...cursor.seen, ...sameInstant] : sameInstant;
  return { ok: true, events, nextOffset: `${last.createdAt}|${[...new Set(carried)].join(",")}`, source: "node" };
}
