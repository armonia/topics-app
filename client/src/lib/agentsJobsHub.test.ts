/**
 * What the hub sees running outside Topics, as rows of «Agenti e lavori»: the
 * sessions of every provider, the sub-agents, the live workflows with their
 * agents and tokens, why a held job is paused, the projects' icons; a session
 * the hub found in a Topics tab is left out, since Topics lists it already.
 * Inputs are the hub's own shapes (`/api/board`, `/api/live`), placeholder names.
 * @covers HUBBR-13
 */
import { describe, expect, test } from 'bun:test';
import { agentsOutsideTopics, hubIconPath, hubWork } from './agentsJobsHub';
import { agentsJobs } from './agentsJobs';

const NOW = new Date(2026, 10, 5, 15, 0, 0).getTime();
const MIN = 60_000;

const BOARD = {
  work: [
    { id: 'ses:c-1', kind: 'sessione', title: 'Test A/B di acme-web', project: 'acme-web', state: 'in corso', stateText: 'in corso', startedAt: NOW - 20 * MIN, tokens: 1_500_000, icon: '/api/project-icon?name=acme-web' },
    { id: 'ses:c-2', kind: 'sessione', title: 'Lavoro su studio-x', project: 'studio-x', state: 'in corso', stateText: 'aspetta un comando', startedAt: NOW - 5 * MIN, tokens: 2_000 },
    { id: 'ses:c-topics', kind: 'sessione', title: 'Chat in Topics', project: 'acme-api', state: 'in corso', stateText: 'in corso', startedAt: NOW - MIN },
    { id: 'ses:/codex/x.jsonl', kind: 'sessione', title: 'Migra il router', project: 'acme-api', state: 'in corso', stateText: 'in corso', startedAt: NOW - 9 * MIN },
    { id: 'sub:s-1', kind: 'subagente', title: 'Subagente su acme-web', project: 'acme-web', state: 'in corso', stateText: 'in corso', startedAt: NOW - 2 * MIN, tokens: 30_000 },
    { id: 'wf:wf_abc', kind: 'workflow', title: 'Revisione di acme-web', project: 'acme-web', state: 'in corso', stateText: 'in corso', startedAt: NOW - 30 * MIN, agents: 3, tokens: 900_000 },
    { id: 'q:j-q', kind: 'delega', title: 'Refactor', project: '', state: 'in pausa', stateText: 'in pausa: Claude frenato', why: 'Claude frenato', until: NOW + 60 * MIN },
    { id: 'run:wf_old', kind: 'workflow', title: 'Vecchio', state: 'finito' },
  ],
  projects: [{ name: 'acme-web', display: 'Acme Web', icon: '/api/project-icon?name=acme-web' }, { name: 'studio-x', icon: null }],
};

const LIVE = {
  projects: [
    { name: 'acme-web', agents: { count: 3, list: [
      { kind: 'sessione', provider: 'claude', model: 'Opus', cliId: 'c-1', use: { tokens: 1_500_000, pct: 0.7 } },
      { kind: 'sottoagente', provider: 'claude', model: 'Sonnet', cliId: 's-1', depth: 1 },
      { kind: 'workflow', provider: 'claude', cliId: 'w-a', workflow: 'wf_abc', use: { pct: 0.2 } },
      { kind: 'workflow', provider: 'claude', cliId: 'w-b', workflow: 'wf_abc', use: { pct: 0.3 } },
    ] } },
    { name: 'studio-x', agents: { count: 1, list: [{ kind: 'sessione', provider: 'claude', harness: 'jcode', cliId: 'c-2' }] } },
    { name: 'acme-api', agents: { count: 2, list: [
      { kind: 'sessione', provider: 'claude', cliId: 'c-topics', open: { via: 'tab Topics', url: 'x' } },
      { kind: 'codex', provider: 'codex', model: 'GPT', file: '/codex/x.jsonl' },
    ] } },
  ],
};

describe('hubWork', () => {
  const w = hubWork(BOARD, LIVE);

  test('the sessions outside Topics, with who runs them; the one in a Topics tab left out', () => {
    expect(w.sessions.map((s) => [s.key, s.runner, s.title])).toEqual([
      ['hub:ses:c-1', 'Claude', 'Test A/B di acme-web'],
      // The hub's generic title («work on <place>») is left for the view to word.
      ['hub:ses:c-2', 'jcode', ''],
      ['hub:ses:/codex/x.jsonl', 'Codex', 'Migra il router'],
    ]);
    expect(w.sessions[0]).toMatchObject({ model: 'Opus', tokens: 1_500_000, weekPct: 0.7, icon: '/api/project-icon?name=acme-web', onCommand: false });
    expect(w.sessions[1]!.onCommand).toBe(true);
  });

  test('sub-agents and live workflows; the share of the week of a workflow is its agents summed', () => {
    expect(w.subagents.map((s) => [s.title, s.runner, s.tokens])).toEqual([['', 'Claude', 30_000]]);
    expect(w.workflows).toHaveLength(1);
    expect(w.workflows[0]).toMatchObject({ title: 'Revisione di acme-web', agents: 3, tokens: 900_000, runId: 'wf_abc' });
    expect(w.workflows[0]!.weekPct).toBeCloseTo(0.5);
  });

  test('why a held job is paused, by the queue id; the icons by every name of the project', () => {
    expect(w.paused.get('j-q')).toEqual({ why: 'Claude frenato', until: NOW + 60 * MIN });
    expect(hubIconPath(w.icons, 'Acme Web')).toBe('/api/hub/project-icon?name=acme-web');
    expect(hubIconPath(w.icons, 'studio-x')).toBeNull();
  });

  test('the count of agents outside Topics, and nothing from an answer that is not the hub', () => {
    expect(agentsOutsideTopics(LIVE)).toBe(6);
    expect(hubWork(null, null)).toMatchObject({ sessions: [], subagents: [], workflows: [] });
    expect(agentsOutsideTopics('down')).toBe(0);
  });
});

describe('in the level', () => {
  const queue = { items: [{ id: 'j-q', task: 'Refactor del router di studio-x.', status: 'queued', project: 'studio-x', createdAt: NOW - 60 * MIN, waitUntil: NOW + 60 * MIN }] };
  const view = agentsJobs({ topics: { working: [], awaitingInput: [], finished: [] }, queue, diary: null, proxy: null, board: BOARD, live: LIVE, now: NOW });

  test('running: the sessions outside Topics, the sub-agents, the live workflow with its agents and tokens', () => {
    const ids = view.running.map((s) => s.id);
    expect(ids).toEqual(['outside', 'subagents', 'workflows']);
    const outside = view.running.find((s) => s.id === 'outside')!.rows;
    expect(outside.map((r) => [r.source, r.runner, r.fallback])).toEqual([['outside', 'Claude', null], ['outside', 'jcode', 'outside'], ['outside', 'Codex', null]]);
    expect(outside[0]).toMatchObject({ hubIcon: '/api/hub/project-icon?name=acme-web', weekPct: 0.7, at: NOW - 20 * MIN });
    const flow = view.running.find((s) => s.id === 'workflows')!.rows[0]!;
    expect(flow).toMatchObject({ source: 'workflow', title: 'Revisione di acme-web', agents: 3, tokens: 900_000 });
  });

  test('waiting: the held job says why the hub holds it', () => {
    const held = view.waiting.find((s) => s.id === 'quota')!.rows[0]!;
    expect(held).toMatchObject({ pausedWhy: 'Claude frenato', queuedAt: NOW - 60 * MIN });
  });

  test('a workflow the diary tells and the hub sees live is one row: the run summary as title, the phases, the hub agents', () => {
    const automations = { workflows: { byName: [{ name: 'rev', runs: [
      { runId: 'wf_abc', at: NOW - 30 * MIN, outcome: 'running', agents: 2, summary: 'Rileggi la landing di acme-web prima del rilascio',
        steps: [{ tokens: 100 }, { tokens: 200 }], phases: [{ title: 'Lettura', total: 1, done: 1, failed: 0 }, { title: 'Verifica', total: 2, done: 0, failed: 0 }] },
      { runId: 'wf_old', at: NOW - 200 * MIN, outcome: 'ok', agents: 1, summary: 'Fix the router in English', steps: [{ tokens: 50 }], phases: [] },
    ] }] } };
    const diary = { items: [
      { at: NOW - 30 * MIN, kind: 'workflow', title: 'Rev', outcome: 'running', ref: 'wf:rev' },
      { at: NOW - 200 * MIN, kind: 'workflow', title: 'Rev', outcome: 'ok', ref: 'wf:rev' },
    ] };
    const v = agentsJobs({ topics: { working: [], awaitingInput: [], finished: [] }, queue: null, diary, automations, proxy: null, board: BOARD, live: LIVE, now: NOW });
    const flows = v.running.find((s) => s.id === 'workflows')!.rows;
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ title: 'Rileggi la landing di acme-web prima del rilascio', agents: 3, tokens: 900_000, step: { n: 2, of: 2, title: 'Verifica' } });
    // A summary in English is no title: the workflow keeps its name, and its agents' tokens summed.
    const old = v.finished.flatMap((s) => s.rows).find((r) => r.source === 'workflow')!;
    expect(old).toMatchObject({ title: 'Rev', tokens: 50 });
  });
});
