/**
 * WHAT THE HUB SEES RUNNING OUTSIDE TOPICS (hub-smistamento, HUBBR-13).
 *
 * The hub scans every agent on the Mac, whatever started it: Claude Code in a
 * terminal or in the desktop app, Codex, Muse, jcode, the sub-agents of a
 * Claude session and the agents of a workflow. Two of its answers say it:
 *
 * - `/api/board`'s `work`: one row per job, already worded by the hub (its
 *   title, its project and the project's icon, a waiting-on-a-command state for a
 *   session silent on a live command, a live workflow as one row with its
 *   agents counted and its tokens summed, and why a held job is paused);
 * - `/api/live`'s agents per project: who runs it (provider, harness, model),
 *   its share of the week, and whether the hub found it in a Topics tab.
 *
 * A session the hub found in a Topics tab is already a Topics row of the
 * level, so it is left out here: the level never names the same work twice.
 *
 * Pure reads: no fetch, no React. The view formats every word.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The hub's wire words for an agent it found in a Topics tab, and for a paused job. */
const IN_TOPICS = 'tab Topics'; // allow-italian: the hub's wire value
const PAUSED = 'in pausa'; // allow-italian: the hub's wire value
const RUNNING = 'in corso'; // allow-italian: the hub's wire value
const ON_COMMAND = 'aspetta un comando'; // allow-italian: the hub's wire value

export type HubAgentKind = 'session' | 'subagent' | 'workflow';

export interface HubAgentRow {
  key: string;
  kind: HubAgentKind;
  /** The hub's own title for it, or '' when it has none worth showing. */
  title: string;
  project: string | null;
  /** The hub's path of the project's icon (`/api/project-icon?name=`), under its own `/api/`. */
  icon: string | null;
  /** Who runs it: Claude, Codex, Muse, Jarvis, jcode. */
  runner: string | null;
  model: string | null;
  startedAt: number | null;
  tokens: number | null;
  /** Its share of the week, in percent, as the hub weighs it. */
  weekPct: number | null;
  /** How many agents a live workflow runs. */
  agents: number | null;
  /** A session silent on a live command: it works, and waits on that command. */
  onCommand: boolean;
  /** The hub's run id of a live workflow (`wf_...`). */
  runId: string | null;
}

export interface HubPause {
  /** The hub's reason, its words: «Claude frenato», «fermi a mano», «budget finito». */
  why: string;
  until: number | null;
}

export interface HubWork {
  sessions: HubAgentRow[];
  subagents: HubAgentRow[];
  workflows: HubAgentRow[];
  /** Why the hub holds a queued job, by the queue's id. */
  paused: Map<string, HubPause>;
  /** The icon of a project by any of its names (name, title, display). */
  icons: Map<string, string>;
}

interface LiveAgent {
  id: string;
  provider: string | null;
  harness: string | null;
  model: string | null;
  inTopics: boolean;
  weekPct: number | null;
  workflow: string | null;
}

const RUNNERS: Record<string, string> = { claude: 'Claude', codex: 'Codex', muse: 'Muse', jarvis: 'Jarvis', jcode: 'jcode' };

/** The agents of the hub's `/api/live`, by the id its board gives the same agent. */
function liveAgents(raw: unknown): Map<string, LiveAgent> {
  const out = new Map<string, LiveAgent>();
  const projects = isObject(raw) && Array.isArray(raw.projects) ? raw.projects : [];
  for (const p of projects) {
    const list = isObject(p) && isObject(p.agents) && Array.isArray(p.agents.list) ? p.agents.list : [];
    for (const a of list) {
      if (!isObject(a)) continue;
      const id = str(a.cliId) ?? str(a.file);
      if (!id) continue;
      const open = isObject(a.open) ? str(a.open.via) : null;
      const use = isObject(a.use) ? a.use : null;
      out.set(id, {
        id,
        provider: str(a.provider),
        harness: str(a.harness),
        model: str(a.model),
        inTopics: open === IN_TOPICS,
        weekPct: use ? num(use.pct) : null,
        workflow: str(a.workflow),
      });
    }
  }
  return out;
}

/** How many agents the hub sees at work outside Topics: the hub's own count, less the Topics tabs. */
export function agentsOutsideTopics(live: unknown): number {
  let n = 0;
  for (const a of liveAgents(live).values()) if (!a.inTopics) n++;
  return n;
}

const runnerOf = (a: LiveAgent | undefined): string | null => {
  if (!a) return null;
  const k = (a.harness ?? a.provider ?? '').toLowerCase();
  return RUNNERS[k] ?? (k ? k[0]!.toUpperCase() + k.slice(1) : null);
};

/** The hub's generic titles, said by the view in its own words instead. */
const GENERIC = /^(?:Lavoro su|Subagente su|Workflow su|Workflow a più agenti)\b/; // allow-italian: the hub's wire titles

/**
 * The hub's work outside Topics, from `/api/board` and `/api/live`. Either
 * may be null (not read yet, or the hub is silent): what the other says stays.
 */
export function hubWork(board: unknown, live: unknown): HubWork {
  const agents = liveAgents(live);
  const out: HubWork = { sessions: [], subagents: [], workflows: [], paused: new Map(), icons: new Map() };
  const projects = isObject(board) && Array.isArray(board.projects) ? board.projects : [];
  for (const p of projects) {
    if (!isObject(p)) continue;
    const icon = str(p.icon);
    if (!icon) continue;
    for (const n of [p.name, p.display, p.title]) {
      const name = str(n);
      if (name && !out.icons.has(name)) out.icons.set(name, icon);
    }
  }
  const work = isObject(board) && Array.isArray(board.work) ? board.work : [];
  for (const w of work) {
    if (!isObject(w)) continue;
    const id = str(w.id);
    const kind = str(w.kind);
    const state = str(w.state);
    if (!id || !kind) continue;
    if (kind === 'delega' && state === PAUSED) { // allow-italian: the hub's wire value
      const why = str(w.why);
      if (why && id.startsWith('q:')) out.paused.set(id.slice(2), { why, until: num(w.until) });
      continue;
    }
    if (state !== RUNNING) continue;
    const sep = id.indexOf(':');
    const ref = sep > 0 ? id.slice(sep + 1) : id;
    const a = agents.get(ref);
    const title = str(w.title) ?? '';
    const base = {
      key: `hub:${id}`,
      title: GENERIC.test(title) ? '' : title,
      project: str(w.project),
      icon: str(w.icon),
      model: a?.model ?? null,
      startedAt: num(w.startedAt),
      tokens: num(w.tokens),
      agents: num(w.agents),
      onCommand: str(w.stateText) === ON_COMMAND,
      runId: null,
    };
    if (kind === 'sessione' && id.startsWith('ses:')) { // allow-italian: the hub's wire value
      if (a?.inTopics) continue;
      out.sessions.push({ ...base, kind: 'session', runner: runnerOf(a), weekPct: a?.weekPct ?? null });
    } else if (kind === 'subagente' && id.startsWith('sub:')) { // allow-italian: the hub's wire value
      out.subagents.push({ ...base, kind: 'subagent', runner: runnerOf(a) ?? 'Claude', weekPct: a?.weekPct ?? null, agents: null });
    } else if (kind === 'workflow' && id.startsWith('wf:')) {
      // The agents of one live workflow share its run id: the share of the week is theirs summed.
      const own = [...agents.values()].filter((x) => x.workflow === ref);
      const pct = own.reduce((s, x) => s + (x.weekPct ?? 0), 0);
      out.workflows.push({ ...base, kind: 'workflow', runner: runnerOf(own[0]) ?? 'Claude', weekPct: own.length ? pct : null, runId: ref.startsWith('wf_') ? ref : null });
    }
  }
  return out;
}

/** The icon of a project by the name a row shows, as a path of the Topics bridge (`/api/hub/...`). */
export function hubIconPath(icons: Map<string, string>, project: string | null | undefined): string | null {
  const src = project ? icons.get(project) : undefined;
  return src && src.startsWith('/api/') ? `/api/hub/${src.slice('/api/'.length)}` : null;
}
