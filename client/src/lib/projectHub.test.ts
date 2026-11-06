/**
 * The project row reads the hub's project only when it is recognised as that
 * project, and the menu writes one change at a time in the hub's shape.
 * @covers HUBBR-16
 */
import { describe, expect, it } from 'bun:test';
import {
  agentOpen, budgetChoices, holdWhy, matchHubProject, modelMix, opusAdvice, overBudget, projectSettingsBody, providerShares, readHubProjects,
  restartParts, shortTokens, shownShare, weekShare, working, workingOutside,
} from './projectHub';

const live = {
  projects: [
    { name: 'acme-web', title: 'Acme web', dir: '~/.topics/worktrees/acme-web/k3f9', state: 'attivo', why: '', total: 38.4, claude: 30, budgetPct: 40, priority: 'alta', agents: { count: 2 } },
    { name: 'studio-x', dir: null, state: 'frenato', why: 'studio-x: 25% della settimana Claude, budget 25%', waitUntil: 1_700_000_000_000, total: 27, claude: 25, budgetPct: 25, priority: 'normale' },
    { name: 'acme-api', dir: '~/Projects/acme-api-brand-kit/studio', state: 'in coda', why: '2 lavori in attesa di partire', total: 0.4, budgetPct: null, priority: 'bassa' },
    { name: 'tmp:/tmp/zgen', dir: '/tmp/zgen', state: 'frenato', total: 3 },
    { name: 'odd', priority: 'urgente', budgetPct: 0, total: 'x' },
    'not a project',
  ],
};

describe('readHubProjects', () => {
  const rows = readHubProjects(live);

  it('keeps the projects, turns the hub states into held and queued, and drops the grouped temporary folders', () => {
    expect(rows.map((r) => r.name)).toEqual(['acme-web', 'studio-x', 'acme-api', 'odd']);
    expect(rows.map((r) => r.hold)).toEqual([null, 'held', 'queued', null]);
  });

  it('an unknown priority reads as normal, a zero or missing cap as no cap, a missing share as zero', () => {
    const odd = rows.find((r) => r.name === 'odd')!;
    expect(odd.priority).toBe('normale');
    expect(odd.budgetPct).toBeNull();
    expect(odd.total).toBe(0);
    expect(odd.title).toBe('odd');
  });

  it('anything that is not the hub answer is no project', () => {
    expect(readHubProjects(null)).toEqual([]);
    expect(readHubProjects({ projects: 'x' })).toEqual([]);
    expect(readHubProjects({ error: 'hub down' })).toEqual([]);
  });
});

describe('matchHubProject', () => {
  const rows = readHubProjects(live);

  it('the folder name is the hub name, wherever the hub last saw an agent', () => {
    expect(matchHubProject(rows, '/Users/someone/Projects/acme-web')?.name).toBe('acme-web');
    expect(matchHubProject(rows, '/home/someone/Projects/acme-web/')?.name).toBe('acme-web');
    expect(matchHubProject(rows, '/Users/someone/work/studio-x')?.name).toBe('studio-x');
    expect(matchHubProject(rows, 'C:\\Work\\acme-api')?.name).toBe('acme-api');
  });

  it("another row's agent in the project's own folder does not lend it that row's brake", () => {
    // The hub's dir is the last agent's cwd: a cross-project row can point at any project's folder.
    const cross = readHubProjects({ projects: [{ name: 'regia', dir: '/Users/someone/Projects/notes-lab', state: 'frenato' }, ...live.projects] });
    expect(matchHubProject(cross, '/Users/someone/Projects/notes-lab')).toBeNull();
    expect(matchHubProject(cross, '/Users/someone/Projects/acme-web')?.name).toBe('acme-web');
  });

  it('a project the hub does not know shows nothing, and a grouped temporary folder is never one', () => {
    expect(matchHubProject(rows, '/Users/someone/Projects/unknown')).toBeNull();
    expect(matchHubProject(rows, '/tmp/zgen')).toBeNull();
    expect(matchHubProject(rows, '/')).toBeNull();
  });
});

describe('the row and the menu', () => {
  it('at the budget exactly as the hub brakes it: the Claude share reaching the cap', () => {
    const [web, studio, api] = readHubProjects(live);
    expect(overBudget(web!)).toBe(false);
    // claude == budget: the hub's gate brakes at >=, so the dot is on.
    expect(overBudget(studio!)).toBe(true);
    expect(overBudget(api!)).toBe(false);
  });

  it('the budget is on the Claude week alone: Codex and Muse are not summed in', () => {
    const [mixed, claudeOnly] = readHubProjects({ projects: [
      { name: 'mixed', claude: 10, codex: 30, total: 40, budgetPct: 25 },
      { name: 'claude-only', claude: 26, codex: 0, total: 26, budgetPct: 25 },
    ] });
    expect(overBudget(mixed!)).toBe(false);
    expect(shownShare(mixed!)).toBe(10);
    expect(overBudget(claudeOnly!)).toBe(true);
    // Without a budget the share shown is the whole week.
    expect(shownShare(readHubProjects({ projects: [{ name: 'free', claude: 2, total: 9 }] })[0]!)).toBe(9);
  });

  it("the hold's reason without the project's own name, and the budget brake as one fact", () => {
    const [, studio, api] = readHubProjects(live);
    expect(holdWhy(studio!)).toEqual({ byBudget: true, why: '', waits: [] });
    expect(holdWhy(api!)).toEqual({ byBudget: false, why: '2 lavori in attesa di partire', waits: [] });
    const noCap = readHubProjects({ projects: [{ name: 'misc-a', state: 'frenato', why: 'misc-a: budget finito' }] })[0]!;
    expect(holdWhy(noCap)).toEqual({ byBudget: false, why: 'budget finito', waits: [] });
  });

  it("any other brake in the hub's short words, without the restart time it appends; a raw gate reason as the accounts it waits on", () => {
    const [short, raw] = readHubProjects({ projects: [
      { name: 'a', state: 'frenato', why: 'codex/lavoro@example.org: esaurito; muse/m@example.org: ritmo', brake: 'Muse sopra ritmo · Codex esaurito → 20:07' },
      { name: 'b', state: 'frenato', why: 'codex/lavoro@example.com: esaurito; claude/casa@example.org: ritmo' },
    ] });
    expect(holdWhy(short!)).toEqual({ byBudget: false, why: 'Muse sopra ritmo · Codex esaurito', waits: [] });
    expect(holdWhy(raw!)).toEqual({ byBudget: false, why: '', waits: ['Codex lavoro', 'Claude casa'] });
  });

  it('the share of the week in whole numbers, a trace as <1', () => {
    expect(weekShare(38.4)).toBe('38');
    expect(weekShare(0.4)).toBe('<1');
    expect(weekShare(0)).toBe('0');
  });

  it('the budget choices keep the one in force when it is not a step', () => {
    // The tray's steps: a hobby project gets 5.
    expect(budgetChoices(null)).toEqual([null, 5, 10, 15, 20, 30]);
    expect(budgetChoices(20)).toEqual([null, 5, 10, 15, 20, 30]);
    expect(budgetChoices(40)).toEqual([null, 5, 10, 15, 20, 30, 40]);
    expect(budgetChoices(3)).toEqual([null, 3, 5, 10, 15, 20, 30]);
  });

  it('one change per write, keyed by the hub name', () => {
    expect(JSON.parse(projectSettingsBody('acme-web', { priority: 'alta' }))).toEqual({ name: 'acme-web', priority: 'alta' });
    expect(JSON.parse(projectSettingsBody('acme-web', { budgetPct: null }))).toEqual({ name: 'acme-web', budgetPct: null });
  });
});

describe('the state as the hub row says it, and the agents', () => {
  const now = new Date(2026, 10, 6, 15, 0).getTime();
  const agent = (o: Record<string, unknown>) => ({ provider: 'claude', model: 'Opus', kind: 'sessione', depth: 0, title: 't', startedAt: now - 3_600_000, lastActivity: now, tokens: 1000, pct: 0.2, open: null, ...o });
  const [busy, quiet] = readHubProjects({ projects: [
    { name: 'busy', state: 'frenato', why: 'busy: 25% della settimana Claude, budget 25%', budgetPct: 25, claude: 25, codex: 3, muse: 0,
      agents: { count: 3, models: [{ model: 'Sonnet', n: 1 }, { model: 'Opus', n: 2 }], opus: 2, opusMs: 600_000, hourTokens: 790_000,
        list: [agent({ open: { url: 'http://127.0.0.1:13333/tab/chat/t-42', via: 'tab Topics' } }), agent({ provider: 'codex', open: { url: 'claude://claude.ai/epitaxy/x', via: 'Claude Code desktop' } }), agent({ open: { url: 'javascript:alert(1)', via: 'x' } })] } },
    { name: 'quiet', claude: 0.4, total: 0.4, lastSeen: { at: now - 3 * 86_400_000, provider: 'codex' }, dirMissing: true },
  ] });

  it('agents at work count before the brake; the ones that are Topics chats are not counted again on the row', () => {
    expect(working(busy!)).toBe(3);
    expect(workingOutside(busy!)).toBe(2);
    expect(working(quiet!)).toBe(0);
    expect(quiet!.lastSeen).toEqual({ at: now - 3 * 86_400_000, provider: 'codex' });
    expect(quiet!.dirMissing).toBe(true);
  });

  it('the share per provider, only the ones that spent; the model mix most used first', () => {
    expect(providerShares(busy!)).toEqual([{ provider: 'claude', pct: 25 }, { provider: 'codex', pct: 3 }]);
    expect(modelMix(busy!.agents!)).toBe('2 Opus · 1 Sonnet');
  });

  it("the Opus advice as the hub gives it: a tenth of the Claude week, or two hours of Opus", () => {
    expect(opusAdvice(busy!)).toEqual({ n: 2, ms: 600_000 });
    const light = readHubProjects({ projects: [{ name: 'l', claude: 3, agents: { count: 1, opus: 1, opusMs: 600_000 } }] })[0]!;
    expect(opusAdvice(light)).toBeNull();
    const long = readHubProjects({ projects: [{ name: 'l', claude: 3, agents: { count: 1, opus: 1, opusMs: 2 * 3_600_000 } }] })[0]!;
    expect(opusAdvice(long)).toEqual({ n: 1, ms: 2 * 3_600_000 });
  });

  it('«Apri»: a Topics chat opens here, the desktop link outside, anything else is no link', () => {
    const [t, d, bad] = busy!.agents!.list;
    expect(agentOpen(t!.open)).toEqual({ kind: 'topic', id: 't-42' });
    expect(agentOpen(d!.open)).toEqual({ kind: 'external', url: 'claude://claude.ai/epitaxy/x' });
    expect(agentOpen(bad!.open)).toBeNull();
  });

  it('the restart time alone today, with the day when the brake lets go another day', () => {
    expect(restartParts(new Date(2026, 10, 6, 20, 7).getTime(), now, 'it-IT')).toEqual({ day: null, time: '20:07' });
    const later = restartParts(new Date(2026, 10, 12, 13, 0).getTime(), now, 'it-IT');
    expect(later.time).toBe('13:00');
    expect(later.day).toBe('gio');
  });

  it('tokens in short words', () => {
    expect(shortTokens(785_799, 'it-IT')).toBe('786 k');
    expect(shortTokens(1_250_000, 'it-IT')).toBe('1,3 M');
    expect(shortTokens(900, 'it-IT')).toBe('900');
  });
});
