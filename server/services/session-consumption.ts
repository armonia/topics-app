/**
 * WHAT EACH LIVE SESSION COSTS: the one answer behind the load screen of the
 * PC, the machine's Processes view and the card drawer.
 *
 * It joins sources that already exist and keeps none of its own:
 *  - the process table of the last fleet reading (`fleet-usage.ts`), attributed
 *    by `lib/session-attribution.ts`: the memory and CPU of every process
 *    Topics launched for a session, with the shared ones split;
 *  - the tokens of a session: the native runtime's registry, else the
 *    transcripts (the dispatcher's own reader, children included), else the
 *    card's counter `tasks.agent_tokens`. The dead tables of the old usage
 *    ledger are not read and nothing is written;
 *  - the output rate, from the growth of the output counter over a declared
 *    window (`lib/session-rate.ts`);
 *  - the card, chat or terminal a session is, for its title, project and model.
 *
 * A session is the unit a person recognises: a card (its coordinator and the
 * sub-agents it spawned are one), a chat, a terminal. A session is listed when
 * it is a card in progress, or when something is happening in it (a command in
 * flight, output on its terminal, output tokens growing); a chat left open
 * with nothing running is idle: its memory is counted apart and not shared out.
 */
import {
  attachRemoteJobs, attributeProcesses, type AttrRow, type AttrHead, type RemoteJob,
} from "../lib/session-attribution";
import { RATE_WINDOW_MS, createRateTracker } from "../lib/session-rate";
import { topicSessionKey } from "./agent-census";
import type {
  ConsumptionAnswer, ConsumptionTokens, SessionConsumption, SessionKind,
} from "../../shared/session-consumption";

/** A session counts as having output "now" when its counter grew within this long. */
const ACTIVE_WITHIN_MS = 60_000;
/** One computation serves every reader inside this window: N screens do not mean N tables. */
const CACHE_MS = 2_000;
/** A session not seen for this long is forgotten by the rate tracker. */
const FORGET_AFTER_MS = 10 * 60_000;
const TOP_PROCS = 5;

/** A card in progress, cut to what the consumption needs. */
export interface ConsumptionTask {
  id: string;
  text: string;
  projectId: string;
  model: string | null;
  machineId: string | null;
  assignedTopicId: string | null;
  inProgressAt: string | null;
  updatedAt: string | null;
  agentTokens: number;
  awaitingAnswer: boolean;
  from: string | null;
}

export interface ConsumptionTopic { id: string; name: string; projectPath: string | null; model: string | null }

export interface ConsumptionTable {
  rows: AttrRow[];
  roots: { id: string; pid: number }[];
  cores: number;
  responsibleOf?: (pid: number) => number | null;
}

export interface UsageReading {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  billableTokens: number;
  source: "native" | "transcript";
}

export interface ConsumptionDeps {
  now: () => number;
  /** The last fleet process table; null where it cannot be read (Windows, no ps). */
  table: () => Promise<ConsumptionTable | null>;
  tasks: () => ConsumptionTask[];
  /** The PTYs: owners of work, with their pid. */
  terminals: () => Array<{ id: string; name: string; topicId: string | null; parentSessionKey: string | null; createdAt: string; busy: boolean; pid: number | null }>;
  /** CLI pids of chat sessions (session key -> pid). */
  cliPids: () => Array<{ sessionKey: string; pid: number }>;
  /** Commands the native runtime started for a session. */
  nativeCommands: () => Array<{ sessionKey: string; pid: number }>;
  /** Scripts a session launched. */
  scriptOwners: () => Array<{ sessionKey: string; pid: number }>;
  /** Project scripts nobody's session owns. */
  unownedScripts: () => number[];
  usageOf: (sessionKey: string) => UsageReading | null;
  /**
   * When the turn now running in a chat began (its last user message), epoch ms: a durable fact of the
   * conversation, so the clock survives a server restart. Absent or null = unknown, and the clock falls
   * back on when this server first saw the chat at work.
   */
  turnStartedAt?: (sessionKey: string) => number | null;
  topicsBySessionKey: (keys: readonly string[]) => Map<string, ConsumptionTopic>;
  /** The project name as a person reads it, from a board project id or a folder path. */
  projectName: (src: { boardId?: string; path?: string | null }) => string | null;
  /** The name of a machine that is not this one; null for this machine. */
  remoteMachineName: (machineId: string | null) => string | null;
}

/** What the paired machine reports of the work the Mac sent it. */
export interface RemoteReport {
  /** The machine's name, for the row to say where the work runs. */
  machine?: string | null;
  jobs: RemoteJob[];
  load: { memMB: number | null; cpuPct: number | null };
}

interface Candidate {
  key: string;
  kind: SessionKind;
  task: ConsumptionTask | null;
  /** The chat key (`topic:<8>`) that carries its tokens, if it has one. */
  topicKey: string | null;
  terminalName: string | null;
  startedAt: number | null;
  busy: boolean;
  command: boolean;
}

const parseTime = (v: string | null): number | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface SessionConsumptionService {
  read(opts?: { remote?: RemoteReport | null }): Promise<ConsumptionAnswer>;
}

export function createSessionConsumption(deps: ConsumptionDeps): SessionConsumptionService {
  const tracker = createRateTracker();
  let cache: { at: number; answer: ConsumptionAnswer; remoteKey: string } | null = null;
  let inFlight: { key: string; p: Promise<ConsumptionAnswer> } | null = null;

  async function compute(remote: RemoteReport | null): Promise<ConsumptionAnswer> {
    const now = deps.now();
    const table = await deps.table();
    const tasks = deps.tasks();
    const terminals = deps.terminals();

    const cardByTopicKey = new Map<string, ConsumptionTask>();
    for (const t of tasks) if (t.assignedTopicId) cardByTopicKey.set(topicSessionKey(t.assignedTopicId), t);
    const terminalById = new Map(terminals.map((t) => [t.id, t]));

    /** The unit a session key belongs to: a sub-agent folds into its coordinator, a topic's PTY into the topic, a bound topic into its card. */
    const unitOf = (key: string, depth = 0): string => {
      const term = terminalById.get(key);
      if (term && depth < 4) {
        if (term.parentSessionKey) return unitOf(term.parentSessionKey, depth + 1);
        if (term.topicId) return unitOf(topicSessionKey(term.topicId), depth + 1);
        return `terminal:${term.id}`;
      }
      const card = cardByTopicKey.get(key);
      return card ? `card:${card.id}` : key;
    };

    // Candidates: the cards in progress, and every other unit that owns a process.
    const candidates = new Map<string, Candidate>();
    for (const t of tasks) {
      candidates.set(`card:${t.id}`, {
        key: `card:${t.id}`, kind: "card", task: t, topicKey: t.assignedTopicId ? topicSessionKey(t.assignedTopicId) : null,
        terminalName: null, startedAt: parseTime(t.inProgressAt) ?? parseTime(t.updatedAt), busy: false, command: false,
      });
    }
    const touch = (key: string, partial: Partial<Candidate>) => {
      const unit = unitOf(key);
      if (unit.startsWith("card:") && !candidates.has(unit)) return; // a card no longer in progress: its leftovers are not a session
      const c = candidates.get(unit) ?? {
        key: unit, kind: unit.startsWith("terminal:") ? "terminal" as const : "chat" as const, task: null,
        topicKey: unit.startsWith("topic:") ? unit : null, terminalName: null, startedAt: null, busy: false, command: false,
      };
      Object.assign(c, { ...partial, busy: c.busy || !!partial.busy, command: c.command || !!partial.command });
      candidates.set(unit, c);
    };

    const heads: AttrHead[] = [];
    for (const s of deps.scriptOwners()) { heads.push({ unit: unitOf(s.sessionKey), pid: s.pid }); touch(s.sessionKey, {}); }
    for (const c of deps.nativeCommands()) { heads.push({ unit: unitOf(c.sessionKey), pid: c.pid }); touch(c.sessionKey, { command: true }); }
    for (const t of terminals) {
      if (t.pid !== null) heads.push({ unit: unitOf(t.id), pid: t.pid });
      touch(t.id, {
        busy: t.busy, terminalName: t.name,
        ...(unitOf(t.id).startsWith("terminal:") ? { startedAt: parseTime(t.createdAt) } : {}),
      });
    }
    for (const c of deps.cliPids()) { heads.push({ unit: unitOf(c.sessionKey), pid: c.pid }); touch(c.sessionKey, {}); }

    // Tokens first: the rate needs the output counter observed at every read, active or not.
    const tokensOf = new Map<string, ConsumptionTokens | null>();
    for (const c of candidates.values()) {
      const u = c.topicKey ? deps.usageOf(c.topicKey) : null;
      let tokens: ConsumptionTokens | null = null;
      if (u && (u.billableTokens > 0 || u.source === "native")) {
        tokens = { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadTokens, cacheWrite: u.cacheWriteTokens, total: u.billableTokens, source: u.source };
      } else if (c.task && c.task.agentTokens > 0) {
        tokens = { input: null, output: null, cacheRead: null, cacheWrite: null, total: c.task.agentTokens, source: "card" };
      }
      tokensOf.set(c.key, tokens);
      if (tokens?.output != null) tracker.observe(c.key, tokens.output, now);
    }

    const isLive = (c: Candidate) => c.kind === "card" || c.busy || c.command || tracker.grewWithin(c.key, now, ACTIVE_WITHIN_MS);
    const live = [...candidates.values()].filter(isLive);
    // A card running on another machine uses nothing of this one: it is listed, never a user of the server.
    const liveKeys = live.filter((c) => !(c.task && deps.remoteMachineName(c.task.machineId))).map((c) => c.key);

    const attribution = table
      ? attributeProcesses({
        rows: table.rows, roots: table.roots, heads, unowned: deps.unownedScripts(), units: liveKeys, responsibleOf: table.responsibleOf,
      })
      : null;
    const cores = Math.max(1, table?.cores ?? 1);

    const topics = deps.topicsBySessionKey([...new Set(live.flatMap((c) => (c.topicKey ? [c.topicKey] : [])))]);

    // The sessions of each project, to place the work sent to another machine.
    const sessionsByProject = new Map<string, string[]>();
    const projectOf = new Map<string, string | null>();
    const sendsFromHere = new Set(liveKeys);
    for (const c of live) {
      const topic = c.topicKey ? topics.get(c.topicKey) : undefined;
      const project = c.task
        ? deps.projectName({ boardId: c.task.projectId })
        : deps.projectName({ path: topic?.projectPath ?? null });
      projectOf.set(c.key, project);
      // A card running on another machine sent that machine nothing: only the sessions here share its jobs.
      if (project && sendsFromHere.has(c.key)) {
        const list = sessionsByProject.get(project.toLowerCase()) ?? [];
        list.push(c.key);
        sessionsByProject.set(project.toLowerCase(), list);
      }
    }
    const placed = remote ? attachRemoteJobs(remote.jobs, remote.load, sessionsByProject) : null;

    const sessions: SessionConsumption[] = live.map((c) => {
      const load = attribution?.units.get(c.key);
      const topic = c.topicKey ? topics.get(c.topicKey) : undefined;
      const machine = c.task ? deps.remoteMachineName(c.task.machineId) : null;
      const measured = load !== undefined && machine === null;
      const ownMB = measured ? Math.round(load.ownKB / 1024) : null;
      const sharedKB = measured ? load.shares.reduce((s, x) => s + x.kb, 0) : 0;
      let cpu: number | null = measured ? load.ownCpu : null;
      if (measured) for (const sh of load.shares) cpu = sh.cpu === null ? cpu : (cpu ?? 0) + sh.cpu;
      const tokens = tokensOf.get(c.key) ?? null;
      const tps = tokens?.output != null ? tracker.rate(c.key, now) : null;
      const title = c.task ? c.task.text : topic?.name ?? c.terminalName ?? c.key;
      return {
        key: c.key,
        kind: c.kind,
        title,
        project: projectOf.get(c.key) ?? null,
        model: c.task?.model ?? topic?.model ?? null,
        state: c.task?.awaitingAnswer ? "waiting" as const : "working" as const,
        startedAt: c.startedAt ?? (c.topicKey ? deps.turnStartedAt?.(c.topicKey) ?? null : null) ?? tracker.firstSeen(c.key),
        cardId: c.task?.id ?? null,
        machine,
        tokens,
        tps: tps === null ? null : round1(tps),
        memMB: measured ? Math.round((load.ownKB + sharedKB) / 1024) : null,
        cpuPct: cpu === null ? null : round1(cpu / cores),
        ownMB,
        shares: measured ? load.shares.map((x) => ({
          id: x.root, totalMB: Math.round(x.totalKB / 1024), of: x.of, mb: Math.round(x.kb / 1024), cpuPct: x.cpu === null ? null : round1(x.cpu / cores),
        })) : [],
        procs: measured ? load.procs.slice(0, TOP_PROCS).map((p) => ({
          name: p.name, count: p.count, memMB: Math.round(p.memKB / 1024), cpuPct: p.cpu === null ? null : round1(p.cpu / cores),
        })) : [],
        remote: (placed?.bySession.get(c.key) ?? []).map((r) => ({
          what: r.job.what, where: remote?.machine ?? null, who: r.job.who, since: r.job.since, of: r.of,
          memMB: r.memMB === null ? null : Math.round(r.memMB), cpuPct: r.cpuPct,
        })),
        awaiting: c.task?.awaitingAnswer === true,
        from: c.task?.from ?? null,
      };
    }).sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));

    let idleSessions = 0;
    let idleKB = 0;
    // Processes this machine still holds for a card that runs elsewhere: no session here carries them, so they
    // are counted as nobody's rather than dropped, or billed + idle + unattributed would fall short of the table.
    let strandedKB = 0;
    let strandedProcesses = 0;
    let strandedCpu: number | null = null;
    if (attribution) {
      const liveSet = new Set(live.map((c) => c.key));
      const measuredSet = new Set(liveKeys);
      for (const [key, u] of attribution.units) {
        if (u.ownProcesses === 0) continue;
        if (liveSet.has(key)) {
          if (!measuredSet.has(key)) {
            strandedKB += u.ownKB;
            strandedProcesses += u.ownProcesses;
            if (u.ownCpu !== null) strandedCpu = (strandedCpu ?? 0) + u.ownCpu;
          }
          continue;
        }
        idleSessions += 1;
        idleKB += u.ownKB;
      }
    }
    const looseCpu = attribution?.unattributed.cpu ?? null;
    const restCpu = looseCpu === null && strandedCpu === null ? null : (looseCpu ?? 0) + (strandedCpu ?? 0);
    tracker.prune(now - FORGET_AFTER_MS);

    return {
      at: now,
      windowS: RATE_WINDOW_MS / 1000,
      rule: "equal",
      sessions,
      sent: remote && placed ? { jobs: remote.jobs, unplaced: placed.unmatched } : null,
      unattributed: {
        memMB: Math.round(((attribution?.unattributed.kb ?? 0) + strandedKB) / 1024),
        cpuPct: restCpu === null ? null : round1(restCpu / cores),
        processes: (attribution?.unattributed.processes ?? 0) + strandedProcesses,
      },
      idle: { sessions: idleSessions, memMB: Math.round(idleKB / 1024) },
    };
  }

  return {
    async read(opts) {
      const remote = opts?.remote ?? null;
      const remoteKey = remote ? JSON.stringify(remote) : "";
      if (cache && cache.remoteKey === remoteKey && deps.now() - cache.at < CACHE_MS) return cache.answer;
      if (inFlight && inFlight.key === remoteKey) return inFlight.p;
      const p = compute(remote).then((answer) => { cache = { at: deps.now(), answer, remoteKey }; return answer; }).finally(() => { inFlight = null; });
      inFlight = { key: remoteKey, p };
      return p;
    },
  };
}
