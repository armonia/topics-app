/**
 * Agents and jobs as pure reads: the Topics rows, the proxy's sessions, the
 * hub's queue and the workflows of the diary sorted into In corso, In attesa
 * and Finiti, with no card of the Board listed twice and no raw prompt as a
 * title. Inputs are the services' own shapes, trimmed, with placeholder names.
 * @covers HUBBR-13
 */
import { describe, expect, test } from 'bun:test';
import { agentsJobs, cancelRequest, foldRows, jobTitle, modelLabel, openingFilter, providerLabel, startOfDay, type JobRow } from './agentsJobs';

// A fixed afternoon, so «today» and «yesterday» do not move with the clock.
const NOW = new Date(2026, 10, 5, 15, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

const noTopics = { working: [], awaitingInput: [], finished: [] };

describe('jobTitle: never the raw prompt', () => {
  test('first readable sentence, without paths, parentheses and files', () => {
    expect(jobTitle('Riprendi il lavoro di acme-api nel repo ~/Projects/acme-api (percorsi assoluti). Stato: PR aperta.'))
      .toBe('Riprendi il lavoro di acme-api nel repo');
    expect(jobTitle('leggi client/src/App.tsx e dimmi dove un errore sostituisce la lista'))
      .toBe('Leggi e dimmi dove un errore sostituisce la lista');
  });

  test('shouting is calmed, short acronyms stay', () => {
    expect(jobTitle('RICERCA SOLO LETTURA (nessuna spesa). Contesto: studio-x')).toBe('Ricerca solo lettura');
    expect(jobTitle('Rileggi la PR di studio-x')).toBe('Rileggi la PR di studio-x');
  });

  test('a command wrapper, an English prompt and a bare preamble have no title', () => {
    expect(jobTitle('Esegui ESATTAMENTE questo comando via tool bash con yield_time_ms=300000 e attendi')).toBe('');
    expect(jobTitle('Goal: prepare the new account for the studio, up to the payment step')).toBe('');
    expect(jobTitle('Progetto: ~/Projects/acme-web, ramo main')).toBe('');
    expect(jobTitle('')).toBe('');
    expect(jobTitle(null)).toBe('');
  });

  test('a card names itself between the quotes', () => {
    expect(jobTitle('Card della board Topics «Pulizia dei rami di acme-docs». Da fare entro sera.')).toBe('Pulizia dei rami di acme-docs');
  });

  test('a long sentence is cut at a word, with an ellipsis', () => {
    const t = jobTitle('Prepara la bozza del preventivo per studio-x con le tre opzioni di prezzo e il calendario delle consegne previste');
    expect(t.length).toBeLessThanOrEqual(64);
    expect(t.endsWith('…')).toBe(true);
    expect(t).not.toContain('  ');
  });
});

describe('names', () => {
  test('models and providers read as names', () => {
    expect(modelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(modelLabel('claude-opus-5')).toBe('Opus 5');
    expect(modelLabel('gpt-x')).toBe('gpt-x');
    expect(modelLabel(null)).toBeNull();
    expect(providerLabel('muse')).toBe('Muse');
    expect(providerLabel('codex')).toBe('Codex');
    expect(providerLabel('')).toBeNull();
  });
});

describe('agentsJobs: the three filters', () => {
  const queue = {
    items: [
      { id: 'r1', task: 'Rigenera gli screenshot della landing di acme-web', status: 'running', provider: 'muse', project: 'acme-web', createdAt: NOW - 20 * MIN, startedAt: NOW - 5 * MIN },
      { id: 'l2', task: 'Test unit di studio-x', status: 'queued', provider: null, project: 'studio-x', createdAt: NOW - 30 * MIN, priority: 'bassa' },
      { id: 'l1', task: 'Docs index non risponde', status: 'queued', project: 'acme-docs', createdAt: NOW - 50 * MIN },
      { id: 'l1b', task: 'Docs index non risponde', status: 'queued', project: 'acme-docs', createdAt: NOW - 40 * MIN },
      { id: 'h1', task: 'Refactor del router, seconda passata', status: 'queued', provider: 'codex', project: 'studio-x', createdAt: NOW - HOUR, waitUntil: NOW + 2 * HOUR },
      { id: 'c1', task: 'Card della board Topics «Rilascio di acme-web»', ref: 'card:acme/123', status: 'queued', createdAt: NOW - 10 * MIN },
      { id: 'n1', task: 'Ripulisci i log', night: true, status: 'done', createdAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR },
      { id: 'd1', task: 'Esegui ESATTAMENTE questo comando via tool bash', status: 'done', provider: 'codex', project: 'acme-api', createdAt: NOW - 4 * HOUR, startedAt: NOW - 4 * HOUR, endedAt: NOW - 3 * HOUR },
      { id: 'f1', task: 'Backup del Mac', status: 'failed', exit: 1, provider: 'muse', createdAt: NOW - 2 * HOUR, endedAt: NOW - HOUR },
      { id: 'old', task: 'Lavoro di tre giorni fa', status: 'done', createdAt: NOW - 3 * 86_400_000, endedAt: NOW - 3 * 86_400_000 },
    ],
  };
  const diary = {
    items: [
      { at: NOW - 26 * MIN, kind: 'workflow', title: 'Revisione notturna di acme-web', outcome: 'running', what: '2 agenti', ref: 'wf:rev' },
      { at: NOW - 3 * HOUR, kind: 'workflow', title: 'Audit delle dipendenze', outcome: 'ok', what: '2 agenti, 6 min', ref: 'wf:audit' },
      { at: startOfDay(NOW) - 2 * HOUR, kind: 'workflow', title: 'Pulizia della cache', outcome: 'ok', ref: 'wf:cache' },
      { at: NOW - HOUR, kind: 'workflow', title: 'Pubblica la landing', outcome: 'error', ref: 'wf:land' },
      { at: NOW - HOUR, kind: 'auto', title: 'Brief del mattino', outcome: 'ok' },
      { at: NOW - HOUR, kind: 'agente', title: 'Card «Rilascio di acme-web»', outcome: 'ok' },
    ],
  };
  const proxy = {
    active: [{ id: 'p1', model: 'claude-sonnet-5-5', repo: '', cwd: '_sys_1', startedAt: NOW - 18 * MIN, requestCount: 40, totalInputTokens: 1000, totalOutputTokens: 30_000, timeline: [{ type: 'input', text: 'prompt grezzo da non mostrare' }] }],
    recent: [
      { id: 'p2', model: 'claude-opus-5-5', repo: '/w/acme-docs', startedAt: NOW - 2 * HOUR, completedAt: NOW - HOUR, duration: HOUR, requestCount: 12 },
      { id: 'p2', model: 'claude-sonnet-5-5', repo: '/w/acme-docs', startedAt: NOW - 3 * HOUR, completedAt: NOW - 2 * HOUR, duration: HOUR, requestCount: 3 },
      { id: 'p3', model: 'claude-haiku-5-5', repo: '', startedAt: NOW - 4 * 86_400_000, completedAt: NOW - 4 * 86_400_000 },
    ],
  };
  const topics = {
    working: [{ id: 't1', kind: 'topic' as const, label: 'Firma della release v1.1' }],
    awaitingInput: [{ id: 't2', kind: 'topic' as const, label: 'Fix del rate limit' }],
    finished: [{ id: 'k1', kind: 'terminal' as const, label: 'npm run smoke' }],
  };
  const view = agentsJobs({ topics, queue, diary, proxy, now: NOW });
  const ids = (s: { rows: JobRow[] }[]) => s.flatMap((x) => x.rows.map((r) => r.key));

  test('In corso: Topics, proxy, the queue running and the workflow running', () => {
    expect(view.running.map((s) => s.id)).toEqual(['topics', 'proxy', 'queue', 'workflows']);
    expect(ids(view.running)).toEqual(['topic:t1', `proxy:p1:${NOW - 18 * MIN}`, 'queue:r1', expect.stringContaining('wf:wf:rev')]);
  });

  test('In attesa: yours, then the line in the hub order folded, then the ones a quota holds', () => {
    expect(view.waiting.map((s) => s.id)).toEqual(['decide', 'line', 'quota']);
    const line = view.waiting.find((s) => s.id === 'line')!.rows;
    expect(line.map((r) => [r.title, r.rank, r.fold ?? 1])).toEqual([['Docs index non risponde', 1, 2], ['Test unit di studio-x', 2, 1]]);
    expect(line[0]!.cancelId).toBe('l1');
    const quota = view.waiting.find((s) => s.id === 'quota')!.rows;
    expect(quota[0]).toMatchObject({ title: 'Refactor del router, seconda passata', at: NOW + 2 * HOUR, provider: 'Codex', cancelId: 'h1' });
  });

  test('Finiti: failed on top, then today and yesterday, nothing older than yesterday', () => {
    expect(view.finished.map((s) => s.id)).toEqual(['failed', 'today', 'yesterday']);
    const failed = view.finished[0]!.rows.map((r) => r.title);
    expect(failed.sort()).toEqual(['Backup del Mac', 'Pubblica la landing']);
    const today = view.finished[1]!.rows;
    expect(today[0]!.key).toBe('terminal:k1');
    expect(today.map((r) => r.title)).toContain('Audit delle dipendenze');
    expect(view.finished[2]!.rows.map((r) => r.title)).toEqual(['Pulizia della cache']);
    expect(ids(view.finished).some((k) => k.includes('old') || k.includes('p3'))).toBe(false);
  });

  test('no card of the Board, neither by ref nor by night, and no diary agent duplicate', () => {
    const all = [...view.running, ...view.waiting, ...view.finished].flatMap((s) => s.rows);
    expect(all.some((r) => r.key === 'queue:c1' || r.key === 'queue:n1')).toBe(false);
    expect(all.some((r) => r.title.includes('Rilascio'))).toBe(false);
    expect(all.some((r) => r.title === 'Brief del mattino')).toBe(false);
  });

  test('no raw prompt: a job without a readable title falls back, a proxy session too', () => {
    const all = [...view.running, ...view.waiting, ...view.finished].flatMap((s) => s.rows);
    const wrapped = all.find((r) => r.key === 'queue:d1')!;
    expect(wrapped).toMatchObject({ title: '', fallback: 'job', project: 'acme-api', durationMs: HOUR });
    const live = all.find((r) => r.source === 'proxy' && r.tone === 'live')!;
    expect(live).toMatchObject({ title: '', fallback: 'proxy', model: 'Sonnet 5.5', requests: 40, tokens: 31_000 });
    expect(all.some((r) => r.title.includes('prompt grezzo'))).toBe(false);
    // One proxy session written twice (two models): one row, its latest segment, named by its repo.
    const docs = all.filter((r) => r.title === 'acme-docs');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.model).toBe('Opus 5.5');
  });

  test('counts are the rows of each filter, and the level opens where you are awaited', () => {
    expect(view.counts).toEqual({
      running: 4,
      waiting: 4,
      finished: view.finished.reduce((n, s) => n + s.rows.length, 0),
    });
    expect(view.decide).toBe(1);
    expect(openingFilter(view)).toBe('waiting');
    expect(openingFilter(agentsJobs({ topics: noTopics, queue, diary, proxy, now: NOW }))).toBe('running');
  });

  test('without the hub and the proxy only Topics is listed, and no error', () => {
    const bare = agentsJobs({ topics, queue: null, diary: null, proxy: null, now: NOW });
    expect(ids(bare.running)).toEqual(['topic:t1']);
    expect(ids(bare.waiting)).toEqual(['topic:t2']);
    expect(ids(bare.finished)).toEqual(['terminal:k1']);
    expect(agentsJobs({ topics: noTopics, queue: { items: 'x' }, diary: 7, proxy: [], now: NOW }).counts).toEqual({ running: 0, waiting: 0, finished: 0 });
  });
});

describe('small pieces', () => {
  test('foldRows joins only neighbours with the same title, tone and source', () => {
    const r = (key: string, title: string): JobRow => ({ key, source: 'queue', tone: 'ok', title, fallback: null, at: null });
    expect(foldRows([r('a', 'x'), r('b', 'x'), r('c', 'y'), r('d', 'x')]).map((x) => [x.key, x.fold ?? 1])).toEqual([['a', 2], ['c', 1], ['d', 1]]);
    expect(foldRows([r('a', ''), r('b', '')])).toHaveLength(2);
  });

  test('the withdraw goes to the hub queue with the id encoded', () => {
    expect(cancelRequest('a b')).toEqual({ path: '/api/hub/queue?id=a%20b', init: { method: 'DELETE' } });
  });
});
