/**
 * Agents and jobs as pure reads: the Topics rows, the proxy's sessions, the
 * hub's queue and the workflows of the diary sorted into the running, waiting
 * and finished filters, with no card of the Board listed twice and no raw prompt as a
 * title. Inputs are the services' own shapes, trimmed, with placeholder names.
 * @covers HUBBR-13
 */
import { describe, expect, test } from 'bun:test';
import { agentsJobs, cancelRequest, foldRows, isBoardCard, jobTitle, modelLabel, openingFilter, providerLabel, repairName, startOfDay, workflowSteps, workflowWhat, type JobRow } from './agentsJobs';

// A fixed afternoon, so «today» and «yesterday» do not move with the clock.
const NOW = new Date(2026, 10, 5, 15, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

const noTopics = { working: [], awaitingInput: [], finished: [] };

describe('jobTitle: never the raw prompt', () => {
  test('first readable sentence, without paths, parentheses and files', () => {
    expect(jobTitle('Riprendi il lavoro di acme-api nel repo ~/Projects/acme-api (percorsi assoluti). Stato: PR aperta.'))
      .toBe('Riprendi il lavoro di acme-api');
    expect(jobTitle('leggi client/src/App.tsx e dimmi dove un errore sostituisce la lista'))
      .toBe('Dimmi dove un errore sostituisce la lista');
  });

  test('shouting is calmed, short acronyms stay, a label alone is no title', () => {
    expect(jobTitle('RICERCA SOLO LETTURA (nessuna spesa). Contesto: studio-x')).toBe('');
    expect(jobTitle('Ricerca su FONTI PRIMARIE (italiano). Leggi i testi veri.')).toBe('Ricerca su fonti primarie');
    expect(jobTitle('Rileggi la PR di studio-x')).toBe('Rileggi la PR di studio-x');
  });

  test('a command wrapper, an English prompt and a bare preamble have no title', () => {
    expect(jobTitle('Esegui ESATTAMENTE questo comando via tool bash con yield_time_ms=300000 e attendi')).toBe('');
    expect(jobTitle('Goal: prepare the new account for the studio, up to the payment step')).toBe('');
    expect(jobTitle('Adversarial review (read-only): file ~/x/close.mjs closes the cards')).toBe('');
    expect(jobTitle('Progetto: ~/Projects/acme-web, ramo main')).toBe('');
    expect(jobTitle('--help')).toBe('');
    expect(jobTitle('')).toBe('');
    expect(jobTitle(null)).toBe('');
  });

  // The shapes of the prompts the hub's queue really holds, with placeholder names.
  test('a task kept in a file, a command after a colon: no title, never two sentences glued', () => {
    expect(jobTitle('Esegui il compito descritto in /private/tmp/x/brief-acme.md. Lavora nel repo corrente, non pushare.')).toBe('');
    expect(jobTitle('In ~/Projects/acme-api esegui: bunx wrangler d1 execute acme --remote --json')).toBe('');
  });

  test('where to work comes first in a prompt: it is skipped, the work is the title', () => {
    expect(jobTitle('Nel worktree /private/tmp/acme-wt (ramo feat/x, repo acme-api): rilancia le 3 mutazioni sul gate. Ciascuna deve dare exit 1.'))
      .toBe('Rilancia le 3 mutazioni sul gate');
    expect(jobTitle('In ~/Projects/acme-api esegui questi controlli e riporta esito secco: 1) git status')).toBe('Esegui questi controlli e riporta esito secco');
    expect(jobTitle('Nel repo acme-docs, solo lettura: ricostruisci la PR #72 e la procedura di rollback/redeploy.'))
      .toBe('Ricostruisci la PR #72 e la procedura di rollback/redeploy');
    expect(jobTitle('Progetto ~/Projects/acme-web, ramo landing-v8 (git fetch prima). Anteprima: https://x.example.com. Correggi il retino della hero.'))
      .toBe('Correggi il retino della hero');
    expect(jobTitle('Repo acme/acme-web, worktree già pronto: /private/tmp/wt (ramo fix/x). Lavora solo lì. Non toccare main.')).toBe('');
  });

  test('a role, the rules and a label are not the work', () => {
    expect(jobTitle('Sei un subagente di Jarvis. Rigenera i due PDF del catalogo di studio-x.')).toBe('Rigenera i due PDF del catalogo di studio-x');
    expect(jobTitle('Sei un verificatore avversario: il tuo compito è refutare. Leggi la consegna.')).toBe('');
    expect(jobTitle('Fai SOLO queste tre modifiche di testo (commenti), niente altro, niente commit. 1) Cargo.toml')).toBe('Fai solo queste tre modifiche di testo');
    expect(jobTitle('RICHIESTA DI UTENTE (29/10 02:28, canale docs): rifare la documentazione di acme-docs.')).toBe('Rifare la documentazione di acme-docs');
    expect(jobTitle('BUG URGENTE segnalato da studio-x (28/10): «il login con Google non va». Obiettivo: trovarlo.')).toBe('Il login con Google non va');
  });

  test('an automation sent to repair keeps its name, without the hub notes', () => {
    expect(repairName('Automazione «Backup del Mac» (chiave cron:3ca8e3df), eseguita da OpenClaw. Stato: rotta.')).toBe('Backup del Mac');
    expect(repairName('Automazione «Build: ripartenza lun 26/10 (sync, build) (d5ce1d64): aspetta una» (chiave health:x)')).toBe('Build: ripartenza lun 26/10');
    expect(jobTitle('Automazione «Backup del Mac» (chiave cron:3ca8e3df).')).toBe('');
    expect(repairName('Rigenera gli screenshot')).toBeNull();
  });

  test('a sentence a removed path leaves broken is cut before the break, or dropped', () => {
    expect(jobTitle('Verifica il ramo fix/acme-follow-ups nel worktree /private/tmp/acme (base origin/main).')).toBe('');
    expect(jobTitle('Revisione avversaria in sola lettura di PIANO.md in questa cartella.')).toBe('');
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

describe('isBoardCard: the Board\'s work, with or without a ref', () => {
  test('by ref, by night and by a text that names a card', () => {
    expect(isBoardCard({ ref: 'card:acme/1', task: 'x' })).toBe(true);
    expect(isBoardCard({ night: true, task: 'x' })).toBe(true);
    expect(isBoardCard({ task: 'Gestisci card Topics 803aca76. Obiettivo: aggiungere la variabile.' })).toBe(true);
    expect(isBoardCard({ task: 'Gestisci sequenzialmente card 8c3af963 e poi c0d419c0.' })).toBe(true);
    expect(isBoardCard({ task: "Sei un verificatore avversario. Card Topics che inizia con 'a66a41b2' nel DB." })).toBe(true);
    expect(isBoardCard({ task: 'Card della board Topics «Rilascio di acme-web».' })).toBe(true);
    expect(isBoardCard({ task: 'Rigenera gli screenshot della landing di acme-web' })).toBe(false);
    expect(isBoardCard({ task: 'Una card a testa per i clienti di studio-x' })).toBe(false);
  });
});

describe('workflows: the bar of the phases, the agents and minutes, never the summary prose', () => {
  test('a running run says the phase it is in; an ended one marks every phase', () => {
    const phases = [{ title: 'Scrittura', total: 3, done: 3, failed: 0 }, { title: 'Verifica', total: 2, done: 1, failed: 0 }, { title: 'Consegna', total: 0, done: 0, failed: 0 }];
    expect(workflowSteps(phases, true)).toEqual({ steps: ['done', 'active', 'todo'], step: { n: 2, of: 3, title: 'Verifica' } });
    expect(workflowSteps([{ title: 'A', total: 1, done: 1, failed: 0 }, { title: 'B', total: 1, done: 0, failed: 1 }], false).steps).toEqual(['done', 'failed']);
  });

  test('of the diary summary only the agents and minutes pass', () => {
    expect(workflowWhat('[claude] Rifinisce l orlo e (erosione): · 2 agenti, 108 min')).toEqual({ agents: 2, durationMs: 108 * MIN });
    expect(workflowWhat('1 agente, 43 min')).toEqual({ agents: 1, durationMs: 43 * MIN });
    expect(workflowWhat('[claude] solo prosa')).toEqual({ agents: null, durationMs: null });
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
  const automations = {
    workflows: { byName: [{ name: 'rev', runs: [{ at: NOW - 26 * MIN, agents: 2, durationMs: null, phases: [
      { title: 'Lettura', total: 1, done: 1, failed: 0 }, { title: 'Verifica', total: 2, done: 0, failed: 0 }, { title: 'Consegna', total: 1, done: 0, failed: 0 },
    ] }] }] },
    needsYou: [
      { key: 'lobster:publish', provider: 'lobster', title: 'Pubblica la landing di acme-web', reason: 'aspetta il tuo ok al passo «deploy» da 14 min', since: NOW - 14 * MIN },
      { key: 'cron:x', provider: 'openclaw', title: 'Una automazione rotta', reason: 'ha fallito', since: NOW - HOUR },
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
    awaitingInput: [{ id: 't2', kind: 'topic' as const, label: 'Fix del rate limit', question: 'Porto la fix sul main?', since: NOW - 6 * MIN }],
    finished: [{ id: 'k1', kind: 'terminal' as const, label: 'npm run smoke' }],
  };
  const view = agentsJobs({ topics, queue, diary, proxy, automations, now: NOW });
  const ids = (s: { rows: JobRow[] }[]) => s.flatMap((x) => x.rows.map((r) => r.key));

  test('running: Topics, proxy, the queue running and the workflow running', () => {
    expect(view.running.map((s) => s.id)).toEqual(['topics', 'proxy', 'queue', 'workflows']);
    expect(ids(view.running)).toEqual(['topic:t1', `proxy:p1:${NOW - 18 * MIN}`, 'queue:r1', expect.stringContaining('wf:wf:rev')]);
  });

  test('the running workflow carries its phase and its bar, from the automations', () => {
    const wf = view.running.find((s) => s.id === 'workflows')!.rows[0]!;
    expect(wf).toMatchObject({ agents: 2, steps: ['done', 'active', 'todo'], step: { n: 2, of: 3, title: 'Verifica' } });
  });

  test('waiting: yours oldest first with the question, then the line in the hub order folded, then the ones a quota holds', () => {
    expect(view.waiting.map((s) => s.id)).toEqual(['decide', 'line', 'quota']);
    const decide = view.waiting[0]!.rows;
    expect(decide.map((r) => [r.title, r.question, r.at])).toEqual([
      ['Pubblica la landing di acme-web', 'aspetta il tuo ok al passo «deploy» da 14 min', NOW - 14 * MIN],
      ['Fix del rate limit', 'Porto la fix sul main?', NOW - 6 * MIN],
    ]);
    expect(decide[0]!.hubPage).toBe('#automations/lobster%3Apublish');
    const line = view.waiting.find((s) => s.id === 'line')!.rows;
    expect(line.map((r) => [r.title, r.rank, r.fold ?? 1])).toEqual([['Docs index non risponde', 1, 2], ['Test unit di studio-x', 2, 1]]);
    expect(line[0]!.cancelId).toBe('l1');
    // What each waits on: the first leaves at the next round, the second after the first.
    expect(line[0]!.waitsOn).toEqual({ kind: 'next' });
    expect(line[1]!.waitsOn).toMatchObject({ kind: 'after', row: { title: 'Docs index non risponde' } });
    const quota = view.waiting.find((s) => s.id === 'quota')!.rows;
    expect(quota[0]).toMatchObject({ title: 'Refactor del router, seconda passata', at: NOW + 2 * HOUR, provider: 'Codex', cancelId: 'h1' });
  });

  test('finished: failed on top, then today and yesterday, nothing older than yesterday', () => {
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
    // One proxy session written twice (two models): one row, its latest segment, with its repo as the place.
    const docs = all.filter((r) => r.source === 'proxy' && r.project === 'acme-docs');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.model).toBe('Opus 5.5');
  });

  test('counts are the rows of each filter, and the level opens where you are awaited', () => {
    expect(view.counts).toEqual({
      running: 4,
      waiting: 5,
      finished: view.finished.reduce((n, s) => n + s.rows.length, 0),
    });
    expect(view.decide).toBe(2);
    expect(openingFilter(view)).toBe('waiting');
    expect(openingFilter(agentsJobs({ topics: noTopics, queue, diary, proxy, now: NOW }))).toBe('running');
    expect(openingFilter(agentsJobs({ topics: noTopics, queue, diary, proxy, automations, now: NOW }))).toBe('waiting');
  });

  test('without the hub and the proxy only Topics is listed, and no error', () => {
    const bare = agentsJobs({ topics, queue: null, diary: null, proxy: null, now: NOW });
    expect(ids(bare.running)).toEqual(['topic:t1']);
    expect(ids(bare.waiting)).toEqual(['topic:t2']);
    expect(ids(bare.finished)).toEqual(['terminal:k1']);
    expect(agentsJobs({ topics: noTopics, queue: { items: 'x' }, diary: 7, proxy: [], now: NOW }).counts).toEqual({ running: 0, waiting: 0, finished: 0 });
  });
});

describe('the proxy as it really answers: no repo, the timeline, the same session in both lists', () => {
  // The live proxy fills `repo` with '' and writes a session at work also among the recent ones, as an older segment.
  const proxy = {
    active: [
      { id: 'a1', model: 'claude-sonnet-5-5', repo: '', cwd: '_sys_1', startedAt: NOW - 10 * MIN, requestCount: 82,
        currentActivity: "bash cd /Users/x/Projects/acme-web && sed -n 1,5p a.ts",
        timeline: [{ type: 'input', text: '(turno 9901 · whatsapp · chat privata · Thu 05/11/2026 11:' }, { type: 'action', text: 'bash: cd /tmp/x && ls' }] },
      { id: 'a2', model: 'claude-haiku-5-5', repo: '', cwd: '_sys_2', startedAt: NOW - 5 * MIN, requestCount: 1, currentActivity: null,
        timeline: [{ type: 'input', text: 'prompt grezzo da non mostrare' }] },
    ],
    recent: [
      { id: 'a1', model: 'claude-sonnet-5-5', repo: '', startedAt: NOW - 3 * HOUR, completedAt: NOW - 2 * HOUR, duration: HOUR, requestCount: 300, timeline: [] },
      { id: 'w1', model: 'claude-opus-5-5', repo: '', startedAt: NOW - 2 * HOUR, completedAt: NOW - 90 * MIN, duration: 30 * MIN,
        timeline: [{ type: 'action', text: 'Bash: git -C /Users/x/Projects/acme-a' }, { type: 'input', text: '[Workflow harness — computed task] The task text below was c' }] },
      { id: 'b1', model: 'claude-sonnet-5-5', repo: '', startedAt: NOW - 80 * MIN, completedAt: NOW - 70 * MIN, timeline: [] },
      { id: 'b2', model: 'claude-sonnet-5-5', repo: '', startedAt: NOW - 60 * MIN, completedAt: NOW - 50 * MIN, timeline: [] },
    ],
  };
  const view = agentsJobs({ topics: noTopics, queue: null, diary: null, proxy, now: NOW });
  const rows = [...view.running, ...view.finished].flatMap((s) => s.rows).filter((r) => r.source === 'proxy');

  test('a session at work is only running, never also finished', () => {
    expect(rows.filter((r) => r.key.startsWith('proxy:a1:')).map((r) => r.tone)).toEqual(['live']);
  });

  test('told apart by the channel, the project its commands name, the workflow, never by the prompt', () => {
    const a1 = rows.find((r) => r.key.startsWith('proxy:a1:'))!;
    expect(a1).toMatchObject({ title: '', fallback: 'jarvis', channel: 'WhatsApp', project: 'acme-web' });
    const w1 = rows.find((r) => r.key.startsWith('proxy:w1:'))!;
    // A folder the proxy cut short is not a project.
    expect(w1).toMatchObject({ fallback: 'workflowAgent', project: null });
    expect(rows.find((r) => r.key.startsWith('proxy:a2:'))).toMatchObject({ title: '', fallback: 'proxy', project: null });
    expect(rows.some((r) => r.title.includes('prompt'))).toBe(false);
  });

  test('ended sessions that read the same fold into one (×N)', () => {
    const plain = view.finished.flatMap((s) => s.rows).filter((r) => r.fallback === 'proxy');
    expect(plain.map((r) => r.fold ?? 1)).toEqual([2]);
  });
});

describe('small pieces', () => {
  test('foldRows joins every row with the same title, tone and source, summing what it spent', () => {
    const r = (key: string, title: string): JobRow => ({ key, source: 'queue', tone: 'ok', title, fallback: null, at: null });
    // Twenty identical jobs are one line, wherever they sit in the list.
    expect(foldRows([r('a', 'x'), r('b', 'x'), r('c', 'y'), r('d', 'x')]).map((x) => [x.key, x.fold ?? 1])).toEqual([['a', 3], ['c', 1]]);
    expect(foldRows([r('a', ''), r('b', '')])).toHaveLength(2);
    // Same words in two places are two rows.
    expect(foldRows([{ ...r('a', 'x'), project: 'p' }, { ...r('b', 'x'), project: 'q' }])).toHaveLength(2);
    const [sum] = foldRows([{ ...r('a', 'x'), tokens: 100, requests: 1, durationMs: 5 }, { ...r('b', 'x'), tokens: 50, requests: 2, durationMs: 9 }]);
    expect(sum).toMatchObject({ fold: 2, tokens: 150, requests: 3, durationMs: 9 });
    // A paused job folds only with one paused for the same reason.
    expect(foldRows([{ ...r('a', 'x'), pausedWhy: 'Claude frenato' }, { ...r('b', 'x'), pausedWhy: 'budget finito' }])).toHaveLength(2);
  });

  test('the withdraw goes to the hub queue with the id encoded', () => {
    expect(cancelRequest('a b')).toEqual({ path: '/api/hub/queue?id=a%20b', init: { method: 'DELETE' } });
  });
});
