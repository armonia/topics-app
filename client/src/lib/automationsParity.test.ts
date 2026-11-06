/**
 * What the hub's page told about its automations and Topics now reads too:
 * the freshness of the reading, the tokens per provider and the unmeasured
 * ones, the sources and the hidden jobs, the brakes, every fact of a card
 * (area, «if it breaks», remark, last twenty runs, delivery, proof, who and
 * what it writes, technical details, project, where and steps), the gates
 * kept out of «Decidi tu», the failures in a row, the status filter, the
 * search on who and what, the areas, the run history in full, the scheme
 * step by step and the row that takes a vote back.
 * Inputs are the hub's own shapes, trimmed, with placeholder names.
 * @covers HUBBR-14
 * @covers HUBBR-15
 */
import { describe, expect, test } from 'bun:test';
import {
  areaGroups, failStreak, feedbackRowId, ifBrokenToYou, gatesWaiting, matchesQuery, matchesStatus, readAutomations, sortRows, toDecide, undoBody,
} from './automations';
import { silentSources, usageTotal } from './automationsHead';
import { prettyModel, readCronRuns, runsSummary } from './automationRuns';
import { modelStory, noIds, readGraph } from './automationGraph';
import { readCalendar } from './automationsCalendar';

const NOW = new Date(2026, 10, 5, 22, 26, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

function card(key: string, provider: string, level: string, extra: Record<string, unknown> = {}) {
  return {
    key, provider, level, title: key, reason: level === 'va' ? 'gira come deve' : 'ha fallito', since: null, when: 'ogni ora', next: null,
    last: { at: NOW - 10 * MIN, outcome: level === 'rotto' ? 'error' : 'ok' }, day: [], runsToday: 3,
    feedback: { vote: null, mute: null, open: 0, notes: [] }, fp: 'fp1', tech: { exit: 0 }, ...extra,
  };
}

const DOCS = card('cron:job-docs', 'openclaw', 'rotto', {
  title: 'Indice dei documenti', since: NOW - HOUR,
  history: [{ at: NOW - 10 * MIN, outcome: 'error' }, { at: NOW - 70 * MIN, outcome: 'error' }, { at: NOW - 130 * MIN, outcome: 'ok' }],
  purpose: { area: 'jarvis-agenti', cosaFaPerTe: 'Reindicizza le note.', seSiRompe: 'Attilio potrebbe cercare una nota e non trovarla.' },
  usage: { kind: 'tokens', d1: { muse: 12_000 }, d7: { muse: 80_000, claude: 4_000 } },
  who: 'Muse Spark', means: 'niente, se va tutto bene', project: { name: 'acme-docs', icon: '/api/project-icon?name=acme-docs' },
  where: { icon: 'openclaw', label: 'OpenClaw' }, nextApprox: true,
  flow: { steps: 2, ai: true, nodes: [{ kind: 'step', label: 'legge le note' }, { kind: 'model', label: 'Muse', who: [{ name: 'Muse', brand: 'muse' }, { name: 'Sonnet', brand: 'claude' }] }] },
  tech: { exit: 1, schedule: '0 * * * *', command: 'node reindex.mjs', url: 'javascript:alert(1)' },
  feedback: { vote: { v: 'cambia', at: '2026-11-01T10:00:00Z', note: 'il percorso è cambiato' }, changedSinceVote: true, mute: null, open: 2, notes: [] },
});
const GATE = card('lobster:release', 'lobster', 'te', { title: 'Rilascio', reason: 'aspetta il tuo ok al passo «pubblica»' });
const GH = card('gh:acme/acme-web/nightly.yml', 'github', 'rotto', { tech: { exit: 1, url: 'https://github.com/acme/acme-web/actions/runs/1' }, group: 'prodotti' });
const MAIL = card('cron:job-mail', 'openclaw', 'va', {
  title: 'Avviso mail', group: 'arriva', warn: 'si sta riprendendo dopo 3 errori di fila', usage: { kind: 'unmeasured' },
  last: { at: NOW - MIN, outcome: 'ok', delivered: 'delivered' }, proof: { ok: true, words: 'ultimo avviso alle 22:25' },
  sources: [{ provider: 'openclaw' }, { provider: 'health' }],
});
const DARKROOM = card('launchd:com.example.darkroom', 'launchd', 'rotto', { own: true, purpose: { area: 'computer-app' } });

const MODEL = {
  checkedAt: NOW - MIN, stale: true,
  verdict: { needsYou: 1, broken: 2, runsToday: 40 },
  needsYou: [GATE], broken: [DOCS, GH], groups: [{ id: 'arriva', cards: [MAIL] }],
  own: [DARKROOM],
  cards: Object.fromEntries([GATE, DOCS, GH, MAIL, DARKROOM].map((c) => [c.key, c])),
  usage: { d1: { muse: 12_000 }, d7: { muse: 80_000, claude: 4_000 }, unmeasured: 1, script: 3 },
  footer: {
    sources: [
      { name: 'openclaw', label: 'OpenClaw', ok: true, at: NOW - MIN, pending: false, note: null },
      { name: 'github', label: 'GitHub', ok: false, at: null, pending: false, note: '?' },
      { name: 'pc', label: 'PC di casa', ok: true, at: null, pending: false, note: 'PC dorme' },
    ],
    hidden: { count: 1, why: [{ title: 'Vecchio controllo', reason: 'silenziata fino al 12/11' }] },
  },
  brakes: { 'cron:job-docs': { stateText: 'in pausa fino alle 23:00 perché Claude è al 92%', until: NOW + 34 * MIN } },
  reminders: [{ key: 'cron:rem-pr', reminder: true, who: 'Jarvis su OpenClaw' }],
  tasks: [{ key: 'task:quote', who: null }],
};

describe('the model around the rows', () => {
  const m = readAutomations(MODEL)!;

  test('the last good copy, the tokens per provider, the sources and the hidden ones', () => {
    expect(m.stale).toBe(true);
    expect(m.usage).toEqual({ d1: { muse: 12_000 }, d7: { muse: 80_000, claude: 4_000 }, unmeasured: 1, script: 3 });
    expect(silentSources(m.sources).map((s) => s.name)).toEqual(['github']);
    expect(m.sources.find((s) => s.name === 'pc')!.asleep).toBe(true);
    expect(m.hidden).toEqual([{ title: 'Vecchio controllo', reason: 'silenziata fino al 12/11' }]);
    expect(m.brakes['cron:job-docs']!.text).toContain('Claude è al 92%');
    expect(m.calendarWho).toEqual({ 'cron:rem-pr': 'Jarvis su OpenClaw' });
  });

  test('the computer\'s own apps are read apart, outside the rows', () => {
    expect(m.own.map((r) => [r.key, r.own])).toEqual([['launchd:com.example.darkroom', true]]);
    expect(m.rows.some((r) => r.own)).toBe(false);
  });
});

describe('a card read whole', () => {
  const rows = readAutomations(MODEL)!.rows;
  const docs = rows.find((r) => r.key === 'cron:job-docs')!;
  const mail = rows.find((r) => r.key === 'cron:job-mail')!;

  test('purpose, cost, who and what it writes, project, where and steps', () => {
    expect(docs.area).toBe('jarvis-agenti');
    expect(docs.ifBroken).toBe('Attilio potrebbe cercare una nota e non trovarla.');
    expect(ifBrokenToYou(docs.ifBroken!)).toBe('potresti cercare una nota e non trovarla.');
    expect(usageTotal(docs.usage)).toBe(84_000);
    expect(usageTotal(docs.usage, 'd1')).toBe(12_000);
    expect([docs.who, docs.means, docs.where, docs.nextApprox]).toEqual(['Muse Spark', 'niente, se va tutto bene', 'OpenClaw', true]);
    expect(docs.project).toEqual({ name: 'acme-docs', icon: '/api/project-icon?name=acme-docs' });
    expect(docs.flow!.steps).toBe(2);
    expect(docs.flow!.nodes[1]!.who.map((w) => w.brand)).toEqual(['muse', 'claude']);
    expect(docs.tech).toMatchObject({ schedule: '0 * * * *', command: 'node reindex.mjs' });
  });

  test('a link that is not a web address never becomes one', () => {
    expect(docs.tech.url).toBeNull();
    expect(rows.find((r) => r.system === 'github')!.tech.url).toBe('https://github.com/acme/acme-web/actions/runs/1');
  });

  test('the vote with its note, the change after it and the open notes', () => {
    expect(docs.feedback.vote).toEqual({ v: 'cambia', at: '2026-11-01T10:00:00Z', note: 'il percorso è cambiato' });
    expect(docs.feedback.changedSinceVote).toBe(true);
    expect(docs.feedback.open).toBe(2);
  });

  test('a row in order with a remark, its delivery, its proof and its sources', () => {
    expect(mail.warn).toBe('si sta riprendendo dopo 3 errori di fila');
    expect(mail.delivered).toBe('delivered');
    expect(mail.proof).toEqual({ ok: true, words: 'ultimo avviso alle 22:25' });
    expect(mail.sources).toEqual(['openclaw', 'health']);
    expect(mail.usage).toEqual({ kind: 'unmeasured' });
    // Without an area the old group guesses it, as the hub does.
    expect(mail.area).toBe('posta-avvisi');
    expect(rows.find((r) => r.system === 'github')!.area).toBe('sviluppo-topics');
  });

  test('failed the last N times, from the newest run back', () => {
    expect(failStreak(docs)).toBe(2);
    expect(failStreak(mail)).toBe(0);
  });
});

describe('what the lists show', () => {
  const rows = readAutomations(MODEL)!.rows;

  test('a workflow step waiting for an ok is not in «Decidi tu», and is counted apart', () => {
    expect(rows.find((r) => r.key === 'lobster:release')!.gate).toBe(true);
    expect(toDecide(rows).map((r) => r.key)).toEqual(['cron:job-docs', 'gh:acme/acme-web/nightly.yml']);
    expect(gatesWaiting(rows)).toBe(1);
  });

  test('the status filter: all, the ones in order, the problems', () => {
    expect(rows.filter((r) => matchesStatus(r, 'ok')).map((r) => r.key)).toEqual(['cron:job-mail']);
    expect(rows.filter((r) => matchesStatus(r, 'problems'))).toHaveLength(3);
    expect(rows.filter((r) => matchesStatus(r, 'all'))).toHaveLength(4);
  });

  test('the search finds by who runs it, what it writes and the system\'s name', () => {
    const docs = rows.find((r) => r.key === 'cron:job-docs')!;
    expect(matchesQuery(docs, 'muse spark')).toBe(true);
    expect(matchesQuery(docs, 'va tutto bene')).toBe(true);
    expect(matchesQuery(docs, 'jarvis', 'Jarvis')).toBe(true);
    expect(matchesQuery(docs, 'backup')).toBe(false);
  });

  test('by purpose: the areas with a problem first, each with its counts', () => {
    const groups = areaGroups(rows);
    expect(groups.map((g) => [g.area, g.ok, g.decide, g.broken])).toEqual([
      ['sviluppo-topics', 0, 0, 1],
      ['jarvis-agenti', 0, 0, 1],
      ['manutenzione', 0, 1, 0],
      ['posta-avvisi', 1, 0, 0],
    ]);
  });

  test('the costliest rows first among the ones in order', () => {
    const a = { ...rows.find((r) => r.key === 'cron:job-mail')!, key: 'a', title: 'A', usage: null };
    const b = { ...a, key: 'b', title: 'B', usage: { kind: 'tokens' as const, d1: {}, d7: { claude: 10 } } };
    expect(sortRows([a, b]).map((r) => r.key)).toEqual(['b', 'a']);
  });
});

describe('the runs of a job, in full', () => {
  const runs = readCronRuns({ runs: [
    { at: NOW - 10 * MIN, ms: 400, outcome: 'error', error: 'cartella non trovata\nstack completo', text: null, manual: true, wrote: null, whyNot: 'consegna fallita: timeout' },
    { at: NOW - 70 * MIN, ms: 6100, outcome: 'ok', text: '412 schede', wrote: { channel: 'whatsapp' }, model: 'claude-sonnet-5-5', tokens: 12_400,
      report: { path: '~/.cache/report/2026-11-05.md', text: '# Report\n| a |\n|---|\nTutto bene' } },
    { at: NOW - 130 * MIN, ms: 300, outcome: 'ok', text: null, report: { path: '~/r.md', text: '# Titolo\nRiga vera' } },
  ] })!;

  test('by hand, why it did not write, the error whole', () => {
    expect(runs[0]).toMatchObject({ manual: true, wrote: null, whyNot: 'consegna fallita: timeout', text: 'cartella non trovata', error: 'cartella non trovata\nstack completo' });
  });

  test('where it wrote, the model and its tokens, the report of the day', () => {
    expect(runs[1]).toMatchObject({ wrote: { channel: 'whatsapp' }, model: 'claude-sonnet-5-5', tokens: 12_400, output: '412 schede' });
    expect(runs[1]!.report!.path).toBe('~/.cache/report/2026-11-05.md');
    // A run that says nothing speaks with the first real line of its report.
    expect(runs[2]!.text).toBe('Riga vera');
    expect(runsSummary(runs)).toEqual({ wrote: 1, failed: 1 });
  });

  test('model names read as words', () => {
    expect(prettyModel('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(prettyModel('muse-spark-1.3')).toBe('Muse Spark 1.3');
    expect(prettyModel('openai/gpt-5.6-sol')).toBe('GPT-5.6 Sol');
  });
});

describe('the scheme step by step', () => {
  const g = readGraph({
    run: { at: NOW - 10 * MIN, ms: 4_000, outcome: 'ok' },
    from: ['~/bin/reindex.sh'],
    nodes: [
      { id: 'trigger', kind: 'trigger', label: 'pianificato da OpenClaw', params: [{ k: 'Ripete', v: 'ogni ora' }] },
      { id: 's0', kind: 'step', label: 'legge le note', detail: '~/notes', outcome: 'ok', inferred: true },
      { id: 'model', kind: 'model', label: 'Modello', options: [
        { exec: 'muse', name: 'Muse', model: 'muse-spark-1.3', outcome: 'error', note: 'quota finita' },
        { exec: 'claude', name: 'Claude', model: 'claude-sonnet-5-5', outcome: 'ok', ms: 3_000, tokens: 9_000 },
        { exec: 'codex', name: 'Codex', model: 'gpt-5.6-sol', outcome: null },
      ], io: { in: 'Riassumi le note del gruppo (gruppo 123456789012345678@g.us)', out: 'Fatto', outFrom: 'Claude' } },
      { id: 'deliver', kind: 'deliver', label: 'WhatsApp', outcome: 'ok', at: NOW - 9 * MIN },
      { id: 'x', kind: 'altro', label: 'ignorato' },
    ],
  })!;

  test('the steps in order, the unknown kind left out', () => {
    expect(g.nodes.map((n) => n.kind)).toEqual(['trigger', 'step', 'model', 'deliver']);
    expect(g.nodes[0]!.params).toEqual([{ k: 'Ripete', v: 'ogni ora' }]);
    expect(g.nodes[1]!.inferred).toBe(true);
    expect(g.from).toEqual(['~/bin/reindex.sh']);
  });

  test('who answered, who failed before, who would have come after', () => {
    const s = modelStory(g.nodes[2]!);
    expect(s.kind).toBe('answered');
    expect(s.winner!.exec).toBe('claude');
    expect(s.before.map((o) => o.note)).toEqual(['quota finita']);
    expect(s.after.map((o) => o.exec)).toEqual(['codex']);
    expect(modelStory({ options: g.nodes[2]!.options, whoUnknown: true }).kind).toBe('likely');
    expect(modelStory({ options: [], whoUnknown: false }).kind).toBe('none');
  });

  test('ids of chats never reach the page', () => {
    expect(g.nodes[2]!.asked).not.toContain('123456789012345678');
    expect(noIds('job 3f2a9c1e-1111-2222-3333-444455556666 fatto')).toBe('job fatto');
  });

  test('no nodes, no scheme', () => {
    expect(readGraph({ nodes: [] })).toBeNull();
    expect(readGraph(null)).toBeNull();
  });
});

describe('«Annulla» and the calendar', () => {
  test('the undo row names the id the hub gave the vote', () => {
    expect(feedbackRowId({ ok: true, row: { id: 'fb-7', kind: 'vote' } })).toBe('fb-7');
    expect(feedbackRowId({ ok: false })).toBeNull();
    expect(undoBody('fb-7')).toEqual({ kind: 'undo', ref: 'fb-7' });
  });

  test('a calendar entry carries what it will do and what it writes, never the prompt', () => {
    const [e] = readCalendar({ items: [{ key: 'cron:r1', kind: 'promemoria', title: 'PR', next: NOW + HOUR, says: null, what: 'Ti ricorda la PR.', means: 'un messaggio breve', prompt: 'PROMPT' }] })!;
    expect(e).toMatchObject({ what: 'Ti ricorda la PR.', means: 'un messaggio breve', says: null });
    expect(JSON.stringify(e)).not.toContain('PROMPT');
  });
});
