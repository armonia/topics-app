/**
 * AGENT SESSIONS: the chats the always-on agents (Jarvis, Visione and the
 * other OpenClaw agents) run on their own, from Discord, WhatsApp and their
 * scheduled jobs.
 *
 * They live in the agents' home folders, not in a project you work on, so the
 * sidebar does not list those folders as projects: the «Agenti» row opens a
 * view that groups the sessions by agent instead.
 *
 * THE CRITERION LIVES HERE AND NOWHERE ELSE: a session is an agent's when its
 * folder is an agent home (`AGENT_HOMES`). The agent is read from the folder:
 * `workspace-<id>` is agent `<id>`, the home itself and `workspace` are the
 * main agent. A new OpenClaw agent shows up on its own, with its id as name,
 * until `AGENT_NAMES` gives it a friendlier one.
 */
import type { Topic } from '../types';

/** The agent homes, as path suffixes: `~/.openclaw` and Jarvis' home. */
const AGENT_HOMES = ['/.openclaw', '/.claude/jarvis/home'] as const;

/** The main agent, the one that answers in the home itself. */
export const MAIN_AGENT = 'jarvis';

/** Friendly names of the agents we know; any other shows its folder id. */
const AGENT_NAMES: Record<string, string> = {
  jarvis: 'Jarvis',
  gtm: 'Visione', // allow-italian: the agent's own name, not UI copy
};

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * The agent that owns a folder, or null when the folder is not an agent's.
 * `~/.openclaw` and `~/.openclaw/workspace` are the main agent,
 * `~/.openclaw/workspace-gtm/…` is `gtm`.
 */
export function agentOfPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const p = norm(path);
  for (const home of AGENT_HOMES) {
    const at = p.indexOf(home);
    if (at < 0) continue;
    const rest = p.slice(at + home.length);
    if (rest !== '' && !rest.startsWith('/')) continue;
    const first = rest.split('/')[1] ?? '';
    const m = /^workspace-(.+)$/.exec(first);
    return m ? m[1] : MAIN_AGENT;
  }
  return null;
}

export function isAgentPath(path: string | null | undefined): boolean {
  return agentOfPath(path) !== null;
}

export function agentName(id: string): string {
  return AGENT_NAMES[id] ?? id;
}

/**
 * A readable name for an agent's chat. The bridge names a channel's chat after
 * its raw id («Gruppo 1564…», «WhatsApp, gruppo 1203…@g.us»): with the title
 * jarvis-channels knows for that id, the chat takes the channel's name. The
 * terminal chat («cli») gets a name in words, through `cliLabel`.
 */
export function agentSessionName(name: string, titles: Readonly<Record<string, string>>, cliLabel: string): string {
  const raw = /^(?:WhatsApp, )?gruppo ([\w.@-]+)$/i.exec(name.trim()); // allow-italian: the bridge's own chat names
  if (raw) return titles[raw[1]] ?? name;
  if (/^(?:WhatsApp, )?cli$/i.test(name.trim())) return cliLabel;
  return name;
}

/** A chat whose last message is a provider failure («API 400…», «⚠ …»). */
export function isErrorText(text: string | undefined): boolean {
  return !!text && /^\s*(?:⚠|API (?:Error|\d{3}))/.test(text);
}

export type AgentSessionState = 'working' | 'waiting' | 'idle';

export interface AgentSession {
  topic: Topic;
  state: AgentSessionState;
  lastActivity: number;
  /** Its last turn failed. */
  error: boolean;
  /** Sub-agents this session spawned, nested under it. */
  children: AgentSession[];
}

export interface AgentGroup {
  id: string;
  name: string;
  sessions: AgentSession[];
  /** Every session, sub-agents included. */
  total: number;
  working: number;
  waiting: number;
  errors: number;
  lastActivity: number;
  /** The loudest state among its sessions. */
  state: AgentSessionState;
}

const RANK: Record<AgentSessionState, number> = { waiting: 2, working: 1, idle: 0 };

function stamp(t: Topic): number {
  const v = Date.parse(t.updatedAt || t.createdAt);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Groups the agents' sessions by agent. `working` and `waiting` are the topic
 * ids the live signals see at work and waiting on you. Archived sessions stay
 * out. Groups with someone waiting or working come first, then by last
 * activity; the main agent leads ties.
 */
export function groupAgentSessions(
  topics: Record<string, Topic>,
  working: ReadonlySet<string>,
  waiting: ReadonlySet<string>,
  errored: ReadonlySet<string> = new Set(),
): AgentGroup[] {
  const agentIds = agentTopicIds(topics);
  const own = Object.values(topics).filter((t) => !t.archived && agentIds.has(t.id));
  const byKey = new Map(own.map((t) => [t.sessionKey, t]));
  const node = (t: Topic): AgentSession => ({
    topic: t,
    state: waiting.has(t.id) ? 'waiting' : working.has(t.id) ? 'working' : 'idle',
    lastActivity: stamp(t),
    error: errored.has(t.id),
    children: [],
  });
  const nodes = new Map(own.map((t) => [t.id, node(t)]));
  const groups = new Map<string, AgentGroup>();
  const groupOf = (id: string): AgentGroup => {
    let g = groups.get(id);
    if (!g) {
      g = { id, name: agentName(id), sessions: [], total: 0, working: 0, waiting: 0, errors: 0, lastActivity: 0, state: 'idle' };
      groups.set(id, g);
    }
    return g;
  };
  for (const t of own) {
    const n = nodes.get(t.id)!;
    const parent = t.subagentOf && t.subagentOf !== t.sessionKey ? byKey.get(t.subagentOf) : undefined;
    const agent = agentOfPath(parent?.projectPath) ?? agentOfPath(t.projectPath) ?? MAIN_AGENT;
    if (parent) nodes.get(parent.id)!.children.push(n);
    else groupOf(agent).sessions.push(n);
    const g = groupOf(agent);
    g.total++;
    if (n.state === 'working') g.working++;
    if (n.state === 'waiting') g.waiting++;
    if (n.error) g.errors++;
    g.lastActivity = Math.max(g.lastActivity, n.lastActivity);
    if (RANK[n.state] > RANK[g.state]) g.state = n.state;
  }
  const order = (a: AgentSession, b: AgentSession) => RANK[b.state] - RANK[a.state] || b.lastActivity - a.lastActivity;
  for (const g of groups.values()) {
    g.sessions.sort(order);
    for (const s of g.sessions) s.children.sort(order);
  }
  return [...groups.values()].sort((a, b) =>
    RANK[b.state] - RANK[a.state]
    || (a.id === MAIN_AGENT ? -1 : b.id === MAIN_AGENT ? 1 : 0)
    || b.lastActivity - a.lastActivity);
}

/** The tail of the row: sessions at work and sessions waiting on you, across agents. */
export function agentTotals(groups: AgentGroup[]): { working: number; waiting: number } {
  let working = 0;
  let waiting = 0;
  for (const g of groups) { working += g.working; waiting += g.waiting; }
  return { working, waiting };
}

/**
 * Is this topic an agent's session? Its own folder says so, or the folder of
 * the chat that spawned it (a sub-agent may work elsewhere). The sidebar's
 * normal list leaves these out: they are reached from «Agenti» only.
 */
export function agentTopicIds(topics: Record<string, Topic>): Set<string> {
  const byKey = new Map<string, Topic>();
  for (const t of Object.values(topics)) if (t.sessionKey) byKey.set(t.sessionKey, t);
  const ids = new Set<string>();
  for (const t of Object.values(topics)) {
    const parent = t.subagentOf ? byKey.get(t.subagentOf) : undefined;
    if (isAgentPath(t.projectPath) || isAgentPath(parent?.projectPath)) ids.add(t.id);
  }
  return ids;
}
