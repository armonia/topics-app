/** @covers USAGE-30: the `?project=<id>` link of the pause alert. */
import { expect, test } from 'bun:test';
import { projectIdFromSearch, projectPathForId, stripProjectParam } from './projectLink';

test('reads the id and ignores an empty or missing one', () => {
  expect(projectIdFromSearch('?project=acme-1a2b3c')).toBe('acme-1a2b3c');
  expect(projectIdFromSearch('?project=')).toBeNull();
  expect(projectIdFromSearch('?topics=a')).toBeNull();
});

test('strips only the project param', () => {
  expect(stripProjectParam('http://x/?project=a&topics=b#h')).toBe('/?topics=b#h');
  expect(stripProjectParam('http://x/?project=a')).toBe('/');
});

test('finds the folder in a quota reading', () => {
  const quota = { projects: [{ projectId: 'a', projectPath: '/p/a' }, { projectId: null, projectPath: null }] } as never;
  expect(projectPathForId(quota, 'a')).toBe('/p/a');
  expect(projectPathForId(quota, 'zz')).toBeNull();
});
