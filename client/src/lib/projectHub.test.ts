/**
 * The project row reads the hub's project only when it is recognised as that
 * project, and the menu writes one change at a time in the hub's shape.
 * @covers HUBBR-16
 */
import { describe, expect, it } from 'bun:test';
import { budgetChoices, holdWhy, matchHubProject, overBudget, projectSettingsBody, readHubProjects, shownShare, weekShare } from './projectHub';

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
    expect(holdWhy(studio!)).toEqual({ byBudget: true, why: '' });
    expect(holdWhy(api!)).toEqual({ byBudget: false, why: '2 lavori in attesa di partire' });
    const noCap = readHubProjects({ projects: [{ name: 'misc-a', state: 'frenato', why: 'misc-a: budget finito' }] })[0]!;
    expect(holdWhy(noCap)).toEqual({ byBudget: false, why: 'budget finito' });
  });

  it('the share of the week in whole numbers, a trace as <1', () => {
    expect(weekShare(38.4)).toBe('38');
    expect(weekShare(0.4)).toBe('<1');
    expect(weekShare(0)).toBe('0');
  });

  it('the budget choices keep the one in force when it is not a step', () => {
    expect(budgetChoices(null)).toEqual([null, 10, 25, 50]);
    expect(budgetChoices(25)).toEqual([null, 10, 25, 50]);
    expect(budgetChoices(40)).toEqual([null, 10, 25, 40, 50]);
  });

  it('one change per write, keyed by the hub name', () => {
    expect(JSON.parse(projectSettingsBody('acme-web', { priority: 'alta' }))).toEqual({ name: 'acme-web', priority: 'alta' });
    expect(JSON.parse(projectSettingsBody('acme-web', { budgetPct: null }))).toEqual({ name: 'acme-web', budgetPct: null });
  });
});
