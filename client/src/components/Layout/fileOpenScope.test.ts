/**
 * Which window handles an open-file / open-diff event when the grid is split:
 * exactly one, chosen by explicit target first and focus second, never all.
 *
 * @covers LAYOUT-01
 */
import { describe, test, it, expect } from 'bun:test';
import { shouldHandleOpenFile, shouldHandleOpenDiff } from './fileOpenScope';

describe('shouldHandleOpenFile — open-file event scoping (no "opens on all splits")', () => {
  const A = 'project:/Users/me/a';
  const B = 'project:/Users/me/b';

  test('explicit topicId routes to the matching window only', () => {
    expect(shouldHandleOpenFile({ topicId: A }, A, A)).toBe(true);
    // the OTHER project window in split view must ignore the same global event
    expect(shouldHandleOpenFile({ topicId: A }, B, A)).toBe(false);
  });

  test('topicId wins over focus — opens in the target even if another window is focused', () => {
    expect(shouldHandleOpenFile({ topicId: A }, A, B)).toBe(true);
    expect(shouldHandleOpenFile({ topicId: A }, B, B)).toBe(false);
  });

  test('no topicId (e.g. breadcrumb) falls back to the focused window', () => {
    expect(shouldHandleOpenFile({}, A, A)).toBe(true);
    expect(shouldHandleOpenFile({}, B, A)).toBe(false);
    expect(shouldHandleOpenFile({ topicId: null }, A, A)).toBe(true);
    expect(shouldHandleOpenFile({ topicId: undefined }, A, A)).toBe(true);
  });

  test('no topicId and nothing focused → nobody handles it (no phantom open)', () => {
    expect(shouldHandleOpenFile({}, A, null)).toBe(false);
  });

  test('exactly one window handles a given event across a split (the invariant)', () => {
    const windows = [A, B];
    const handlers = windows.filter((w) => shouldHandleOpenFile({ topicId: A }, w, A));
    expect(handlers).toEqual([A]); // never both, never zero when target is open
  });
});

// ── open-file-diff: la guardia che mancava ─────────────────────────────────
//
// Con due finestre di progetto affiancate, un click sul pannello Git di B
// apriva la tab diff ANCHE in A. Il listener gemello di `open-file` aveva lo
// scoping, questo no.
describe('shouldHandleOpenDiff', () => {
  const toPaneId = (p: string) => `project:${p}`;
  const WIN_A = 'project:/proj/a';
  const WIN_B = 'project:/proj/b';

  it('la finestra del progetto bersaglio lo gestisce', () => {
    expect(shouldHandleOpenDiff({ projectPath: '/proj/b' }, WIN_B, null, toPaneId)).toBe(true);
  });

  it("l'ALTRA finestra NON lo gestisce (è il bug)", () => {
    expect(shouldHandleOpenDiff({ projectPath: '/proj/b' }, WIN_A, null, toPaneId)).toBe(false);
  });

  it('senza projectPath ricade sulla finestra a fuoco, come open-file', () => {
    expect(shouldHandleOpenDiff({}, WIN_A, WIN_A, toPaneId)).toBe(true);
    expect(shouldHandleOpenDiff({}, WIN_B, WIN_A, toPaneId)).toBe(false);
  });

  it('il projectPath esplicito batte il fuoco: il diff va al SUO progetto', () => {
    // Il pannello Git di B cliccato mentre il fuoco è su A: la tab deve nascere
    // in B, non nella finestra che per caso aveva il fuoco.
    expect(shouldHandleOpenDiff({ projectPath: '/proj/b' }, WIN_B, WIN_A, toPaneId)).toBe(true);
    expect(shouldHandleOpenDiff({ projectPath: '/proj/b' }, WIN_A, WIN_A, toPaneId)).toBe(false);
  });

  it('projectPath null è come assente', () => {
    expect(shouldHandleOpenDiff({ projectPath: null }, WIN_A, WIN_A, toPaneId)).toBe(true);
  });
});
