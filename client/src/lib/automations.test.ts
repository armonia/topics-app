/**
 * Automations as pure reads: the hub's cards by system with the hidden ones
 * left out, the workflows as read-only rows, the OpenClaw jobs of Topics
 * merged in (the only rows with commands, the switched-off ones added), the
 * 24-hour strip, the verdict and the feedback rows the hub accepts.
 * Inputs are the services' own shapes, trimmed, with placeholder names.
 * @covers HUBBR-14
 * @covers HUBBR-15
 */
import { describe, expect, test } from 'bun:test';
import {
  calendarDays, cronJobId, dayStrip, feedbackBody, fixingKeys, hasCommands, jobRequest, readAutomations, readCalendar,
  readCronJobs, readCronRuns, refusalOf, scheduleParts, systemCounts, systemOf, systemRows, toDecide, toFixCount,
  verdictOf, withCronJobs, workflowTitle,
} from './automations';

const NOW = new Date(2026, 10, 5, 22, 26, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

function card(key: string, provider: string, level: string, extra: Record<string, unknown> = {}) {
  return {
    key, provider, level, title: key, reason: level === 'va' ? 'gira come deve' : 'ha fallito', since: null, when: 'ogni ora', next: null,
    last: { at: NOW - 10 * MIN, outcome: level === 'rotto' ? 'error' : 'ok' }, day: [], runsToday: 3,
    feedback: { vote: null, mute: null, open: 0, notes: [] }, fp: 'fp1', tech: { exit: level === 'rotto' ? 1 : 0 }, ...extra,
  };
}

const JUDGED = {
  needsYou: [card('cron:job-week', 'openclaw', 'te', { since: NOW - 3 * 24 * HOUR, title: 'Riepilogo settimanale' })],
  broken: [
    card('cron:job-docs', 'openclaw', 'rotto', { since: NOW - 70 * MIN, title: 'Indice dei documenti' }),
    card('launchd:com.example.backup', 'launchd', 'rotto', { since: NOW - 18 * HOUR, title: 'Backup del Mac' }),
  ],
  groups: [
    { id: 'avvisi', cards: [card('cron:job-mail', 'openclaw', 'va', { title: 'Avviso mail importanti', next: NOW + 5 * MIN })] },
    { id: 'macchine', cards: [
      card('launchd:com.example.memlog', 'launchd', 'va', { next: NOW + 2 * MIN, title: 'Memoria del Mac' }),
      card('launchd:com.example.off', 'launchd', 'nascosto'),
      card('gh:acme/acme-web/nightly.yml', 'github', 'va'),
      card('health:docs', 'health', 'va'),
      card('x:unknown', 'altro', 'va'),
    ] },
  ],
};

// The hub's `cards` is an index of everything, the computer's own apps and the
// tasks included; only the judged lists above make rows.
const OWN = card('launchd:com.example.darkroom', 'launchd', 'rotto', { own: true, purpose: { area: 'computer-app' } });
const TASK = card('cron:task-quote', 'openclaw', 'te', { kind: 'compito', title: 'Chiedere il preventivo a studio-x' });

const MODEL = {
  checkedAt: NOW - MIN,
  verdict: { needsYou: 1, broken: 2, runsToday: 412 },
  ...JUDGED,
  own: [OWN],
  tasks: [TASK],
  cards: Object.fromEntries([...JUDGED.needsYou, ...JUDGED.broken, ...JUDGED.groups.flatMap((g) => g.cards), OWN, TASK].map((c) => [c.key, c])),
  workflows: { byName: [{ name: 'audit-dipendenze', runs: [{ runId: 'wf_1', at: NOW - 2 * HOUR, outcome: 'ok', durationMs: 6 * MIN, agents: 2 }, { runId: 'wf_2', at: NOW - HOUR, outcome: 'error', durationMs: MIN, agents: 1 }] }] },
};

describe('readAutomations: the hub model as rows by system', () => {
  test('hidden and unknown cards stay out, the workflows come in read-only', () => {
    const m = readAutomations(MODEL)!;
    expect(m.rows.map((r) => r.key).sort()).toEqual([
      'cron:job-docs', 'cron:job-mail', 'cron:job-week', 'gh:acme/acme-web/nightly.yml', 'health:docs',
      'launchd:com.example.backup', 'launchd:com.example.memlog', 'workflow:audit-dipendenze',
    ]);
    const wf = m.rows.find((r) => r.system === 'workflow')!;
    expect(wf.title).toBe('Audit dipendenze');
    expect(wf.votable).toBe(false);
    expect(wf.last.outcome).toBe('error');
    expect(wf.workflowRuns.map((r) => r.runId)).toEqual(['wf_2', 'wf_1']);
    expect(m.runsToday).toBe(412);
  });

  test('the computer\'s own apps and the tasks stay out: «Decidi tu» counts what the sidebar counts', () => {
    const m = readAutomations(MODEL)!;
    expect(m.rows.some((r) => r.key === OWN.key || r.key === TASK.key)).toBe(false);
    expect(verdictOf(m.rows, NOW).toFix).toBe(toFixCount(MODEL.verdict)!);
    expect(toDecide(m.rows)).toHaveLength(3);
  });

  test('a source the hub cannot read stays in, under its system, as the summary counts it', () => {
    const source = card('source:workflows', 'workflows', 'te', { title: 'Non riesco a leggere Workflow' });
    const m = readAutomations({ cards: { [source.key]: source }, needsYou: [source], broken: [], groups: [] })!;
    expect(m.rows.map((r) => [r.key, r.system])).toEqual([['source:workflows', 'workflow']]);
    expect(verdictOf(m.rows, NOW).toFix).toBe(toFixCount({ needsYou: 1, broken: 0 })!);
  });

  test('not the hub answer: null', () => {
    expect(readAutomations({ broken: [] })).toBeNull();
    expect(readAutomations(null)).toBeNull();
  });

  test('systems: OpenClaw and its health findings are Jarvis, launchd and the desktop app are Mac', () => {
    expect(systemOf('openclaw')).toBe('jarvis');
    expect(systemOf('health')).toBe('jarvis');
    expect(systemOf('launchd')).toBe('mac');
    expect(systemOf('desktop')).toBe('mac');
    expect(systemOf('lobster')).toBe('workflow');
    expect(systemOf('workflows')).toBe('workflow');
    expect(systemOf('findings')).toBe('jarvis');
    expect(systemOf('board')).toBeNull();
  });
});

describe('commands only on the OpenClaw jobs', () => {
  const rows = readAutomations(MODEL)!.rows;
  const jobs = readCronJobs({ jobs: [
    { id: 'job-docs', name: 'Indice dei documenti', enabled: true, schedule: { kind: 'every', everyMs: HOUR } },
    { id: 'job-mail', name: 'Avviso mail importanti', enabled: true },
    { id: 'job-old', name: 'Vecchio riepilogo dei costi', enabled: false, schedule: { kind: 'cron', expr: '0 8 * * 1' } },
  ] });

  test('a job id only on an OpenClaw key', () => {
    expect(cronJobId('cron:job-docs')).toBe('job-docs');
    expect(cronJobId('launchd:com.example.backup')).toBeNull();
    expect(rows.find((r) => r.key === 'health:docs')!.jobId).toBeNull();
  });

  test('the gateway says on or off, and the switched-off job the hub hides comes back as a row', () => {
    const merged = withCronJobs(rows, jobs);
    expect(merged.find((r) => r.key === 'cron:job-docs')!.enabled).toBe(true);
    const old = merged.find((r) => r.key === 'cron:job-old')!;
    expect(old.enabled).toBe(false);
    expect(old.system).toBe('jarvis');
    expect(hasCommands(old)).toBe(true);
    // launchd and GitHub never: nothing here can run or stop them.
    expect(merged.filter(hasCommands).map((r) => r.key).sort()).toEqual(['cron:job-docs', 'cron:job-mail', 'cron:job-old']);
    // The week summary is not in the gateway's list: no word on it, no command.
    expect(hasCommands(merged.find((r) => r.key === 'cron:job-week')!)).toBe(false);
    // The hub does not word the schedule of a job it hides: the caller's words do.
    expect(old.when).toBeNull();
    const worded = withCronJobs(rows, jobs, (j) => `schedule of ${j.id}`);
    expect(worded.find((r) => r.key === 'cron:job-old')!.when).toBe('schedule of job-old');
    expect(worded.find((r) => r.key === 'cron:job-docs')!.when).toBe(merged.find((r) => r.key === 'cron:job-docs')!.when);
  });

  test('gateway down: no list, no command anywhere', () => {
    expect(readCronJobs({ jobs: [], warning: 'Gateway error' })).toEqual([]);
    expect(withCronJobs(rows, null).filter(hasCommands)).toEqual([]);
  });

  test('a switched-off job sorts last in its system', () => {
    const jarvis = systemRows(withCronJobs(rows, jobs), 'jarvis').map((r) => r.key);
    expect(jarvis[0]).toBe('cron:job-docs');
    expect(jarvis.at(-1)).toBe('cron:job-old');
  });

  test('the three commands, as the Topics cron routes take them', () => {
    expect(jobRequest('job-docs', { kind: 'run' })).toEqual({ path: '/api/cron/jobs/job-docs/run', method: 'POST' });
    expect(jobRequest('job-docs', { kind: 'enable', on: false })).toEqual({ path: '/api/cron/jobs/job-docs', method: 'PATCH', body: { enabled: false } });
    expect(jobRequest('job-docs', { kind: 'remove' })).toEqual({ path: '/api/cron/jobs/job-docs', method: 'DELETE' });
    expect(refusalOf(502)).toBe('gateway');
    expect(refusalOf(409)).toBe('notRun');
    expect(refusalOf(400)).toBe('refused');
  });

  test('the schedule of a job the hub does not describe', () => {
    expect(scheduleParts(jobs?.[0])).toEqual({ kind: 'hours', n: 1 });
    expect(scheduleParts(jobs?.[2])).toEqual({ kind: 'expr', expr: '0 8 * * 1' });
    expect(scheduleParts(undefined)).toBeNull();
  });
});

describe('what needs fixing', () => {
  const rows = readAutomations(MODEL)!.rows;

  test('«Decidi tu» lists the broken and the ones waiting on you, oldest first', () => {
    expect(toDecide(rows).map((r) => r.key)).toEqual(['cron:job-week', 'launchd:com.example.backup', 'cron:job-docs']);
  });

  test('the verdict counts the same rows, and the next run is the soonest one ahead', () => {
    const v = verdictOf(rows, NOW);
    expect(v).toMatchObject({ toFix: 3, decide: 1, broken: 2, ok: 5, total: 8 });
    expect(v.next).toEqual({ title: 'Memoria del Mac', at: NOW + 2 * MIN });
  });

  test('per system, with what needs fixing', () => {
    expect(systemCounts(rows)).toEqual([
      { system: 'jarvis', total: 4, toFix: 2 },
      { system: 'mac', total: 2, toFix: 1 },
      { system: 'github', total: 1, toFix: 0 },
      { system: 'workflow', total: 1, toFix: 0 },
    ]);
  });

  test('the sidebar row counts the broken plus the ones to decide, never the «ok»', () => {
    expect(toFixCount({ needsYou: 1, broken: 2, ok: 81 })).toBe(3);
    expect(toFixCount({ needsYou: 0, broken: 0, ok: 81 })).toBe(0);
    expect(toFixCount({ error: 'down' })).toBeNull();
  });
});

describe('the last 24 hours', () => {
  test('one cell per hour, the last the hour now, the worst run of each', () => {
    const cells = dayStrip([
      { at: NOW - 10 * MIN, outcome: 'error' },
      { at: NOW - 20 * MIN, outcome: 'ok' },
      { at: NOW - 70 * MIN, outcome: 'ok' },
      { at: NOW - 30 * HOUR, outcome: 'error' },
    ], NOW);
    expect(cells).toHaveLength(24);
    expect(cells[23]).toBe('error');
    expect(cells[22]).toBe('ok');
    expect(cells.slice(0, 22).every((c) => c === 'none')).toBe(true);
  });
});

describe('votes, notes and silences: the rows the hub feedback log accepts (HUBBR-15)', () => {
  const row = { key: 'cron:job-docs', fp: 'fp1' };

  test('«Va bene» is a vote without words', () => {
    expect(feedbackBody('ok', row, '', NOW)).toEqual({ kind: 'vote', key: 'cron:job-docs', fp: 'fp1', v: 'ok' });
  });

  test('«Da cambiare», «Nota» and «Segnala» need words, as the hub does', () => {
    expect(feedbackBody('cambia', row, '  ', NOW)).toBeNull();
    expect(feedbackBody('cambia', row, 'il percorso è cambiato', NOW)).toEqual({ kind: 'vote', key: 'cron:job-docs', fp: 'fp1', v: 'cambia', note: 'il percorso è cambiato' });
    expect(feedbackBody('nota', row, 'serve alla ricerca', NOW)).toMatchObject({ kind: 'note', note: 'serve alla ricerca' });
    expect(feedbackBody('segnala', row, 'scrive due volte', NOW)).toMatchObject({ kind: 'complaint', note: 'scrive due volte' });
  });

  test('«Non avvisarmi più» for some days or for good, always with a why', () => {
    expect(feedbackBody('muta', row, '', NOW)).toBeNull();
    expect(feedbackBody('muta', row, 'rumore', NOW, 7)).toMatchObject({ kind: 'mute', why: 'rumore', until: new Date(NOW + 7 * 86_400_000).toISOString() });
    expect(feedbackBody('muta', row, 'rumore', NOW, null)).toMatchObject({ kind: 'mute', until: null });
  });

  test('the vote and the notes read back from the model', () => {
    const voted = card('cron:job-docs', 'openclaw', 'rotto', {
      feedback: { vote: { v: 'ok', at: '2026-10-21T10:00:00Z', fp: 'fp1' }, mute: { until: null, why: 'rumore' }, notes: [{ at: '2026-10-21T10:00:00Z', note: 'serve', kind: 'note' }, { at: null, note: '', kind: 'note' }] },
    });
    const m = readAutomations({ cards: { [voted.key]: voted }, broken: [voted] })!;
    expect(m.rows[0]!.feedback).toEqual({
      vote: { v: 'ok', at: '2026-10-21T10:00:00Z', note: null },
      mute: { until: null, why: 'rumore' },
      notes: [{ at: '2026-10-21T10:00:00Z', note: 'serve', kind: 'note' }],
    });
  });
});

describe('runs, fixes and the calendar', () => {
  test('a run says its first line, the error when it failed', () => {
    expect(readCronRuns({ runs: [
      { at: NOW - 10 * MIN, ms: 400, outcome: 'error', error: 'cartella non trovata\nstack…', text: 'x' },
      { at: NOW - 70 * MIN, ms: 6100, outcome: 'ok', text: '412 schede, 3 nuove' },
    ] })).toEqual([
      { at: NOW - 10 * MIN, ms: 400, outcome: 'error', text: 'cartella non trovata' },
      { at: NOW - 70 * MIN, ms: 6100, outcome: 'ok', text: '412 schede, 3 nuove' },
    ]);
    expect(readCronRuns({ ok: false })).toBeNull();
  });

  test('an agent already on a key, from the queue', () => {
    expect([...fixingKeys({ items: [{ ref: 'cron:job-docs', status: 'running' }, { ref: 'cron:job-mail', status: 'done' }, { status: 'queued' }] })]).toEqual(['cron:job-docs']);
  });

  test('the calendar by day, the past left out, the prompt never read', () => {
    const items = readCalendar({ items: [
      { key: 'cron:r1', kind: 'promemoria', title: 'Chiudere la PR di acme-api', next: NOW + HOUR, says: 'WhatsApp', prompt: 'PROMPT GREZZO' },
      { key: 'cron:r2', kind: 'promemoria', title: 'Passato', next: NOW - HOUR },
      { key: 'task:t1', kind: 'compito', title: 'Preventivo di studio-x', next: NOW + 4 * 24 * HOUR },
      { key: 'task:t2', kind: 'compito', title: 'Senza data', next: null },
    ] })!;
    expect(JSON.stringify(items)).not.toContain('PROMPT GREZZO');
    const days = calendarDays(items, NOW);
    expect(days.map((d) => [d.offset, d.items.map((i) => i.key)])).toEqual([[0, ['cron:r1']], [4, ['task:t1']], [null, ['task:t2']]]);
    expect(calendarDays(items, NOW, 'compito').flatMap((d) => d.items.map((i) => i.key))).toEqual(['task:t1', 'task:t2']);
  });

  test('a workflow slug reads as words', () => {
    expect(workflowTitle('revisione_di-acme')).toBe('Revisione di acme');
  });
});
