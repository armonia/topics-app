/**
 * A session of the Claude proxy in the level's terms: the tool it runs as a
 * verb with only a file's name, idle past two minutes is waiting for input,
 * the timeline keeps the summaries in Italian and never the prompts, the cost
 * at the list price, the files two sessions edit, the proxy's own state. The
 * inputs are the proxy's own shapes (`/api/sessions`), placeholder names.
 * @covers HUBBR-13
 */
import { describe, expect, test } from 'bun:test';
import { proxyActivity, proxyConflicts, proxyCostUsd, proxyState, proxyTimeline } from './proxySessionDetail';
import { agentsJobs } from './agentsJobs';

const NOW = new Date(2026, 10, 5, 15, 0, 0).getTime();
const MIN = 60_000;

describe('the proxy session, read', () => {
  test('the tool at work: a verb, a file name and never a path or a command', () => {
    expect(proxyActivity('Read /Users/demo/Projects/acme-web/README.md')).toEqual({ verb: 'read', file: 'README.md' });
    expect(proxyActivity('Edit: src/app.ts')).toEqual({ verb: 'edit', file: 'app.ts' });
    // The proxy cut the path at 60 characters: a cut name is not shown.
    expect(proxyActivity('Read /Users/demo/Projects/acme-web/src/very/long/pa...')).toEqual({ verb: 'read', file: null });
    expect(proxyActivity('Bash cd ~/Projects/acme-web && rm -rf dist')).toEqual({ verb: 'bash', file: null });
    expect(proxyActivity('mcp__gateway__search {"q":1}')).toEqual({ verb: 'mcp', file: null });
    expect(proxyActivity('wait_for_process')).toBeNull();
    expect(proxyActivity(null)).toBeNull();
  });

  test('the timeline: the summaries in Italian, never an input, a tool line or English prose', () => {
    const lines = proxyTimeline([{ timeline: [
      { type: 'input', text: 'PROMPT GREZZO: rifai tutto' },
      { type: 'action', text: 'Bash: cd ~/Projects/acme-web && ls' },
      { type: 'action', text: 'There is no actual work conversation that I can analyze.' },
      { type: 'action', text: '[2026-11-05 11:02] Sono stati aggiornati i test del router di acme-web.' },
      { type: 'action', text: 'Ok.' },
    ] }]);
    expect(lines).toEqual(['Sono stati aggiornati i test del router di acme-web.']);
  });

  test('the cost at the list price of the model, nothing for a model without a price', () => {
    expect(proxyCostUsd('claude-sonnet-5-5', 1_000_000, 0)).toBeGreaterThan(0);
    expect(proxyCostUsd(null, 10, 10)).toBeNull();
  });

  test('the files two sessions edit; a word parsed out of a command is not one', () => {
    expect(proxyConflicts({ conflicts: [{ file: '/Users/demo/acme/src/app.ts', count: 2 }, { file: '-n', count: 2 }, { file: 'x.ts', count: 1 }] }))
      .toEqual([{ file: 'app.ts', path: '/Users/demo/acme/src/app.ts', count: 2 }]);
  });

  test('the proxy answering, with its monitor off, or silent', () => {
    expect(proxyState({ enabled: true, active: [] })).toBe('ok');
    expect(proxyState({ enabled: false })).toBe('monitorOff');
    expect(proxyState(null)).toBe('silent');
  });
});

describe('in the level', () => {
  const proxy = {
    enabled: true,
    active: [
      { id: 'a', account: 'lavoro@example.com', model: 'claude-sonnet-5-5', startedAt: NOW - 30 * MIN, lastActiveAt: NOW - 20 * MIN, requestCount: 5, totalInputTokens: 10, totalOutputTokens: 10, currentActivity: 'Read /x/README.md' },
      { id: 'b', account: 'lavoro@example.com', model: 'claude-haiku-5-5', startedAt: NOW - 3 * MIN, lastActiveAt: NOW - 30_000, requestCount: 1, totalInputTokens: 1, totalOutputTokens: 1, currentActivity: 'Grep foo' },
    ],
    recent: [{ id: 'c', account: 'altro@example.com', model: 'claude-opus-5-5', startedAt: NOW - 120 * MIN, completedAt: NOW - 60 * MIN, duration: 60 * MIN, requestCount: 3, totalInputTokens: 1_000, totalOutputTokens: 2_000,
      timeline: [{ type: 'action', text: 'Ha corretto il calcolo delle ferie di acme-web.' }] }],
    conflicts: [{ file: '/acme/src/app.ts', count: 2 }],
  };
  const view = agentsJobs({ topics: { working: [], awaitingInput: [], finished: [] }, queue: null, diary: null, proxy, now: NOW });

  test('at work: the account, the tool or since when it waits for input', () => {
    const rows = view.running.find((s) => s.id === 'proxy')!.rows;
    const idle = rows.find((r) => r.key.startsWith('proxy:a:'))!;
    expect(idle).toMatchObject({ account: 'lavoro@example.com', idleSince: NOW - 20 * MIN });
    const busy = rows.find((r) => r.key.startsWith('proxy:b:'))!;
    expect(busy).toMatchObject({ idleSince: null, activity: { verb: 'grep', file: null } });
  });

  test('finished: the cost and the timeline; the conflicts and the state of the proxy on the view', () => {
    const done = view.finished.flatMap((s) => s.rows).find((r) => r.key.startsWith('proxy:c:'))!;
    expect(done.costUsd).toBeGreaterThan(0);
    expect(done.timeline).toEqual(['Ha corretto il calcolo delle ferie di acme-web.']);
    expect(view.conflicts).toEqual([{ file: 'app.ts', path: '/acme/src/app.ts', count: 2 }]);
    expect(view.proxyState).toBe('ok');
  });
});
