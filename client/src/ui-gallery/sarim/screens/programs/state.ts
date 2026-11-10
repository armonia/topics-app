/**
 * What the reader changed on the programs of SARIM (slice `sarim.programs`):
 * which ones were disconnected or connected again, the last connection test of
 * each and how many were run, and the connection events of this visit. The
 * flows a program serves and the open cards that go through it are counted
 * from the flows and the live cards, never stored.
 */
import type { OpsFlow, SarimCard } from '../../../../ui/fixtures/sarim-org/types';
import { world } from '../../world';
import type { ProgramEvent, SarimProgram } from '../../../../ui/fixtures/sarim-org/programs';
import type { SarimProgramStateWord } from '../../../../ui/copy/sarim-admin';
import type { ConnectionKind } from '../../../../ui/programs/model';
import type { Tone } from '../../../../ui/types';
import type { ScreenCtx } from '../../../app/kit';
import { openCards as openOf } from '../../model/flows';
import { SP } from '../../paths';

export const PROGRAMS_SLICE = 'sarim.programs';

export interface LiveEvent {
  program: string;
  at: string;
  who: string;
  kind: 'connect' | 'disconnect' | 'test-ok' | 'test-failed';
  why?: string;
}

export interface ProgramsSlice {
  /** Set by hand: `false` after «Scollega», `true` after «Collega». Unset = connected. (allow-italian: quotes the Italian interface) */
  connected: Record<string, boolean>;
  tests: Record<string, { at: string; ok: boolean; why?: string; by: string }>;
  /** Connection tests run in this visit, per program. */
  attempts: Record<string, number>;
  events: LiveEvent[];
}

export const PROGRAMS_INITIAL: ProgramsSlice = { connected: {}, tests: {}, attempts: {}, events: [] };

export function programsSlice(ctx: ScreenCtx) {
  const [raw, set] = ctx.slice<ProgramsSlice>(PROGRAMS_SLICE, PROGRAMS_INITIAL);
  return [{ ...PROGRAMS_INITIAL, ...raw }, set] as const;
}

export const testJobId = (id: string) => `sarim-program-test:${id}`;
export const connectJobId = (id: string) => `sarim-program-connect:${id}`;

export const isConnected = (slice: ProgramsSlice, p: SarimProgram) => slice.connected[p.id] ?? true;

export function programState(ctx: ScreenCtx, slice: ProgramsSlice, p: SarimProgram): SarimProgramStateWord {
  if (ctx.job(testJobId(p.id))?.status === 'running') return 'testing';
  if (ctx.job(connectJobId(p.id))?.status === 'running') return 'connecting';
  if (!isConnected(slice, p)) return 'disconnected';
  const t = slice.tests[p.id];
  return t && !t.ok ? 'failed' : 'connected';
}

export const STATE_TONE: Record<SarimProgramStateWord, Tone> = { connected: 'green', disconnected: 'neutral', testing: 'blue', connecting: 'blue', failed: 'red' };

/** The glyph family of each way of connecting, shared with the programs of the other edition. */
export const LINK_KIND: Record<SarimProgram['link'], ConnectionKind> = { api: 'api', file: 'file', screen: 'pc-agent', browser: 'browser', mailbox: 'imap', public: 'api' };

/** The flows that read or write the program. */
export function flowsUsing(p: SarimProgram): OpsFlow[] {
  return world().opsFlows.filter((f) => f.programs.includes(p.flowName) || f.steps.some((s) => s.actor.kind === 'program' && s.actor.name === p.flowName));
}

/** The steps of a flow done in the program itself. */
export const stepsIn = (flow: OpsFlow, p: SarimProgram) => flow.steps.filter((s) => s.actor.kind === 'program' && s.actor.name === p.flowName);

/** The open cards of the flows that use the program. */
export function openCards(cards: SarimCard[], p: SarimProgram): SarimCard[] {
  const ids = new Set(flowsUsing(p).map((f) => f.id));
  return openOf(cards).filter((c) => ids.has(c.flow));
}

/** A history line of the program for the screen: the seed of the fixture and the events of this visit, newest first. */
export interface HistoryLine {
  id: string;
  program: string;
  at: string;
  who: string;
  what: string;
  tone: Tone;
}

export function historyOf(ctx: ScreenCtx, slice: ProgramsSlice, programs: SarimProgram[]): HistoryLine[] {
  const e = ctx.copy.sarimAdmin.programs.events;
  const tone = (k: ProgramEvent['kind']): Tone => (k === 'test' ? 'green' : k === 'read' ? 'neutral' : k === 'use' ? 'violet' : 'blue');
  const ids = new Set(programs.map((p) => p.id));
  const seed: HistoryLine[] = programs.flatMap((p) => p.history.map((h, i) => ({ id: `${p.id}-${i}`, program: p.id, at: h.at, who: h.who, what: h.what, tone: tone(h.kind) })));
  const live: HistoryLine[] = slice.events.filter((x) => ids.has(x.program)).map((x, i) => ({
    id: `live-${i}`,
    program: x.program,
    at: x.at,
    who: x.who,
    what: x.kind === 'connect' ? e.connected : x.kind === 'disconnect' ? e.disconnected : x.kind === 'test-ok' ? e.testOk : e.testFailed(x.why ?? ''),
    tone: x.kind === 'test-failed' ? 'red' : x.kind === 'disconnect' ? 'amber' : x.kind === 'test-ok' ? 'green' : 'blue',
  }));
  /* A live event is always the newest: the seed ends before the demo's now. */
  return [...live.reverse(), ...seed.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))];
}

/* ---------- actions ---------- */

export function runTest(ctx: ScreenCtx, p: SarimProgram) {
  const c = ctx.copy.sarimAdmin.programs;
  const [slice, set] = programsSlice(ctx);
  const attempt = slice.attempts[p.id] ?? 0;
  const failing = p.firstFails && attempt === 0 ? p.firstFails.step : -1;
  const who = ctx.persona.id;
  ctx.startJob({
    id: testJobId(p.id),
    title: c.jobs.test(p.name),
    steps: p.test.map((label, i) => ({ label, ms: 650, fails: i === failing })),
    onDone: (ok) => {
      const why = ok ? undefined : p.firstFails?.why;
      set((prev) => ({
        ...PROGRAMS_INITIAL,
        ...prev,
        attempts: { ...prev.attempts, [p.id]: attempt + 1 },
        tests: { ...prev.tests, [p.id]: { at: ctx.now, ok, why, by: who } },
        events: [...(prev.events ?? []), { program: p.id, at: ctx.now, who, kind: ok ? 'test-ok' : 'test-failed', why }],
      }));
      ctx.log(ok ? c.logs.testOk(p.name) : c.logs.testFailed(p.name), 'test', SP.program(p.id));
      ctx.toast(ok
        ? { tone: 'ok', title: c.toasts.testOk(p.name), body: c.toasts.testOkBody }
        : { tone: 'error', title: c.toasts.testFailed(p.name), body: why });
    },
  });
}

export function connect(ctx: ScreenCtx, p: SarimProgram) {
  const c = ctx.copy.sarimAdmin.programs;
  const [, set] = programsSlice(ctx);
  const who = ctx.persona.id;
  ctx.startJob({
    id: connectJobId(p.id),
    title: c.jobs.connect(p.name),
    steps: c.jobs.connectSteps.map((label) => ({ label, ms: 600 })),
    onDone: (ok) => {
      if (!ok) return;
      set((prev) => ({
        ...PROGRAMS_INITIAL,
        ...prev,
        connected: { ...prev.connected, [p.id]: true },
        tests: Object.fromEntries(Object.entries(prev.tests ?? {}).filter(([k]) => k !== p.id)),
        events: [...(prev.events ?? []), { program: p.id, at: ctx.now, who, kind: 'connect' }],
      }));
      ctx.log(c.logs.connected(p.name), 'structure', SP.program(p.id));
      ctx.toast({ tone: 'ok', title: c.toasts.connected(p.name), body: c.toasts.connectedBody });
    },
  });
}

export function disconnect(ctx: ScreenCtx, p: SarimProgram) {
  const c = ctx.copy.sarimAdmin.programs;
  const [, set] = programsSlice(ctx);
  const flows = flowsUsing(p);
  const names = flows.map((f) => `«${f.name}»`).join(', ');
  ctx.confirm({
    title: c.confirmDisconnect.title(p.name),
    body: flows.length ? c.confirmDisconnect.body(p.name, names) : c.confirmDisconnect.bodyNoFlows(p.name),
    confirmLabel: c.confirmDisconnect.confirm,
    tone: 'danger',
    onConfirm: () => {
      set((prev) => ({
        ...PROGRAMS_INITIAL,
        ...prev,
        connected: { ...prev.connected, [p.id]: false },
        events: [...(prev.events ?? []), { program: p.id, at: ctx.now, who: ctx.persona.id, kind: 'disconnect' }],
      }));
      ctx.log(c.logs.disconnected(p.name), 'structure', SP.program(p.id));
      ctx.toast({ tone: 'warn', title: c.toasts.disconnected(p.name), body: c.toasts.disconnectedBody });
    },
  });
}
