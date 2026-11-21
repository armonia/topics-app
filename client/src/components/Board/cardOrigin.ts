/**
 * WHO FOLLOWS A CARD, and WHICH CHANNEL its work came from: the one answer the
 * board's filters, its grouping and the card's origin chip all read. Before,
 * three overlapping notions answered it differently (the «mine / others»
 * toggle, the quick filters where «Agents» also counted Jarvis's cards, and
 * the «who closes» grouping), and the same card sat in two buckets at once.
 *
 * The owner is EXCLUSIVE: every card has exactly one, so the counts add up to
 * the board. In order, the first rule that applies wins:
 *   1. a schedule opened it or runs it              -> scheduled
 *   2. its assignee names an agent we know          -> that agent
 *      its assignee is the person using the app     -> me
 *   3. it came from an agent's chat or channel      -> that agent
 *   4. a person opened it from the interface        -> me
 *   5. a named agent opened it (`agent:<name>`)     -> that agent
 *   6. a chat session opened it                     -> session
 *   7. anything else (scripts, the coordinator's
 *      cards for the board's own agents)            -> board
 *
 * Pure: the person's name comes in from the caller (`useOwnerName`).
 */
import { splitCreatedBy } from '../../../../shared/created-by';
import { MAIN_AGENT, agentIdOfName, agentName } from '../../../../shared/agent-home';
import type { BoardTask } from '../../lib/board';

export type OwnerKind = 'me' | 'board' | 'agent' | 'session' | 'scheduled';

/** `me`, `board`, `session`, `scheduled`, or `agent:<id>`. */
export type OwnerKey = string;

export interface CardOwner {
  kind: OwnerKind;
  key: OwnerKey;
  /** The agent id (`jarvis`, `gtm`), only for `agent`. */
  agentId?: string;
}

/** Callers that open cards on behalf of a chat session, not as an agent of their own. */
const SESSION_CALLERS = new Set(['session', 'coordinator']);
/** A caller that names nobody (`agent:api`): a script, not an agent. */
const UNNAMED_CALLERS = new Set(['api']);

const ME: CardOwner = { kind: 'me', key: 'me' };
const BOARD: CardOwner = { kind: 'board', key: 'board' };
const SESSION: CardOwner = { kind: 'session', key: 'session' };
const SCHEDULED: CardOwner = { kind: 'scheduled', key: 'scheduled' };
const agent = (id: string): CardOwner => ({ kind: 'agent', key: `agent:${id}`, agentId: id });

export type OwnerTask = Pick<BoardTask, 'createdBy' | 'scheduled' | 'assignedTo' | 'channel' | 'openerAgent' | 'openerTopicId'>;

/** The assignee names the person: their full name or their first name. */
function isPerson(assignee: string, personName: string | null): boolean {
  const a = assignee.trim().toLowerCase();
  const p = personName?.trim().toLowerCase();
  if (!a || !p) return false;
  return a === p || p.split(/\s+/)[0] === a;
}

export function cardOwner(task: OwnerTask, personName: string | null): CardOwner {
  const by = splitCreatedBy(task.createdBy);
  if (by?.kind === 'cron' || task.scheduled) return SCHEDULED;
  const assignee = task.assignedTo?.trim() ?? '';
  const assignedAgent = agentIdOfName(assignee);
  if (assignedAgent) return agent(assignedAgent);
  if (isPerson(assignee, personName)) return ME;
  // A channel chat is an always-on agent's by definition, even when its folder says nothing.
  const fromChat = task.channel?.agent ?? task.openerAgent ?? (task.channel?.topicId ? MAIN_AGENT : null);
  if (fromChat) return agent(fromChat);
  if (by?.kind === 'human') return ME;
  if (by?.kind === 'agent' && by.name && !SESSION_CALLERS.has(by.name) && !UNNAMED_CALLERS.has(by.name)) {
    return agent(agentIdOfName(by.name) ?? by.name);
  }
  if ((by?.kind === 'agent' && by.name && SESSION_CALLERS.has(by.name)) || task.openerTopicId) return SESSION;
  return BOARD;
}

const KIND_ORDER: Record<OwnerKind, number> = { me: 0, board: 1, agent: 2, session: 3, scheduled: 4 };

/** The display order of owners: you, the board's agents, the always-on agents (the main one first), sessions, schedules. */
export function compareOwnerKeys(a: OwnerKey, b: OwnerKey): number {
  const ka = ownerKindOfKey(a), kb = ownerKindOfKey(b);
  if (ka !== kb) return KIND_ORDER[ka] - KIND_ORDER[kb];
  if (ka !== 'agent') return 0;
  const ia = a.slice('agent:'.length), ib = b.slice('agent:'.length);
  if (ia === MAIN_AGENT || ib === MAIN_AGENT) return ia === MAIN_AGENT ? -1 : 1;
  return agentName(ia).localeCompare(agentName(ib));
}

export function ownerKindOfKey(key: OwnerKey): OwnerKind {
  return key.startsWith('agent:') ? 'agent' : (key as OwnerKind);
}

/** One count per owner present on the given cards, in display order. */
export function countOwners(tasks: readonly OwnerTask[], personName: string | null): Array<{ key: OwnerKey; count: number }> {
  const counts = new Map<OwnerKey, number>();
  for (const t of tasks) {
    const k = cardOwner(t, personName).key;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => ({ key, count })).sort((x, y) => compareOwnerKeys(x.key, y.key));
}

// ── Channel ──────────────────────────────────────────────────────────────────

/** Separates the levels of a channel path inside one filter value. */
export const CHANNEL_SEPARATOR = '\u001f';
/** The filter value for «cards with no channel». */
export const NO_CHANNEL = '_none';

/** The channel a card came from as a path: kind, then server, channel and thread when known. */
export function channelPath(task: Pick<BoardTask, 'channel'>): string[] | null {
  const ch = task.channel;
  if (!ch?.topicId) return null;
  const place = ch.place;
  const levels = [place?.server, place?.channel, place?.thread].map((s) => s?.trim()).filter((s): s is string => !!s);
  return [ch.kind, ...(levels.length ? levels : [ch.name.trim() || ch.kind])];
}

/** Does the card's channel sit under any of the selected paths? An empty selection lets everything through. */
export function matchesChannels(task: Pick<BoardTask, 'channel'>, selected: readonly string[]): boolean {
  if (!selected.length) return true;
  const path = channelPath(task);
  if (!path) return selected.includes(NO_CHANNEL);
  return selected.some((sel) => {
    if (sel === NO_CHANNEL) return false;
    const parts = sel.split(CHANNEL_SEPARATOR);
    return parts.length <= path.length && parts.every((p, i) => p === path[i]);
  });
}

export interface ChannelNode {
  /** The value to filter by: the levels from the kind down to this one. */
  value: string;
  /** This level's own text (the kind for the first level). */
  label: string;
  depth: number;
  count: number;
  children: ChannelNode[];
}

/** The channels on the given cards as a tree (kind > server > channel > thread), with counts. */
export function channelTree(tasks: readonly Pick<BoardTask, 'channel'>[]): ChannelNode[] {
  const root: ChannelNode = { value: '', label: '', depth: -1, count: 0, children: [] };
  for (const t of tasks) {
    const path = channelPath(t);
    if (!path) continue;
    let node = root;
    path.forEach((label, depth) => {
      const value = path.slice(0, depth + 1).join(CHANNEL_SEPARATOR);
      let child = node.children.find((c) => c.value === value);
      if (!child) { child = { value, label, depth, count: 0, children: [] }; node.children.push(child); }
      child.count += 1;
      node = child;
    });
  }
  const sort = (nodes: ChannelNode[]) => { nodes.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)); nodes.forEach((n) => sort(n.children)); };
  sort(root.children);
  return root.children;
}
