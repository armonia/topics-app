/**
 * What a session costs, as it travels from the server to every surface that
 * shows it: the load screen of the PC (`/schermo/<id>`), the machine's
 * Processes view and the card drawer. ONE shape, so the three show the same
 * numbers because they read the same answer.
 *
 * A "session" here is the unit a person recognises: a card of the board (with
 * the sessions its coordinator spawned folded into it), a chat, or a terminal.
 * Every process Topics launched for it is billed to it; a process several
 * sessions use at once (the server, a bridge) is split between them and the
 * row says how (`shares`).
 *
 * `null` always means NOT MEASURED, never zero: a session whose tokens the
 * server could not read shows a dash, not "0 tokens".
 */

export type SessionKind = 'card' | 'chat' | 'terminal';

/** `working`: producing or running something now. `waiting`: parked on a person's answer. */
export type ConsumptionState = 'working' | 'waiting';

export interface ConsumptionTokens {
  /** `null` where the source only knows a total (a card read from the board's counter). */
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** input + output + cache written: the same "work tokens" the board's chip counts. */
  total: number;
  /** Where the figures come from: the native runtime's registry, the transcripts, or the card's own counter. */
  source: 'native' | 'transcript' | 'card';
}

/** A program (or group of same-named processes) inside a session: the detail, never the main list. */
export interface ConsumptionProc {
  name: string;
  count: number;
  memMB: number;
  /** % of the whole machine, as `fleet.sessions[].cpuPercent`; null = not measured yet. */
  cpuPct: number | null;
}

/** A process the session shares with others, and its slice: `1/of` of `mb`. */
export interface ConsumptionShare {
  /** `server`, `pty-bridge`, `ai-bridge` or `webrtc-bridge`. */
  id: string;
  /** The whole shared process, before the split. */
  totalMB: number;
  /** How many sessions use it. This session's slice is `totalMB / of`. */
  of: number;
  /** This session's slice, in MB. */
  mb: number;
  cpuPct: number | null;
}

/** Work this session sent to another machine (a test suite on the PC) and the slice of that machine it is billed. */
export interface ConsumptionRemote {
  what: string;
  /** The machine it runs on, by the name its row has; null when it did not say. */
  where: string | null;
  who: string | null;
  since: number | null;
  /** How many sessions or jobs divide the machine's load of sent work. */
  of: number;
  memMB: number | null;
  cpuPct: number | null;
}

export interface SessionConsumption {
  /** `card:<task id>` for a card, else the session key or the terminal id. */
  key: string;
  kind: SessionKind;
  /** The card's title or the chat's name, never an id. */
  title: string;
  project: string | null;
  /** The model id as the board stores it; null when the session does not name one. */
  model: string | null;
  state: ConsumptionState;
  /** When it started, epoch ms: the clock runs on the surface, from this. */
  startedAt: number | null;
  /** The card id when the session is a card, to open it. */
  cardId: string | null;
  /** The machine it runs on when it is not this one; null = this machine. */
  machine: string | null;
  tokens: ConsumptionTokens | null;
  /** Output tokens per second over the answer's window; null = not measurable (no output counter, or too early). */
  tps: number | null;
  /** Own processes plus the slices of shared ones; null for a session that runs on another machine (nothing measured here). */
  memMB: number | null;
  cpuPct: number | null;
  /** The part of `memMB` that is this session's alone. */
  ownMB: number | null;
  shares: ConsumptionShare[];
  /** The heaviest programs inside it. */
  procs: ConsumptionProc[];
  remote: ConsumptionRemote[];
  /** Waiting for a person (the "waiting for you" chip). */
  awaiting: boolean;
  /** Who sent the run here, when it came from another device. */
  from: string | null;
}

/** A job the Mac sent to another machine, as that machine listed it. */
export interface SentJob {
  /** The sender's label for the project, for people. */
  project: string | null;
  /** The folder of the checkout the job was sent from: the id that places it on a session. */
  repo: string | null;
  what: string;
  who: string | null;
  since: number | null;
}

/**
 * The work sent to the machine a screen watches, in the SAME reading the sessions
 * come from: `jobs` is all of it, `unplaced` the part no live session carries.
 * One snapshot, so a job is never at once «sent» and «placed in a session».
 */
export interface ConsumptionSent { jobs: SentJob[]; unplaced: SentJob[] }

export interface ConsumptionAnswer {
  at: number;
  /** The window `tps` is averaged over, in seconds. */
  windowS: number;
  /** The split rule, in a word, so a surface can print it: `equal` = 1/N among the sessions that use the process. */
  rule: 'equal';
  sessions: SessionConsumption[];
  /** The work sent to the watched machine; null when the answer is not about another machine. */
  sent: ConsumptionSent | null;
  /** Topics' processes no session owns or uses (a dev server, a bridge nobody is on): never folded into a session. */
  unattributed: { memMB: number; cpuPct: number | null; processes: number };
  /** Sessions alive here with nothing running (a chat left open): their memory is theirs, counted here and not shared out. */
  idle: { sessions: number; memMB: number };
}
