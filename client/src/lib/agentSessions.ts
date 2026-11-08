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
import type { TerminalSessionInfo, Topic } from '../types';

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

/** What the grouping reads of a terminal: the roster's fields, nothing more. */
export type AgentTerminalInput = Pick<TerminalSessionInfo, 'id' | 'name' | 'createdAt' | 'type' | 'parentSessionKey'>;

/**
 * A sub-agent an agent session runs in a terminal (the CLI, when `spawn_agent`
 * cannot place it on the Topics engine). It sits under the chat that opened
 * it, like a chat sub-agent, and opens as a terminal pane.
 */
export interface AgentTerminal {
  terminal: AgentTerminalInput;
  state: AgentSessionState;
  lastActivity: number;
  /** Sub-agents this terminal spawned in turn. */
  children: AgentTerminal[];
}

export interface AgentSession {
  topic: Topic;
  state: AgentSessionState;
  lastActivity: number;
  /** Its last turn failed. */
  error: boolean;
  /** Sub-agents this session spawned, nested under it. */
  children: AgentSession[];
  /** Sub-agents this session runs in a terminal. */
  terminals: AgentTerminal[];
}

export interface AgentGroup {
  id: string;
  name: string;
  sessions: AgentSession[];
  /** Terminal sub-agents whose chat is not listed (archived): still reachable. */
  terminals: AgentTerminal[];
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

function terminalStamp(t: AgentTerminalInput): number {
  const v = Date.parse(t.createdAt);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Groups the agents' sessions by agent. `working` and `waiting` are the topic
 * and terminal ids the live signals see at work and waiting on you. Archived
 * sessions stay out. Terminal sub-agents sit under the chat that opened them.
 * Groups with someone waiting or working come first, then by last activity;
 * the main agent leads ties.
 */
export function groupAgentSessions(
  topics: Record<string, Topic>,
  working: ReadonlySet<string>,
  waiting: ReadonlySet<string>,
  errored: ReadonlySet<string> = new Set(),
  terminals: ReadonlyArray<AgentTerminalInput> = [],
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
    terminals: [],
  });
  const nodes = new Map(own.map((t) => [t.id, node(t)]));
  const groups = new Map<string, AgentGroup>();
  const groupOf = (id: string): AgentGroup => {
    let g = groups.get(id);
    if (!g) {
      g = { id, name: agentName(id), sessions: [], terminals: [], total: 0, working: 0, waiting: 0, errors: 0, lastActivity: 0, state: 'idle' };
      groups.set(id, g);
    }
    return g;
  };
  const count = (g: AgentGroup, state: AgentSessionState, at: number) => {
    g.total++;
    if (state === 'working') g.working++;
    if (state === 'waiting') g.waiting++;
    g.lastActivity = Math.max(g.lastActivity, at);
    if (RANK[state] > RANK[g.state]) g.state = state;
  };
  for (const t of own) {
    const n = nodes.get(t.id)!;
    const parent = t.subagentOf && t.subagentOf !== t.sessionKey ? byKey.get(t.subagentOf) : undefined;
    const agent = agentOfPath(parent?.projectPath) ?? agentOfPath(t.projectPath) ?? MAIN_AGENT;
    if (parent) nodes.get(parent.id)!.children.push(n);
    else groupOf(agent).sessions.push(n);
    count(groupOf(agent), n.state, n.lastActivity);
    if (n.error) groupOf(agent).errors++;
  }
  // Terminal sub-agents: under the chat that opened them, or under the
  // terminal that did (its key is its id); a chat no longer listed leaves them
  // at the top of the parent's agent, so they stay reachable.
  const agentTerms = agentTerminalIds(topics, terminals);
  const allByKey = new Map<string, Topic>();
  for (const t of Object.values(topics)) if (t.sessionKey) allByKey.set(t.sessionKey, t);
  const termNodes = new Map<string, AgentTerminal>();
  for (const t of terminals) {
    if (!agentTerms.has(t.id)) continue;
    termNodes.set(t.id, {
      terminal: t,
      state: waiting.has(t.id) ? 'waiting' : working.has(t.id) ? 'working' : 'idle',
      lastActivity: terminalStamp(t),
      children: [],
    });
  }
  const termById = new Map(terminals.map((t) => [t.id, t]));
  /** The agent chat a terminal hangs from, through its terminal ancestors. */
  const rootTopicOf = (t: AgentTerminalInput): Topic | undefined => {
    let cur: AgentTerminalInput | undefined = t;
    for (let hops = 0; cur && hops < 8; hops++) {
      const key: string | null | undefined = cur.parentSessionKey;
      if (!key) return undefined;
      const topic = allByKey.get(key);
      if (topic) return topic;
      cur = termById.get(key);
    }
    return undefined;
  };
  for (const n of termNodes.values()) {
    const key = n.terminal.parentSessionKey!;
    const parentTerm = termNodes.get(key);
    const chat = allByKey.get(key);
    const root = rootTopicOf(n.terminal);
    const agent = agentOfPath(root?.projectPath) ?? MAIN_AGENT;
    if (parentTerm && parentTerm !== n) parentTerm.children.push(n);
    else if (chat && nodes.has(chat.id)) nodes.get(chat.id)!.terminals.push(n);
    else groupOf(agent).terminals.push(n);
    count(groupOf(agent), n.state, n.lastActivity);
  }
  // A session ranks by its loudest descendant: a chat whose terminal is at
  // work stays in sight above the fold, not under «show more».
  const loud = new Map<AgentSession, [number, number]>();
  const termLoud = (t: AgentTerminal): [number, number] => t.children.map(termLoud).reduce(
    ([r, at], [cr, cat]) => [Math.max(r, cr), Math.max(at, cat)], [RANK[t.state], t.lastActivity] as [number, number]);
  const loudOf = (s: AgentSession): [number, number] => {
    let v = loud.get(s);
    if (!v) {
      v = [...s.children.map(loudOf), ...s.terminals.map(termLoud)].reduce(
        ([r, at], [cr, cat]) => [Math.max(r, cr), Math.max(at, cat)], [RANK[s.state], s.lastActivity] as [number, number]);
      loud.set(s, v);
    }
    return v;
  };
  const order = (a: AgentSession, b: AgentSession) => loudOf(b)[0] - loudOf(a)[0] || loudOf(b)[1] - loudOf(a)[1];
  const termOrder = (a: AgentTerminal, b: AgentTerminal) => RANK[b.state] - RANK[a.state] || b.lastActivity - a.lastActivity;
  const sortTerms = (list: AgentTerminal[]) => { list.sort(termOrder); for (const t of list) sortTerms(t.children); };
  const sortSessions = (list: AgentSession[]) => {
    list.sort(order);
    for (const s of list) { sortSessions(s.children); sortTerms(s.terminals); }
  };
  for (const g of groups.values()) {
    sortSessions(g.sessions);
    sortTerms(g.terminals);
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

/**
 * The terminals that belong to an agent: sub-agents a chat of an agent opened
 * in a terminal (the CLI), and the ones those terminals opened in turn. The
 * sidebar's normal list leaves them out with their chat: without it they had
 * no parent row there and showed as loose children of the home folder.
 */
export function agentTerminalIds(topics: Record<string, Topic>, terminals: ReadonlyArray<Pick<TerminalSessionInfo, 'id' | 'parentSessionKey'>>): Set<string> {
  const out = new Set<string>();
  if (terminals.length === 0) return out;
  const keys = new Set<string>();
  for (const id of agentTopicIds(topics)) {
    const k = topics[id]?.sessionKey;
    if (k) keys.add(k);
  }
  if (keys.size === 0) return out;
  // A terminal's own key is its id: walk the chains until nothing new joins.
  for (let grew = true; grew;) {
    grew = false;
    for (const t of terminals) {
      if (out.has(t.id) || !t.parentSessionKey) continue;
      if (keys.has(t.parentSessionKey) || out.has(t.parentSessionKey)) { out.add(t.id); grew = true; }
    }
  }
  return out;
}
