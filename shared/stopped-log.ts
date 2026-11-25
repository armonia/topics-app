/**
 * One entry of the channel engine's own record of turns it stopped before
 * replying, and one page of them — the shape both `server/agents/stopped-log.ts`
 * and the client's `useStoppedLog` hook agree on.
 */
export interface StoppedEntry {
  created: number;
  chat: string;
  /** The chat's channel (`discord`, `whatsapp`…) for its brand mark, when the log carries one. */
  channel: string | null;
  agent: string;
  reason: string;
}

export interface StoppedPage {
  rows: StoppedEntry[];
  total: number;
  page: number;
  pageSize: number;
}
