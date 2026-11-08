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

export type AgentSessionState = 'working' | 'waiting' | 'idle';

export interface AgentSession {
  topic: Topic;
  state: AgentSessionState;
  lastActivity: number;
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
): AgentGroup[] {
  const own = Object.values(topics).filter((t) => !t.archived && agentOfPath(t.projectPath) !== null);
  const byKey = new Map(own.map((t) => [t.sessionKey, t]));
  const node = (t: Topic): AgentSession => ({
    topic: t,
    state: waiting.has(t.id) ? 'waiting' : working.has(t.id) ? 'working' : 'idle',
    lastActivity: stamp(t),
    children: [],
  });
  const nodes = new Map(own.map((t) => [t.id, node(t)]));
  const groups = new Map<string, AgentGroup>();
  const groupOf = (id: string): AgentGroup => {
    let g = groups.get(id);
    if (!g) {
      g = { id, name: agentName(id), sessions: [], total: 0, working: 0, waiting: 0, lastActivity: 0, state: 'idle' };
      groups.set(id, g);
    }
    return g;
  };
  for (const t of own) {
    const n = nodes.get(t.id)!;
    const parent = t.subagentOf && t.subagentOf !== t.sessionKey ? byKey.get(t.subagentOf) : undefined;
    if (parent) nodes.get(parent.id)!.children.push(n);
    else groupOf(agentOfPath(t.projectPath)!).sessions.push(n);
    const g = groupOf(agentOfPath(parent?.projectPath ?? t.projectPath)!);
    g.total++;
    if (n.state === 'working') g.working++;
    if (n.state === 'waiting') g.waiting++;
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

/** How many agents have at least one session at work: the tail of the row. */
export function workingAgentCount(groups: AgentGroup[]): number {
  return groups.filter((g) => g.working > 0).length;
}
