/**
 * agentActions: WHICH action each working subject is doing, held steady enough
 * for a loader to draw it.
 *
 * The raw inputs flip fast: a turn opens a Read, a Grep and an Edit inside a
 * few milliseconds, and a text reply sends dozens of chunks a second. Drawn as
 * they come, the loader would change shape on every frame and say nothing. So
 * every input passes through one rule (`dwellStep`): a shown action stays at
 * least `ACTION_DWELL_MS`, and when that time is up the LATEST input wins.
 *
 * The store only changes when the SHOWN action changes: an input equal to the
 * last one is a no-op, so a stream of `content_chunk` frames costs a map lookup
 * each and renders nothing.
 *
 * Keyed by SUBJECT id, like `sessionActivity` in `signals.ts`: topicId for
 * chats, terminal session id for terminals (two disjoint id spaces). Fed from
 * `useSignalsSync` (the server's global `stream:action` frame for chats,
 * Claude Code terminal phases); read
 * through the facade hooks in `agentActionHooks.ts` (`useTopicAction` and friends), which
 * decide WHETHER a subject works. This module only says WHAT it is doing.
 */
import { create } from 'zustand';
import { isAgentAction, type AgentAction } from '../../../shared/agent-action';
import type { AttentionTask } from '../../../shared/attention';

/** How long a shown action stays before the next one may replace it. */
export const ACTION_DWELL_MS = 700;

// ---- The dwell rule (pure) --------------------------------------------------

export interface DwellState {
  /** The action the surfaces draw. */
  shown: AgentAction;
  /** When `shown` started being shown (epoch-ms). */
  shownAt: number;
  /** The last action the input reported; it replaces `shown` once the dwell is over. */
  latest: AgentAction;
}

export interface DwellStep {
  state: DwellState;
  /** `shown` changed: publish it. */
  changed: boolean;
  /** Call `dwellSettle` at this time (epoch-ms) to let `latest` in; null when nothing waits. */
  wakeAt: number | null;
}

/**
 * One input through the dwell rule. PURE: no clock, no timer, the caller owns
 * both. Returns the SAME state object when the input changes nothing, so a
 * repeated input is free.
 */
export function dwellStep(prev: DwellState | undefined, incoming: AgentAction, now: number, dwellMs = ACTION_DWELL_MS): DwellStep {
  if (!prev) return { state: { shown: incoming, shownAt: now, latest: incoming }, changed: true, wakeAt: null };
  if (incoming === prev.latest) return { state: prev, changed: false, wakeAt: null };
  // Back to what is already shown before the dwell ran out: nothing to replace.
  if (incoming === prev.shown) return { state: { ...prev, latest: incoming }, changed: false, wakeAt: null };
  if (now - prev.shownAt >= dwellMs) {
    return { state: { shown: incoming, shownAt: now, latest: incoming }, changed: true, wakeAt: null };
  }
  return { state: { ...prev, latest: incoming }, changed: false, wakeAt: prev.shownAt + dwellMs };
}

/** The dwell ran out (the timer `dwellStep` asked for): the latest input takes over. PURE. */
export function dwellSettle(prev: DwellState, now: number, dwellMs = ACTION_DWELL_MS): DwellStep {
  if (prev.latest === prev.shown) return { state: prev, changed: false, wakeAt: null };
  if (now - prev.shownAt < dwellMs) return { state: prev, changed: false, wakeAt: prev.shownAt + dwellMs };
  return { state: { shown: prev.latest, shownAt: now, latest: prev.latest }, changed: true, wakeAt: null };
}

// ---- Rollups (pure) ----------------------------------------------------------

export interface ActionEntry {
  action: AgentAction;
  /** When this subject last changed its shown action (epoch-ms). */
  changedAt: number;
}

/**
 * The one action a group of working subjects shows: the one that changed
 * action most recently, undefined for an empty group. With `waitWins` (a
 * project folder) a subject waiting for the person makes the group wait. The
 * tray (`waitWins: false`) counts the waiting ones apart, so a wait is not a
 * move of the agents at work there: those entries are left out, and a group
 * where everyone waits has no working action.
 */
export function rollupAction(entries: Iterable<ActionEntry>, { waitWins = true }: { waitWins?: boolean } = {}): AgentAction | undefined {
  let best: ActionEntry | undefined;
  for (const e of entries) {
    if (e.action === 'wait') {
      if (waitWins) return 'wait';
      continue;
    }
    if (!best || e.changedAt > best.changedAt) best = e;
  }
  return best?.action;
}

/** The work a closed turn left running, as an action: sub-agents delegate, the rest runs. */
export function backgroundAction(tasks: readonly Pick<AttentionTask, 'kind'>[]): AgentAction {
  const work = tasks.filter((t) => t.kind !== 'wake');
  if (work.length === 0) return 'think';
  // `subagent` is a `spawn_agent` child: an agent at work like the CLI's own Agent.
  return work.some((t) => t.kind === 'agent' || t.kind === 'workflow' || t.kind === 'subagent') ? 'delegate' : 'run';
}

/**
 * The action of ONE subject, given whether it works. The facade hooks feed it;
 * keeping the precedence here keeps the tab, the row and the card in step.
 *   not in progress            → undefined (it does not work)
 *   waits for the person       → wait
 *   a turn open                → the live action, else the hook phase's, else think
 *   only a job left running    → that job (run / delegate)
 */
export function subjectActionFrom({ inProgress, turnOpen, waiting, live, fromPhase, tasks }: {
  inProgress: boolean;
  turnOpen: boolean;
  waiting: boolean;
  live?: AgentAction;
  fromPhase?: AgentAction;
  tasks: readonly Pick<AttentionTask, 'kind'>[];
}): AgentAction | undefined {
  if (!inProgress) return undefined;
  if (waiting) return 'wait';
  if (turnOpen) return live ?? fromPhase ?? 'think';
  return backgroundAction(tasks);
}

// ---- Store -------------------------------------------------------------------

interface AgentActionState {
  actions: ReadonlyMap<string, ActionEntry>;
}

export const useAgentActionStore = create<AgentActionState>(() => ({ actions: new Map() }));

/** Not reactive: the dwell bookkeeping. Only `shown` reaches the store. */
const dwell = new Map<string, DwellState>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function publish(key: string, state: DwellState | undefined): void {
  useAgentActionStore.setState((s) => {
    const next = new Map(s.actions);
    if (state) next.set(key, { action: state.shown, changedAt: state.shownAt });
    else next.delete(key);
    return { actions: next };
  });
}

function arm(key: string, wakeAt: number): void {
  if (timers.has(key)) return; // one wake per subject: it re-arms itself if still early
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    const cur = dwell.get(key);
    if (!cur) return;
    const step = dwellSettle(cur, Date.now());
    dwell.set(key, step.state);
    if (step.changed) publish(key, step.state);
    if (step.wakeAt !== null) arm(key, step.wakeAt);
  }, Math.max(0, wakeAt - Date.now())));
}

export const agentActionActions = {
  /** A subject reported an action. Cheap when it repeats the last one. */
  note(key: string, action: AgentAction, now = Date.now()): void {
    const step = dwellStep(dwell.get(key), action, now);
    if (step.state === dwell.get(key)) return;
    dwell.set(key, step.state);
    if (step.changed) publish(key, step.state);
    if (step.wakeAt !== null) arm(key, step.wakeAt);
  },
  /** The subject stopped working: it has no action, at once (no dwell on the way out). */
  clear(key: string): void {
    const t = timers.get(key);
    if (t) { clearTimeout(t); timers.delete(key); }
    if (!dwell.delete(key)) return;
    publish(key, undefined);
  },
};

/** The fields of the frames that feed a chat's action. */
export interface ActionFrameLite {
  type: string;
  topicId?: string;
  sessionKey?: string;
  action?: unknown;
  late?: boolean;
}

/**
 * Feeds the store from the socket: the server's global `stream:action` sets a
 * chat's action, `stream:end` clears it. Every other frame is ignored here, so
 * the finer `topic` frames a window may also receive never contradict it: one
 * source per chat. `topicOf` resolves a frame that names only its session.
 */
export function applyActionFrame(frame: ActionFrameLite, topicOf: (sessionKey: string) => string | undefined): void {
  if (frame.type !== 'stream:action' && frame.type !== 'stream:end') return;
  const topicId = frame.topicId || (frame.sessionKey ? topicOf(frame.sessionKey) : undefined);
  if (!topicId) return;
  if (frame.type === 'stream:end') {
    if (!frame.late) agentActionActions.clear(topicId);
    return;
  }
  if (isAgentAction(frame.action)) agentActionActions.note(topicId, frame.action);
}

/** @internal Tests only: back to the boot state. */
export function __resetAgentActions(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  dwell.clear();
  useAgentActionStore.setState({ actions: new Map() });
}
