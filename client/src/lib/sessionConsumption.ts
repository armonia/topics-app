/**
 * The per-session consumption, as pure reads of its one answer
 * (`GET /api/usage/consumption`, or `/api/system/screen-sessions` on the load
 * screen): the load screen, the Processes view and the card drawer all read
 * this, so they show the same numbers.
 *
 * Nothing here fetches or keeps time: `now` comes from the caller, so the clock
 * of a row is a function of two numbers. A number the server did not measure is
 * null and is drawn as a dash, never as 0.
 */
import type {
  ConsumptionAnswer, ConsumptionProc, ConsumptionSent, SentJob, ConsumptionRemote, ConsumptionShare, ConsumptionTokens, SessionConsumption, SessionKind,
} from '../../../shared/session-consumption';

type JsonRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is JsonRecord => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const list = (v: unknown): JsonRecord[] => (Array.isArray(v) ? v.filter(isRecord) : []);

const KINDS: readonly SessionKind[] = ['card', 'chat', 'terminal'];

function readTokens(v: unknown): ConsumptionTokens | null {
  if (!isRecord(v)) return null;
  const total = num(v.total);
  if (total === null) return null;
  const source = v.source === 'native' || v.source === 'transcript' || v.source === 'card' ? v.source : 'card';
  return { input: num(v.input), output: num(v.output), cacheRead: num(v.cacheRead), cacheWrite: num(v.cacheWrite), total, source };
}

function readJobs(v: unknown): SentJob[] {
  return list(v).map((j) => ({ project: str(j.project), repo: str(j.repo), what: str(j.what) ?? '', who: str(j.who), since: num(j.since) }));
}

function readSent(v: unknown): ConsumptionSent | null {
  return isRecord(v) ? { jobs: readJobs(v.jobs), unplaced: readJobs(v.unplaced) } : null;
}

/** The answer, defensively: a field of the wrong type is absent, never a crash. */
export function readConsumption(raw: unknown): ConsumptionAnswer {
  const top = isRecord(raw) ? raw : {};
  const un = isRecord(top.unattributed) ? top.unattributed : {};
  const idle = isRecord(top.idle) ? top.idle : {};
  return {
    at: num(top.at) ?? 0,
    windowS: num(top.windowS) ?? 30,
    rule: 'equal',
    sessions: list(top.sessions).flatMap((s): SessionConsumption[] => {
      const key = str(s.key);
      if (!key) return [];
      const shares: ConsumptionShare[] = list(s.shares).flatMap((x) => {
        const id = str(x.id), mb = num(x.mb), totalMB = num(x.totalMB), of = num(x.of);
        return id && mb !== null && totalMB !== null && of !== null ? [{ id, mb, totalMB, of, cpuPct: num(x.cpuPct) }] : [];
      });
      const procs: ConsumptionProc[] = list(s.procs).flatMap((p) => {
        const name = str(p.name), memMB = num(p.memMB);
        return name && memMB !== null ? [{ name, memMB, count: num(p.count) ?? 1, cpuPct: num(p.cpuPct) }] : [];
      });
      const remote: ConsumptionRemote[] = list(s.remote).map((r) => ({
        what: str(r.what) ?? '', where: str(r.where), who: str(r.who), since: num(r.since), of: num(r.of) ?? 1, memMB: num(r.memMB), cpuPct: num(r.cpuPct),
      }));
      return [{
        key,
        kind: (KINDS as readonly unknown[]).includes(s.kind) ? (s.kind as SessionKind) : 'chat',
        title: str(s.title) ?? key,
        project: str(s.project),
        model: str(s.model),
        state: s.state === 'waiting' ? 'waiting' : 'working',
        startedAt: num(s.startedAt),
        cardId: str(s.cardId),
        machine: str(s.machine),
        tokens: readTokens(s.tokens),
        tps: num(s.tps),
        memMB: num(s.memMB),
        cpuPct: num(s.cpuPct),
        ownMB: num(s.ownMB),
        shares, procs, remote,
        awaiting: s.awaiting === true,
        from: str(s.from),
      }];
    }),
    sent: readSent(top.sent),
    unattributed: { memMB: num(un.memMB) ?? 0, cpuPct: num(un.cpuPct), processes: num(un.processes) ?? 0 },
    idle: { sessions: num(idle.sessions) ?? 0, memMB: num(idle.memMB) ?? 0 },
  };
}

/** A session's clock: «4:07», «1:12:09». Whole seconds, never negative. */
export function clockOf(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Tokens per second with the decimal comma: «42», «3,5», «0». Null stays a dash at the call site. */
export function formatTps(v: number): string {
  if (v >= 100) return String(Math.round(v));
  return (Math.round(v * 10) / 10).toString().replace('.', ',');
}

/** The share of a process as a fraction a person reads with a pencil: «1/3». */
export const shareFraction = (s: ConsumptionShare): string => `1/${s.of}`;

/** The most a list asks for before counting the rest. */
export const MAX_SESSIONS = 12;
