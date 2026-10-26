/**
 * @covers CHLOG-01
 */
import { test, expect, describe } from 'bun:test';
import { buildChangelog, parseEntry, isNoise, bucketForType, stripBumpTail } from './changelog-lib.mjs';

describe('isNoise', () => {
  test('drops release bumps, merges and lockfile churn', () => {
    expect(isNoise('chore(release): bump v2.1.99')).toBe(true);
    expect(isNoise('chore: bump versione 2.1.117')).toBe(true);
    expect(isNoise('merge: land feat/x')).toBe(true);
    expect(isNoise('chore(tauri): Cargo.lock dopo build')).toBe(true);
    expect(isNoise('chore(release): ci probe throwaway')).toBe(true);
  });
  test('keeps real work', () => {
    expect(isNoise('feat(chat): nuova cosa')).toBe(false);
    expect(isNoise('fix(browser): bug X + bump v2.1.118')).toBe(false);
  });
});

describe('parseEntry', () => {
  test('classifies types into buckets and extracts scope', () => {
    expect(parseEntry('feat(chat): X')).toMatchObject({ bucket: 'new', scope: 'chat', text: 'X' });
    expect(parseEntry('fix(browser): Y')).toMatchObject({ bucket: 'fixes', scope: 'browser' });
    expect(parseEntry('perf(sidebar): Z')).toMatchObject({ bucket: 'perf' });
    expect(parseEntry('refactor(core): cleanup')).toMatchObject({ bucket: 'internal' });
    expect(parseEntry('harden(browser): drop links')).toMatchObject({ bucket: 'fixes' });
  });
  test('strips a trailing bump tail and bare-hash parenthetical', () => {
    expect(parseEntry('fix(board): sistema Z + bump v2.0.2')).toMatchObject({ text: 'sistema Z' });
    expect(stripBumpTail('a + bump v1.2.3 extra')).toBe('a');
    expect(parseEntry('perf(browser): pausa (052f53ef)')).toMatchObject({ text: 'pausa' });
  });
  test('returns null for noise', () => {
    expect(parseEntry('chore(release): bump v2.1.99')).toBeNull();
    expect(parseEntry('merge: land x')).toBeNull();
  });
  test('flags breaking changes', () => {
    expect(parseEntry('feat(api)!: rework')).toMatchObject({ breaking: true });
  });
});

test('bucketForType maps known + unknown types', () => {
  expect(bucketForType('feat')).toBe('new');
  expect(bucketForType('security')).toBe('fixes');
  expect(bucketForType('perf')).toBe('perf');
  expect(bucketForType('docs')).toBe('internal');
  expect(bucketForType('whatever')).toBe('internal');
});

describe('buildChangelog', () => {
  const commits = [
    { hash: 'h1', date: '2026-01-01', subject: 'feat(chat): aggiunge X' },
    { hash: 'h2', date: '2026-01-01', subject: 'fix(browser): corregge Y' },
    { hash: 'h3', date: '2026-01-02', subject: 'chore(release): bump v2.0.1' }, // boundary → 2.0.1
    { hash: 'h4', date: '2026-01-03', subject: 'perf(sidebar): più veloce' },
    { hash: 'h5', date: '2026-01-03', subject: 'merge: land feature' }, // noise
    { hash: 'h6', date: '2026-01-04', subject: 'fix(board): sistema Z + bump v2.0.2' }, // boundary → 2.0.2 + inline work
    { hash: 'h7', date: '2026-01-05', subject: 'refactor(core): pulizia' }, // trailing → currentVersion
  ];
  const boundaries = new Map([['h3', '2.0.1'], ['h6', '2.0.2']]);
  const out = buildChangelog(commits, boundaries, '2.0.3');

  test('newest-first by semver', () => {
    expect(out.map((v: { version: string }) => v.version)).toEqual(['2.0.3', '2.0.2', '2.0.1']);
  });
  test('commits ship in the version of the bump that follows them', () => {
    const v201 = out.find((v: { version: string }) => v.version === '2.0.1')!;
    expect(v201.sections.new.map((e: { it: string }) => e.it)).toEqual(['aggiunge X']);
    expect(v201.sections.fixes.map((e: { it: string }) => e.it)).toEqual(['corregge Y']);
  });
  test('inline bump work counts, merge noise is dropped', () => {
    const v202 = out.find((v: { version: string }) => v.version === '2.0.2')!;
    expect(v202.sections.perf.map((e: { it: string }) => e.it)).toEqual(['più veloce']);
    expect(v202.sections.fixes.map((e: { it: string }) => e.it)).toEqual(['sistema Z']);
  });
  test('trailing (unbumped) work folds into the current version', () => {
    const v203 = out.find((v: { version: string }) => v.version === '2.0.3')!;
    expect(v203.sections.internal.map((e: { it: string }) => e.it)).toEqual(['pulizia']);
  });
  test('versions with only noise are dropped', () => {
    const noiseOnly = buildChangelog(
      [{ hash: 'a', date: '2026-01-01', subject: 'merge: x' }, { hash: 'b', date: '2026-01-01', subject: 'chore(release): bump v9.9.9' }],
      new Map([['b', '9.9.9']]),
      '9.9.9',
    );
    expect(noiseOnly).toEqual([]);
  });
});
