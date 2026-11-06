/**
 * What the Automations view reads and writes, in one hook.
 *
 * Reads: the hub's model (`/api/hub/automations`, about a megabyte, so it is
 * read when the view opens and again only when the hub's live summary changes,
 * never on a timer), the OpenClaw jobs as Topics lists them (`/api/cron/jobs`),
 * the calendar and the queue (to know which «Risolvi tu» agents are already at
 * work). Writes: the commands on a job go to Topics' cron routes, the votes and
 * notes to the hub's feedback log, «Risolvi tu» to the hub's `fix`. After every
 * write the view reads again what the service says: the screen shows what was
 * read back, never what was hoped for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../../lib/shell/net';
import { refreshHubLive, useHubLive } from '../../state/hubLive';
import {
  feedbackRowId, fixingKeys, jobRequest, readAutomations, readCronJobs, refusalOf, undoBody, withCronJobs,
  type AutomationRow, type AutomationsModel, type CronJob, type JobCommand,
} from '../../lib/automations';
import { readCalendar, type CalendarEntry } from '../../lib/automationsCalendar';

async function getJson(path: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const r = await apiFetch(path);
    const body: unknown = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

async function send(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: Record<string, unknown>): Promise<{ ok: boolean; status: number; error: string | null; body: unknown }> {
  try {
    const r = await apiFetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const parsed: unknown = await r.json().catch(() => null);
    const error = parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : null;
    return { ok: r.ok, status: r.status, error, body: parsed };
  } catch {
    return { ok: false, status: 0, error: null, body: null };
  }
}

export interface FeedbackResult {
  error: string | null;
  ref: string | null;
}

export type JobRefusal = { what: JobCommand['kind'] | 'disable'; why: 'gateway' | 'notRun' | 'refused' };

export interface AutomationsData {
  rows: AutomationRow[];
  model: AutomationsModel | null;
  /** When the hub's model was last read whole. */
  readAt: number | null;
  /** The hub answers neither the model nor the live summary. */
  hubDown: boolean;
  /** The gateway did not list the OpenClaw jobs: their commands are off. */
  gatewayDown: boolean;
  calendar: CalendarEntry[] | null;
  /** Who runs each dated reminder, by its key, from the hub's model. */
  fixing: ReadonlySet<string>;
  /** When a job was run from here, by key: the receipt the row shows at once. */
  ranAt: Readonly<Record<string, number>>;
  refusal: JobRefusal | null;
  clearRefusal(): void;
  retry(): Promise<void>;
  command(row: AutomationRow, c: JobCommand): Promise<boolean>;
  /** Written and read back (`error` null, `ref` the hub's id of the row, for the undo button), or the hub's reason. */
  feedback(body: Record<string, unknown>): Promise<FeedbackResult>;
  /** Takes back a feedback row by its id; null when done and read back. */
  undo(ref: string): Promise<string | null>;
  fix(key: string): Promise<{ ok: boolean; already: boolean; why: string | null }>;
}

/** `describe` words the schedule of an OpenClaw job the hub leaves out (a switched-off one). */
export function useAutomationsData(describe?: (job: CronJob) => string | null): AutomationsData {
  const summary = useHubLive().automations;
  const [model, setModel] = useState<AutomationsModel | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [modelFailing, setModelFailing] = useState(false);
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [gatewayDown, setGatewayDown] = useState(false);
  const [calendar, setCalendar] = useState<CalendarEntry[] | null>(null);
  const [fixing, setFixing] = useState<Set<string>>(() => new Set());
  const [ranAt, setRanAt] = useState<Record<string, number>>({});
  const [refusal, setRefusal] = useState<JobRefusal | null>(null);
  // Jobs deleted from here: the hub keeps their card until its next round of the gateway.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const alive = useRef(true);

  const readModel = useCallback(async () => {
    const r = await getJson('/api/hub/automations');
    if (!alive.current) return;
    const m = r.ok ? readAutomations(r.body) : null;
    setModelFailing(!m);
    // A failed read keeps the last good model: the band says how old it is.
    if (m) { setModel(m); setReadAt(Date.now()); }
  }, []);

  const readJobs = useCallback(async () => {
    const r = await getJson('/api/cron/jobs');
    if (!alive.current) return;
    const list = r.ok ? readCronJobs(r.body) : null;
    setGatewayDown(!list);
    setJobs(list);
  }, []);

  const readSide = useCallback(async () => {
    const [cal, queue] = await Promise.all([getJson('/api/hub/calendar'), getJson('/api/hub/queue')]);
    if (!alive.current) return;
    if (cal.ok) setCalendar(readCalendar(cal.body));
    if (queue.ok) setFixing(fixingKeys(queue.body));
  }, []);

  useEffect(() => {
    alive.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first read on mount: the state is set after the fetch resolves, not synchronously
    void readModel();
    void readJobs();
    void readSide();
    return () => { alive.current = false; };
  }, [readModel, readJobs, readSide]);

  // The hub pushes its summary only when it changes: a new one means the model changed too.
  const summaryData = summary?.data;
  const firstSummary = useRef(true);
  useEffect(() => {
    if (summaryData === undefined) return;
    if (firstSummary.current) { firstSummary.current = false; return; }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reread when the hub pushes a new summary: the state is set after the fetch resolves
    void readModel();
  }, [summaryData, readModel]);

  const retry = useCallback(async () => {
    await Promise.all([refreshHubLive(), readModel(), readJobs(), readSide()]);
  }, [readModel, readJobs, readSide]);

  const command = useCallback(async (row: AutomationRow, c: JobCommand) => {
    if (!row.jobId) return false;
    setRefusal(null);
    const req = jobRequest(row.jobId, c);
    const r = await send(req.path, req.method, req.body);
    if (!r.ok) {
      setRefusal({ what: c.kind === 'enable' && !c.on ? 'disable' : c.kind, why: refusalOf(r.status || 502) });
      await readJobs();
      return false;
    }
    if (c.kind === 'run') setRanAt((prev) => ({ ...prev, [row.key]: Date.now() }));
    if (c.kind === 'remove') setRemoved((prev) => new Set(prev).add(row.key));
    await readJobs();
    // The hub reads the gateway on its own round: the run's outcome reaches the model a little later.
    if (c.kind !== 'enable') window.setTimeout(() => { void readModel(); }, 1500);
    return true;
  }, [readJobs, readModel]);

  const feedback = useCallback(async (body: Record<string, unknown>): Promise<FeedbackResult> => {
    const r = await send('/api/hub/feedback', 'POST', body);
    if (!r.ok) return { error: r.error ?? `HTTP ${r.status || 502}`, ref: null };
    await Promise.all([readModel(), refreshHubLive()]);
    return { error: null, ref: feedbackRowId(r.body) };
  }, [readModel]);

  const undo = useCallback(async (ref: string) => {
    const r = await send('/api/hub/feedback', 'POST', undoBody(ref));
    if (!r.ok) return r.error ?? `HTTP ${r.status || 502}`;
    await Promise.all([readModel(), refreshHubLive()]);
    return null;
  }, [readModel]);

  const fix = useCallback(async (key: string) => {
    const r = await send('/api/hub/fix', 'POST', { key });
    const b = r.body as { already?: unknown } | null;
    if (r.ok) setFixing((prev) => new Set(prev).add(key));
    return { ok: r.ok, already: r.ok && b?.already === true, why: r.ok ? null : r.error ?? `HTTP ${r.status || 502}` };
  }, []);

  const rows = useMemo(
    () => withCronJobs(model?.rows ?? [], jobs, describe).filter((r) => !removed.has(r.key)),
    [model, jobs, describe, removed],
  );
  const hubDown = modelFailing || summary?.error !== undefined;
  const clearRefusal = useCallback(() => setRefusal(null), []);

  return { rows, model, readAt, hubDown, gatewayDown, calendar, fixing, ranAt, refusal, clearRefusal, retry, command, feedback, undo, fix };
}
