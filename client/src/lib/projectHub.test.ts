/**
 * The project row reads the hub's project only when it is recognised as that
 * project, and the menu writes one change at a time in the hub's shape.
 * @covers HUBBR-16
 */
import { describe, expect, it } from 'bun:test';
import { budgetChoices, matchHubProject, overBudget, projectSettingsBody, readHubProjects, weekShare } from './projectHub';

const live = {
  projects: [
    { name: 'acme-web', title: 'Acme web', dir: '~/Projects/acme-web', state: 'attivo', why: '', total: 38.4, budgetPct: 40, priority: 'alta', agents: { count: 2 } },
    { name: 'studio-x', dir: null, state: 'frenato', why: 'studio-x: 27% della settimana Claude, budget 25%', waitUntil: 1_700_000_000_000, total: 27, budgetPct: 25, priority: 'normale' },
    { name: 'acme-api', dir: '~/Projects/acme-api/.claude/worktrees/fix', state: 'in coda', why: '2 lavori in attesa di partire', total: 0.4, budgetPct: null, priority: 'bassa' },
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

  it('the same folder, with the home written as ~, is the project', () => {
    expect(matchHubProject(rows, '/Users/someone/Projects/acme-web')?.name).toBe('acme-web');
    expect(matchHubProject(rows, '/home/someone/Projects/acme-web/')?.name).toBe('acme-web');
  });

  it('the same name counts only when the hub knows no folder or its folder lies inside the project', () => {
    expect(matchHubProject(rows, '/Users/someone/work/studio-x')?.name).toBe('studio-x');
    expect(matchHubProject(rows, '/Users/someone/Projects/acme-api')?.name).toBe('acme-api');
    // Same name, a folder somewhere else: another project that happens to share the name.
    expect(matchHubProject(rows, '/Users/someone/elsewhere/acme-web')).toBeNull();
    expect(matchHubProject(rows, '/Users/someone/archive/acme-api')).toBeNull();
  });

  it('a project the hub does not know shows nothing, and /private/tmp is /tmp', () => {
    expect(matchHubProject(rows, '/Users/someone/Projects/unknown')).toBeNull();
    const tmp = readHubProjects({ projects: [{ name: 'p', dir: '/tmp/e2e/p' }] });
    expect(matchHubProject(tmp, '/private/tmp/e2e/p')?.name).toBe('p');
    const win = readHubProjects({ projects: [{ name: 'w', dir: 'C:\\Temp\\w' }, { name: 'v', dir: null }] });
    expect(matchHubProject(win, 'C:\\Temp\\w')?.name).toBe('w');
    expect(matchHubProject(win, 'C:\\Temp\\v')?.name).toBe('v');
  });
});

describe('the row and the menu', () => {
  it('over budget only past the cap you set', () => {
    const [web, studio, api] = readHubProjects(live);
    expect(overBudget(web!)).toBe(false);
    expect(overBudget(studio!)).toBe(true);
    expect(overBudget(api!)).toBe(false);
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
