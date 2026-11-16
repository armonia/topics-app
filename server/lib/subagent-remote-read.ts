/**
 * `read_agent` on a child whose run lives on a paired node (sottoagenti-nodo,
 * trace 4): there is no local transcript to tail, only the node's own report
 * on the run (`node-client.ts#readRun`), and its comments are this child's
 * output.
 *
 * THE LOG LIVES HERE, keyed by comment id. A node's report cannot be paged by
 * itself: a paired Topics answers `since` with every comment AT or after it,
 * and «Cloud Claude» ignores `since` and stamps some comments with the time
 * of the read (`providers/claude-cloud/node.ts`), so neither a timestamp nor
 * the report's order says what the caller already has. Each read appends the
 * ids not seen yet to the child's log, and `since`/`nextOffset` index that
 * log: the same number `read_agent` already pages a local child with.
 *
 * Injected, not imported: same discipline as `subagent-remote-stop.ts`, so a
 * test hands in a fake node with no network at all.
 */
export interface RemoteChildLog {
  seen: Set<string>;
  texts: string[];
  /** The newest `createdAt` seen: a paired Topics returns less with it, the cloud ignores it. */
  lastAt?: string;
}

export function emptyRemoteChildLog(): RemoteChildLog {
  return { seen: new Set(), texts: [] };
}

export interface ReadRemoteChildInput {
  machineId: string;
  runId: string;
  /** This child's log, kept by the caller across reads. */
  log: RemoteChildLog;
  /** Index in the log from the previous read (`nextOffset`), 0 = from the start. */
  since: number;
  baseUrlOf: (machineId: string) => string | null;
  tokenOf: (machineId: string) => string | null;
  readRun: (input: { baseUrl: string; token: string; runId: string; since?: string }) => Promise<{
    comments: Array<{ id: string; content: string; createdAt: string; author?: string; kind?: string }>;
  }>;
}

export interface RemoteChildReadEvent {
  type: "assistant";
  text: string;
}

export type ReadRemoteChildResult =
  | { ok: true; events: RemoteChildReadEvent[]; nextOffset: number; source: "node" }
  | { ok: false; reason: string };

/**
 * Whether a node's card comment is the child speaking: its agent (`agent:<id>` on a paired
 * Topics, `agent` on the Claude cloud), and not a status move. Everything else is the node's
 * own bookkeeping. The one rule both the read log and the final answer use.
 */
export function isChildVoice(c: { author?: string; kind?: string }): boolean {
  return !!c.author && (c.author === "agent" || c.author.startsWith("agent:")) && c.kind !== "status";
}

/**
 * One comment the child wrote on the node's run = one assistant event here: the node's report
 * has no tool-call shape of its own, so there is nothing finer to split it
 * into. A node that cannot be reached answers `ok: false`, never a throw, so
 * the route says 502 instead of 500.
 */
export async function readRemoteChild(input: ReadRemoteChildInput): Promise<ReadRemoteChildResult> {
  const baseUrl = input.baseUrlOf(input.machineId);
  const token = input.tokenOf(input.machineId);
  if (!baseUrl || !token) return { ok: false, reason: "node address or token unavailable" };
  const { log } = input;
  let comments: Array<{ id: string; content: string; createdAt: string; author?: string; kind?: string }>;
  try {
    ({ comments } = await input.readRun({ baseUrl, token, runId: input.runId, since: log.lastAt }));
  } catch (err) {
    return { ok: false, reason: `node did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
  for (const c of comments) {
    if (log.seen.has(c.id)) continue;
    log.seen.add(c.id);
    if (!log.lastAt || c.createdAt > log.lastAt) log.lastAt = c.createdAt;
    // What the child said, not the node's own bookkeeping around it: the mirror note, status
    // moves, the verifier's preview line, and the "archived while working" note the node writes
    // when this Mac archives the run after its branch came home (16/11, read as the answer).
    // A comment with no author (an older node) is kept: better a noisy log than a lost line.
    if (c.author !== undefined && !isChildVoice(c)) continue;
    log.texts.push(c.content);
  }
  // A `since` past the end means this log was born again (the Map lives in memory and the server
  // restarted): replaying from 0 shows something twice, clamping to the end would lose it for good.
  const asked = Math.max(0, Math.trunc(input.since) || 0);
  const from = asked > log.texts.length ? 0 : asked;
  const events = log.texts.slice(from).map((text) => ({ type: "assistant" as const, text }));
  return { ok: true, events, nextOffset: log.texts.length, source: "node" };
}
