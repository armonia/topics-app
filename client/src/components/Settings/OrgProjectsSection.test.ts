import { describe, expect, test } from 'bun:test';
import { scopeProjectsToOrg } from './orgProjects';

/**
 * @covers ORG-PROJECTS-01
 *
 * The bug this closes: the panel used to show every non-incognito project on
 * the installation regardless of which group's page was open. These fix a
 * behaviour, not just a line count, see the module doc for the full story.
 */
describe('scopeProjectsToOrg', () => {
  const armonia = { id: 'org-armonia', name: 'Armonia', path: '/repo/armonia', orgId: 'org-armonia' };
  const personal = { id: 'proj-personal', name: 'scratch', path: '/repo/scratch', orgId: null };
  const hidden = { id: 'proj-hidden', name: 'secret', path: '/repo/secret', orgId: 'org-armonia', incognito: true };
  const all = [armonia, personal, hidden];

  test('keeps only the projects that belong to the requested group', () => {
    expect(scopeProjectsToOrg(all, 'org-armonia')).toEqual([armonia]);
  });

  test('a personal project (no group) never belongs to any group page', () => {
    expect(scopeProjectsToOrg(all, 'org-danceroom')).toEqual([]);
  });

  test('no group selected means nothing to show, not "everything"', () => {
    expect(scopeProjectsToOrg(all, null)).toEqual([]);
  });

  test('an incognito project stays off every group page', () => {
    expect(scopeProjectsToOrg(all, 'org-armonia')).not.toContainEqual(hidden);
  });
});
