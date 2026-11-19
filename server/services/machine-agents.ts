/**
 * What runs on each machine, for the tray and the Processes view
 * (`agents` on every row of `GET /api/machines/overview`).
 *
 * Nothing here is stored: every state is DERIVED from the board rows plus the
 * in-memory list of open chat turns, so the numbers cannot drift from what the
 * dispatcher and the board already say.
 *
 * WHERE A CARD RUNS. `tasks.machine_id` NULL is this machine, and so is a row
 * of `machines` with no `base_url` (one row per hostname this Mac ever had,
 * the same reading as `RUNS_HERE_SQL` in `agent-census.ts`). Any other id is
 * a paired node or Cloud Claude, whose cards live on THAT machine.
 *
 * THE STATE OF A CARD (first match wins, status decides the branch):
 *  - stuck:   todo or in_progress, chip `queued` whose error is the
 *             dispatcher's plan-limit reason (`isPlanWaitReason`, written by
 *             `taskPlanWait` in `task-dispatcher-hold.ts`).
 *  - waiting: review with a `human_ask` or the chip `needs_input`; also an
 *             in_progress card on `needs_input`.
 *  - review:  every other review card.
 *  - working: in_progress with a live turn. The dispatcher's own definition
 *             (`LIVE_DISPATCH_STATES` in `agent-census.ts`: `starting`,
 *             `working`); a card with NO chip at all is one an agent or a
 *             person moved to in_progress by hand, and its worker is the chat
 *             that opened it, so it works while that chat has a turn open.
 *  - idle:    in_progress, none of the above (counted, never listed).
 *  - queued:  todo, and any other in_progress card (`queued` chip: a node
 *             waiting for a slot; `waiting`: a condition the agent declared).
 *
 * CHATS. A conversation of the native engine is an agent too, but not a card:
 * it is counted in `chats` while its turn is open (`turnLedger`), and in
 * `waiting` while it is parked on an unanswered question. A session that
 * belongs to a card's own topic is the card, never a chat.
 */
import type { Database } from "bun:sqlite";
import type { MachineAgentItem, MachineAgentState, MachineAgents } from "../../shared/machine-overview";
import { isPlanWaitReason } from "../../shared/provider-hold";
import { projectLabel } from "../../shared/project-label";
import { topicSessionKey } from "./agent-census";
import { buildProjectNames, loadRegisteredProjects } from "./project-display-name";

export const MAX_AGENT_ITEMS = 12;
/** A review left alone this long is counted but not listed: it is a backlog, not an agent. */
export const STALE_REVIEW_MS = 7 * 24 * 3_600_000;
const TITLE_MAX = 64;
export const NO_PROJECT = "Senza progetto";

const STATE_ORDER: MachineAgentState[] = ["waiting", "working", "chat", "stuck", "review", "queued"];

interface TaskRow {
  text: string;
  status: string;
  project_id: string;
  machine_id: string | null;
  dispatch_state: string | null;
  dispatch_error: string | null;
  human_ask: string | null;
  in_progress_at: string | null;
  review_at: string | null;
  updated_at: string;
  created_by_topic_id: string | null;
  assigned_topic_id: string | null;
}

interface TopicRow {
  name: string;
  session_key: string;
  project_path: string | null;
  worktree_project_id: string | null;
}

export interface MachineAgentsInput {
  db: Database;
  /** Every machine the overview lists; `baseUrl` null = this computer under an older hostname. */
  machines: Array<{ id: string; baseUrl: string | null }>;
  localId: string | null;
  /** Chats with a turn open now: session key → epoch ms the turn began (null when unknown). */
  openChats: ReadonlyMap<string, number | null>;
  /** Chats whose last message is an unanswered question. */
  parkedChats: readonly string[];
  now: number;
}

/** A tray-sized title: first line, no markup or leading emoji, cut on a word. Never an id or a branch name. */
export function shortTitle(raw: string | null | undefined, fallback: string): string {
  const firstLine = (raw ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  let t = firstLine
    .replace(/[*_`~]+/g, "")
    .replace(/^[#>\s\p{Extended_Pictographic}\uFE0F\u200D]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > TITLE_MAX) {
    const cut = t.slice(0, TITLE_MAX);
    const space = cut.lastIndexOf(" ");
    t = `${(space > TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-\u2013\u2014]+$/, "")}…`;
  }
  t = t.replace(/[\s:;,]+$/, "");
  const looksLikeId = /^[0-9a-f-]{8,}$/i.test(t) || /^[\w.-]+\/[\w./-]+$/.test(t) || /^topic:/.test(t);
  return t && !looksLikeId ? t : fallback;
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : null;
}

function emptyAgents(): MachineAgents & { _items: MachineAgentItem[]; _projects: Map<string, number> } {
  return { working: 0, waiting: 0, review: 0, stuck: 0, queued: 0, idle: 0, chats: 0, byProject: [], items: [], _items: [], _projects: new Map() };
}

/** The agents of every machine in `machines`, keyed by machine id. */
export function readMachineAgents(input: MachineAgentsInput): Map<string, MachineAgents> {
  const { db, machines, localId, openChats, parkedChats, now } = input;
  const known = new Set(machines.map((m) => m.id));
  const asLocal = new Set(machines.filter((m) => !m.baseUrl).map((m) => m.id));
  const where = (machineId: string | null): string | null => {
    if (machineId === null || asLocal.has(machineId)) return localId;
    return known.has(machineId) ? machineId : null;
  };

  const byMachine = new Map<string, ReturnType<typeof emptyAgents>>();
  for (const m of machines) byMachine.set(m.id, emptyAgents());
  const add = (machineId: string | null, state: MachineAgentState | "idle", project: string, item: MachineAgentItem | null, counted = true): void => {
    const target = machineId ? byMachine.get(machineId) : undefined;
    if (!target) return;
    if (state === "chat") target.chats++;
    else target[state]++;
    if (counted) target._projects.set(project, (target._projects.get(project) ?? 0) + 1);
    if (item) target._items.push(item);
  };

  // `tasks.project_id` is a board id (folder hash), not a `projects.id`: the visible name comes
  // from the same rule the board and the Plan use, so a tray row and a lane never disagree.
  const registered = loadRegisteredProjects(db);
  const names = buildProjectNames(registered);
  const nameByBoard = new Map([...names].map(([id, entry]) => [id, entry.name]));

  const rows = db.prepare(
    `SELECT t.text, t.status, t.project_id, t.machine_id, t.dispatch_state, t.dispatch_error,
            t.human_ask, t.in_progress_at, t.review_at, t.updated_at, t.created_by_topic_id, t.assigned_topic_id
       FROM tasks t
      WHERE t.archived = 0 AND t.status IN ('todo', 'in_progress', 'review')`,
  ).all() as TaskRow[];

  // Sessions that belong to a card: they are the card's agent, never a chat of their own.
  const cardSessions = new Set<string>();
  for (const r of rows) if (r.assigned_topic_id) cardSessions.add(topicSessionKey(r.assigned_topic_id));

  for (const r of rows) {
    const machine = where(r.machine_id);
    const project = r.project_id ? projectLabel(r.project_id, nameByBoard) : NO_PROJECT;
    const title = shortTitle(r.text, "Card senza titolo");
    const asks = !!r.human_ask?.trim() || r.dispatch_state === "needs_input";
    const item = (state: MachineAgentState, sinceIso: string | null, listed = true): MachineAgentItem | null =>
      listed ? { title, project, state, since: ms(sinceIso) ?? ms(r.updated_at) } : null;

    if ((r.status === "todo" || r.status === "in_progress") && r.dispatch_state === "queued" && isPlanWaitReason(r.dispatch_error)) {
      add(machine, "stuck", project, item("stuck", r.updated_at));
    } else if (r.status === "review" || (r.status === "in_progress" && asks)) {
      const state: MachineAgentState = asks ? "waiting" : "review";
      const since = r.review_at ?? r.updated_at;
      const age = now - (ms(since) ?? now);
      add(machine, state, project, item(state, since, age <= STALE_REVIEW_MS));
    } else if (r.status === "in_progress") {
      const live = r.dispatch_state === "starting" || r.dispatch_state === "working"
        || (r.dispatch_state === null && !!r.created_by_topic_id && openChats.has(topicSessionKey(r.created_by_topic_id)));
      if (live) add(machine, "working", project, item("working", r.in_progress_at));
      else if (r.dispatch_state === null) add(machine, "idle", project, null);
      else add(machine, "queued", project, item("queued", r.updated_at));
    } else {
      add(machine, "queued", project, item("queued", r.updated_at));
    }
  }

  // Chats: the native engine runs on this machine only.
  const chatKeys = [...new Set([...openChats.keys(), ...parkedChats])].filter((k) => k.startsWith("topic:") && !cardSessions.has(k));
  if (chatKeys.length > 0 && localId) {
    const marks = chatKeys.map(() => "?").join(",");
    const topics = db.prepare(
      `SELECT tp.name, tp.session_key, tp.project_path, w.project_id AS worktree_project_id
         FROM topics tp LEFT JOIN worktrees w ON w.id = tp.worktree_id
        WHERE tp.archived = 0 AND tp.session_key IN (${marks})`,
    ).all(...chatKeys) as TopicRow[];
    const withPath = registered.filter((p) => p.path && !p.archived)
      .map((p) => ({ id: p.id, path: p.path!.replace(/\/+$/, "") }))
      .sort((a, b) => b.path.length - a.path.length);
    const labelOfRow = (rowId: string): string => names.get(rowId)?.name ?? NO_PROJECT;
    const projectOf = (t: TopicRow): string => {
      if (t.worktree_project_id) return labelOfRow(t.worktree_project_id);
      const path = t.project_path ?? "";
      const hit = path ? withPath.find((p) => path === p.path || path.startsWith(`${p.path}/`)) : null;
      return hit ? labelOfRow(hit.id) : NO_PROJECT;
    };
    const parked = new Set(parkedChats);
    for (const t of topics) {
      const project = projectOf(t);
      const title = shortTitle(t.name, "Chat senza titolo");
      const open = openChats.has(t.session_key);
      // A chat that has a turn open is working; one parked on a question waits for a person.
      if (open) add(localId, "chat", project, { title, project, state: "chat", since: openChats.get(t.session_key) ?? null });
      else if (parked.has(t.session_key)) add(localId, "waiting", project, { title, project, state: "waiting", since: null });
    }
  }

  const out = new Map<string, MachineAgents>();
  for (const [id, a] of byMachine) {
    const items = a._items
      .sort((x, y) => STATE_ORDER.indexOf(x.state) - STATE_ORDER.indexOf(y.state) || (y.since ?? 0) - (x.since ?? 0))
      .slice(0, MAX_AGENT_ITEMS);
    const byProject = [...a._projects].map(([project, count]) => ({ project, count }))
      .sort((x, y) => y.count - x.count || x.project.localeCompare(y.project));
    const { _items, _projects, ...rest } = a;
    void _items; void _projects;
    out.set(id, { ...rest, byProject, items });
  }
  return out;
}
