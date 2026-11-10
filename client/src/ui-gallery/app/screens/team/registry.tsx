/**
 * n15: the log that cannot be edited. Every action anybody did in the preview
 * (`state.audit`) after the month of the seed, newest first, with the filters
 * of the mockup plus person and day, a search, a fingerprint column chained
 * from line to line, a check that recomputes the chain, and an export to CSV.
 */
import type { ReactNode } from 'react';
import { addDays } from '../../../../ui/fixtures/org/clock';
import { PERSONAS } from '../../../../ui/fixtures/org/people';
import { LOG_ACTORS } from '../../../../ui/fixtures/team';
import { NO_BREAK_SPACE } from '../../../../ui/units';
import { LogPage } from '../../../../ui/team/LogPage';
import type { LogFilter, LogModel, LogRowModel, OptionModel } from '../../../../ui/team/model';
import type { ScreenCtx, ScreenDef } from '../../kit';
import { P } from '../../paths';
import { settingsFrame } from '../settings-frame';
import { chainIsIntact } from './chain';
import { dayOf, formatDay, secondsOf, shortDay, timeOf, agoLabel } from './format';
import { allLines, type LogLine } from './logLines';

const STRUCTURE_KINDS: Array<LogLine['kind']> = ['structure', 'permission', 'test', 'setting'];
const ACCESS_KINDS: Array<LogLine['kind']> = ['access', 'share'];

/**
 * The tabs are filters, not boxes: who did it (people, AI, robot) and what was done (the structure, an access)
 * are two questions, so a person who changes a permission shows under both People and Structure. That is why
 * only the all-lines tab carries a number (the mockup n15 has none): numbers on overlapping filters read as
 * parts of a whole and did not add up.
 */
function matches(l: LogLine, f: LogFilter): boolean {
  switch (f) {
    case 'all': return true;
    case 'people': return l.actor.kind === 'person';
    case 'ai': return l.actor.kind === 'ai';
    case 'robot': return l.actor.kind === 'robot';
    case 'structure': return STRUCTURE_KINDS.includes(l.kind);
    case 'access': return l.actor.kind === 'access' || ACCESS_KINDS.includes(l.kind);
  }
}

/** A cell of a CSV, quoted when it has to be. */
const csv = (v: string) => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

interface ChainCheck {
  at: string;
  n: number;
}

export function registryScreen(_p: Record<string, string>, ctx: ScreenCtx): ReactNode {
  const l = ctx.copy.team.log;
  const [filter, setFilter] = ctx.ui<LogFilter>('team.log.filter', 'all');
  const [query, setQuery] = ctx.ui<string>('team.log.query', '');
  const [person, setPerson] = ctx.ui<string>('team.log.person', '');
  const [day, setDay] = ctx.ui<string>('team.log.day', '');
  const [check, setCheck] = ctx.ui<ChainCheck | null>('team.log.chain', null);

  const lines = allLines(ctx.state.audit);
  const today = dayOf(ctx.now);

  /* Filters that come before the tab: the search and the period narrow every tab alike. */
  const q = query.trim().toLowerCase();
  const base = lines.filter((x) => {
    if (person !== '' && x.actorId !== person) return false;
    if (day !== '' && dayOf(x.at) !== day) return false;
    if (q !== '' && !`${x.what} ${x.subject} ${x.detail} ${x.actor.label}`.replaceAll(NO_BREAK_SPACE, ' ').toLowerCase().includes(q)) return false;
    return true;
  });
  const counts: Record<LogFilter, number> = {
    all: base.length,
    people: base.filter((x) => matches(x, 'people')).length,
    ai: base.filter((x) => matches(x, 'ai')).length,
    robot: base.filter((x) => matches(x, 'robot')).length,
    structure: base.filter((x) => matches(x, 'structure')).length,
    access: base.filter((x) => matches(x, 'access')).length,
  };
  const shown = base.filter((x) => matches(x, filter)).reverse();

  const whenOf = (x: LogLine) => (dayOf(x.at) === today ? secondsOf(x.at) : `${shortDay(x.at)} ${timeOf(x.at)}`);
  const rows: LogRowModel[] = shown.map((x) => ({
    id: x.id,
    when: whenOf(x),
    actor: x.actor,
    what: x.what,
    subject: x.subject,
    detail: x.detail,
    hash: x.hash,
    live: x.live,
    /* A line about the log itself has nothing else to open. */
    onOpen: x.path === ctx.path ? undefined : () => ctx.go(x.path),
  }));

  /* The options of the person and day selects, from the lines there are. */
  const actorIds = [...new Set(lines.map((x) => x.actorId))];
  const people: OptionModel[] = [
    { value: '', label: l.allPeople },
    ...actorIds.map((id) => ({
      value: id,
      label: PERSONAS.find((p) => p.id === id)?.name ?? LOG_ACTORS.find((a) => a.id === id)?.label ?? id,
    })),
  ];
  const dayKeys = [...new Set(lines.map((x) => dayOf(x.at)))].sort().reverse();
  const yesterday = addDays(today, -1);
  const days: OptionModel[] = [
    { value: '', label: l.allDays },
    ...dayKeys.map((d) => ({ value: d, label: d === today ? `${l.today} ${shortDay(`${d}T12:00:00+01:00`)}` : d === yesterday ? `${l.yesterday} ${shortDay(`${d}T12:00:00+01:00`)}` : formatDay(d).slice(0, 5) })),
  ];

  const verified = check !== null && check.n === lines.length;
  const lastHash = lines.length ? lines[lines.length - 1].hash : '';

  const verify = () => {
    ctx.startJob({
      id: 'log-verify',
      title: l.verifyJob.title,
      steps: [
        { label: l.verifyJob.steps.read, ms: 500 },
        { label: l.verifyJob.steps.hash, ms: 900 },
        { label: l.verifyJob.steps.compare, ms: 600 },
      ],
      onDone: () => {
        const ok = chainIsIntact(lines, lines.map((x) => x.hash));
        if (!ok) return;
        setCheck({ at: ctx.now, n: lines.length });
        ctx.toast({ tone: 'ok', title: l.verifiedToast(lines.length), body: l.verifiedBody });
      },
    });
  };

  const exportCsv = () => {
    const c = l.exportColumns;
    const header = [c.when, c.who, c.what, c.subject, c.detail, c.kind, c.hash].map(csv).join(';');
    const body = [...shown].reverse().map((x) => [x.at, x.actor.label, x.what, x.subject, x.detail, ctx.copy.team.log.kinds[x.kind], x.hash].map(csv).join(';'));
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

  const job = ctx.job('log-verify');
  const verifying = job?.status === 'running';
  const model: LogModel = {
    rows,
    total: lines.length,
    filter,
    counts,
    query,
    person,
    people,
    day,
    days,
    chain: {
      checked: verified,
      text: verified && check ? `${l.chain.ok(check.n)} · ${l.chain.checked(agoLabel(ctx.copy.team, check.at, ctx.now))}` : l.chain.notChecked,
      last: lastHash.slice(0, 8),
    },
  };

  return settingsFrame(ctx, 'registro', {
    children: (
      <LogPage
        model={model}
        copy={ctx.copy}
        onFilter={setFilter}
        onQuery={setQuery}
        onPerson={setPerson}
        onDay={setDay}
        onClear={() => {
          setFilter('all');
          setQuery('');
          setPerson('');
          setDay('');
        }}
        onVerify={verifying ? false : verify}
        onExport={ctx.allow('export', exportCsv)}
        exportTitle={ctx.deniedTitle('export')}
      />
    ),
  });
}

export const REGISTRY_SCREEN: ScreenDef = {
  id: 'n15',
  path: '/impostazioni/registro',
  org: 'nocera',
  nav: 'settings',
  needs: 'view:settings',
  samples: [P.settings('registro')],
  title: (_p, ctx) => ctx.copy.app.settingsSections.registro,
  render: registryScreen,
};

