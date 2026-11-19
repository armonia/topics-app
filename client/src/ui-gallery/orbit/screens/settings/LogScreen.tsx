/**
 * Settings · Registro: the log that cannot be edited, for SARIM. The lines
 * the world already holds (moves of the cards, approval steps and versions of
 * the contracts, readings and tests of the programs, last 30 days) and every
 * action done in the preview, chained by fingerprint. Narrowed with the one
 * filter bar of every list (who, person or agent, what kind, day), with the
 * old tabs kept as saved filters. The words of the shared log page
 * (`ui/team/LogPage`) with SARIM's: «Agenti» and «Programmi» in place of AI (allow-italian: quotes the Italian interface)
 * and robot, «Su cosa» in place of the case.
 */
import { useMemo } from 'react';
import { CalendarDays, Shapes, User, Users } from 'lucide-react';
import type { UiCopy } from '../../../../ui/copy/types';
import { SarimLogPage } from '../../../../ui/sarim/SarimLogPage';
import type { LogRowModel } from '../../../../ui/team/model';
import { NO_BREAK_SPACE } from '../../../../ui/units';
import type { ScreenCtx } from '../../../app/kit';
import { useListFilters, type FilterSchema, type SavedFilter } from '../../../app/filters';
import { chainIsIntact } from '../../../app/screens/team/chain';
import { agoLabel, dayOf, secondsOf, shortDay, timeOf } from '../../../app/screens/team/format';
import { actorOf, sarimLogLines, type SarimLogLine } from '../../model/audit-log';
import { SettingsFrame } from './frame';

const STRUCTURE_KINDS: Array<SarimLogLine['kind']> = ['structure', 'permission', 'test', 'setting'];
const ACCESS_KINDS: Array<SarimLogLine['kind']> = ['access', 'share'];

type ActorKind = 'people' | 'agents' | 'programs';
type ActionKind = 'structure' | 'access' | 'work';

/** Who did it, by kind; a line of the system itself is none of these. */
function actorKindOf(l: SarimLogLine): ActorKind | '' {
  return l.actor.kind === 'person' ? 'people' : l.actor.kind === 'ai' ? 'agents' : l.actor.kind === 'robot' ? 'programs' : '';
}

/** What was done, by kind: the structure and its permissions, an access, the work itself (cards, contracts, documents). */
function actionKindOf(l: SarimLogLine): ActionKind {
  if (STRUCTURE_KINDS.includes(l.kind)) return 'structure';
  return l.actor.kind === 'access' || ACCESS_KINDS.includes(l.kind) ? 'access' : 'work';
}

function schemaFor(copy: UiCopy): FilterSchema<SarimLogLine> {
  const f = copy.sarimAdmin.settings.log;
  return {
    text: (x) => `${x.what} ${x.subject} ${x.detail} ${x.actor.label}`.replaceAll(NO_BREAK_SPACE, ' '),
    fields: [
      { id: 'who', label: f.fields.who, icon: Users, kind: 'choice', get: (x) => actorKindOf(x), valueLabel: (v) => f.actors[v as ActorKind], order: ['people', 'agents', 'programs'] },
      { id: 'person', label: f.fields.person, icon: User, kind: 'choice', get: (x) => x.actorId, valueLabel: (v) => actorOf(v).label },
      { id: 'kind', label: f.fields.kind, icon: Shapes, kind: 'choice', get: (x) => actionKindOf(x), valueLabel: (v) => f.kinds[v as ActionKind], order: ['structure', 'access', 'work'] },
      { id: 'day', label: f.fields.day, icon: CalendarDays, kind: 'date', ops: ['is', 'before', 'after'], get: (x) => dayOf(x.at) },
    ],
  };
}

/** A cell of a CSV, quoted when it has to be. */
const csv = (v: string) => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

interface ChainCheck {
  at: string;
  n: number;
}

/** The words of the log, with SARIM's in place of those that speak of cases. */
function sarimLogCopy(copy: UiCopy): UiCopy {
  const l = copy.team.log;
  const w = copy.sarimAdmin.settings.log;
  return {
    ...copy,
    team: {
      ...copy.team,
      log: {
        ...l,
        columns: { ...l.columns, subject: w.subject },
        exportColumns: { ...l.exportColumns, subject: w.subject },
        kinds: { ...l.kinds, case: w.caseKind },
        fileName: w.fileName,
      },
    },
  };
}

export function LogScreen({ ctx }: { ctx: ScreenCtx }) {
  const copy = sarimLogCopy(ctx.copy);
  const l = copy.team.log;
  const w = ctx.copy.sarimAdmin.settings.log;
  const [check, setCheck] = ctx.ui<ChainCheck | null>('sarim.log.chain', null);

  const lines = sarimLogLines(ctx.state.audit, ctx.copy.sarimAdmin.log);
  const today = dayOf(ctx.now);
  const schema = useMemo(() => schemaFor(ctx.copy), [ctx.copy]);
  /* The tabs the page used to have, kept as saved filters: one press and the filter is on, another and it is off. */
  const presets = useMemo<SavedFilter[]>(() => [
    { id: 'people', name: w.actors.people, tokens: [{ id: 'p1', field: 'who', op: 'is', value: 'people' }] },
    { id: 'agents', name: w.actors.agents, tokens: [{ id: 'p2', field: 'who', op: 'is', value: 'agents' }] },
    { id: 'programs', name: w.actors.programs, tokens: [{ id: 'p3', field: 'who', op: 'is', value: 'programs' }] },
    { id: 'structure', name: w.kinds.structure, tokens: [{ id: 'p4', field: 'kind', op: 'is', value: 'structure' }] },
    { id: 'access', name: w.kinds.access, tokens: [{ id: 'p5', field: 'kind', op: 'is', value: 'access' }] },
  ], [w]);
  const list = useListFilters(ctx, { key: 'sarim.log.filters', items: lines, schema, presets });
  const shown = [...list.items].reverse();

  const whenOf = (x: SarimLogLine) => (dayOf(x.at) === today ? secondsOf(x.at) : `${shortDay(x.at)} ${timeOf(x.at)}`);
  const rows: LogRowModel[] = shown.map((x) => ({
    id: x.id,
    when: whenOf(x),
    actor: x.actor,
    what: x.what,
    subject: x.subject,
    detail: x.detail,
    hash: x.hash,
    live: x.live,
    onOpen: x.path === ctx.path ? undefined : () => ctx.go(x.path),
  }));

  const verified = check !== null && check.n === lines.length;
  const lastHash = lines.length ? lines[lines.length - 1].hash : '';

  const verify = () => {
    ctx.startJob({
      id: 'sarim-log-verify',
      title: l.verifyJob.title,
      steps: [
        { label: l.verifyJob.steps.read, ms: 500 },
        { label: l.verifyJob.steps.hash, ms: 900 },
        { label: l.verifyJob.steps.compare, ms: 600 },
      ],
      onDone: () => {
        if (!chainIsIntact(lines, lines.map((x) => x.hash))) return;
        setCheck({ at: ctx.now, n: lines.length });
        ctx.toast({ tone: 'ok', title: l.verifiedToast(lines.length), body: l.verifiedBody });
      },
    });
  };

  const exportCsv = () => {
    const c = l.exportColumns;
    const header = [c.when, c.who, c.what, c.subject, c.detail, c.kind, c.hash].map(csv).join(';');
    const body = [...shown].reverse().map((x) => [x.at, x.actor.label, x.what, x.subject, x.detail, l.kinds[x.kind], x.hash].map(csv).join(';'));
    const text = [header, ...body].join('\n');
    const file = `${l.fileName}-${today}.csv`;
    const a = document.createElement('a');
    a.href = `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${text}`)}`;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    ctx.toast({ tone: 'ok', title: l.exportToast, body: l.exportBody(shown.length, file) });
  };

  const verifying = ctx.job('sarim-log-verify')?.status === 'running';

  return (
    <SettingsFrame ctx={ctx} section="registro">
      <SarimLogPage
        rows={rows}
        filters={list.bar}
        chain={{
          checked: verified,
          text: verified && check ? `${l.chain.ok(check.n)} · ${l.chain.checked(agoLabel(ctx.copy.team, check.at, ctx.now))}` : l.chain.notChecked,
          last: lastHash.slice(0, 8),
        }}
        copy={copy}
        onVerify={verifying ? false : verify}
        onExport={ctx.allow('export', exportCsv)}
        exportTitle={ctx.deniedTitle('export')}
        phone={ctx.phone}
      />
    </SettingsFrame>
  );
}
