/**
 * `read_agent` on a child whose run lives on a paired node (sottoagenti-nodo,
 * trace 4): there is no local transcript to tail, only the node's own report
 * on the run (`node-client.ts#readRun`) — its comments are this child's
 * output.
 *
 * Injected, not imported: same discipline as `subagent-remote-stop.ts`, so a
 * test hands in a fake node with no network at all.
 */
export interface ReadRemoteChildInput {
  machineId: string;
  runId: string;
  /** Cursor from the previous read (a comment `createdAt`), `undefined` = from the start. */
  since?: string;
  baseUrlOf: (machineId: string) => string | null;
  tokenOf: (machineId: string) => string | null;
  readRun: (input: { baseUrl: string; token: string; runId: string; since?: string }) => Promise<{
    comments: Array<{ content: string; createdAt: string }>;
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
 * One comment on the node's run = one assistant event here: the node's report
 * has no tool-call shape of its own, so there is nothing finer to split it
 * into. `nextOffset` is the last comment's `createdAt`, the cursor the next
 * call sends back as `since`.
 */
export async function readRemoteChild(input: ReadRemoteChildInput): Promise<ReadRemoteChildResult> {
  const baseUrl = input.baseUrlOf(input.machineId);
  const token = input.tokenOf(input.machineId);
  if (!baseUrl || !token) return { ok: false, reason: "node address or token unavailable" };
  const report = await input.readRun({ baseUrl, token, runId: input.runId, since: input.since });
  const events = report.comments.map((c) => ({ type: "assistant" as const, text: c.content }));
  const nextOffset = report.comments.at(-1)?.createdAt ?? input.since ?? "";
  return { ok: true, events, nextOffset, source: "node" };
}
