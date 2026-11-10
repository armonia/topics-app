/**
 * What the reader changes in the programs area, kept as one slice
 * (`ctx.slice('programs', ...)`): the programs they connected and tested,
 * the PCs they linked, updated or removed, where the agent is in its task,
 * the remote control session, what they archived from the catalogue. The
 * example data (`fixtures/programs.ts`) never changes; this lays over it.
 */
import type { RemoteStatus } from '../../../../ui/programs/model';

export interface CheckResult {
  /** HH:mm of the demo clock. */
  at: string;
  ok: boolean;
  /** Why it failed, when it did. */
  why?: string;
}

export interface AddedPc {
  id: string;
  office: string;
  os: string;
  version: string;
}

export type AgentStatus = 'live' | 'paused' | 'stopped' | 'done';

export interface AgentRun {
  /** How many steps are done, 0 to the number of steps. */
  cursor: number;
  status: AgentStatus;
  /** Why it is paused. */
  why?: 'person' | 'control' | 'manual';
  /** HH:mm each done step finished at. */
  times: string[];
  /** Which invoice of the queue it is on. */
  invoice: number;
  /** How many it has registered in this session. */
  registered: number;
  personAtPc: boolean;
}

export interface RemoteSession {
  status: RemoteStatus;
  pc: string;
  reason: string;
  /** Real time (ms) the person said yes, for the timer. */
  grantedAtMs?: number;
  /** HH:mm of the demo clock when they said yes. */
  grantedAt?: string;
  /** HH:mm of the demo clock when it was refused. */
  deniedAt?: string;
  keyboardBy: 'armonia' | 'person';
  /** HH:mm when the new password was saved. */
  passwordAt?: string;
  /** How long it lasted, in minutes, and who ended it. */
  minutes?: number;
  how?: 'closed' | 'person' | 'expired';
}

export interface ProgramsState {
  /** Programs the reader connected: id to HH:mm. */
  connected: Record<string, string>;
  checks: Record<string, CheckResult>;
  removedAgents: string[];
  addedPcs: AddedPc[];
  versions: Record<string, string>;
  agent: AgentRun;
  remote: RemoteSession;
  archived: string[];
  /** Result of an example fetch, by document id. */
  fetched: Record<string, string>;
  /** The day (YYYY-MM-DD) the agent last redid its research on a program. */
  researched: Record<string, string>;
  /** The migration advice exported for the director, by program. */
  exported: Record<string, { at: string; file: string }>;
}

export const SEED_AGENT_TIMES = ['10:27', '10:28', '10:29'];

export const INITIAL_PROGRAMS: ProgramsState = {
  connected: {},
  checks: {},
  removedAgents: [],
  addedPcs: [],
  versions: {},
  agent: { cursor: 3, status: 'live', times: SEED_AGENT_TIMES, invoice: 0, registered: 0, personAtPc: false },
  remote: { status: 'idle', pc: 'PC-PROTOCOLLO-01', reason: 'halley-password', keyboardBy: 'armonia' },
  archived: [],
  fetched: {},
  researched: {},
  exported: {},
};
