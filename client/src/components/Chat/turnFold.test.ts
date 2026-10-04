/**
 * @covers CHAT-TOOL-02
 * @covers CHAT-BROWSER-01
 */
import { describe, expect, test } from 'bun:test';
import { foldFinishedTurn, type FoldableGroup } from './turnFold';
import type { ToolCall } from '../../types';

const tool = (id: string, status: ToolCall['status'] = 'success'): ToolCall =>
  ({ id, name: 'Bash', args: { command: 'ls' }, status } as ToolCall);
const text = (idx: number, t: string): FoldableGroup => ({ kind: 'text', idx, text: t });
const tools = (startIdx: number, ...tc: ToolCall[]): FoldableGroup => ({ kind: 'tools', startIdx, tools: tc });

describe('the finished turn folds its work and shows its answer', () => {
  test('the d6158ec6 shape: commentary and tools interleaved, then the answer', () => {
    const groups = [
      text(0, 'Guardo il file.'), tools(1, tool('a')),
      text(2, 'Ora il test.'), tools(3, tool('b'), tool('c')),
      { kind: 'thinking', idx: 4, text: 'hmm' } as FoldableGroup,
      text(5, 'Fatto: il test passa.'),
    ];
    const fold = foldFinishedTurn(groups, false)!;
    expect(fold.head).toEqual([]);
    expect(fold.shown).toEqual([text(5, 'Fatto: il test passa.')]);
    expect(fold.work).toHaveLength(5);
    expect(fold.tools.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  test('what needs a person keeps the turn open: question, permission, running tool', () => {
    for (const status of ['waiting_for_input', 'awaiting_permission', 'running'] as const) {
      const groups = [tools(0, tool('a'), tool('q', status)), text(1, 'Aspetto.')];
      expect(foldFinishedTurn(groups, false)).toBeNull();
    }
  });

  test('a live turn, a turn without work, a turn without an answer: nothing to fold', () => {
    const work = [tools(0, tool('a'), tool('b')), text(1, 'Fatto.')];
    expect(foldFinishedTurn(work, true)).toBeNull();
    expect(foldFinishedTurn([text(0, 'Solo prosa.')], false)).toBeNull();
    expect(foldFinishedTurn([tools(0, tool('a'), tool('b'))], false)).toBeNull();
    expect(foldFinishedTurn([tools(0, tool('a')), text(1, 'Un tool solo.')], false)).toBeNull();
  });

  // CHAT-BROWSER-01: twelve calls, the seventh opened the browser.
  test('a browser marker stays in sight like an image, and the fold counts the other eleven', () => {
    const marker: FoldableGroup = { kind: 'browser', idx: 6, marker: { id: 'o', contextId: 't1', pages: [{ toolCallId: 'o', url: 'http://localhost:5173/', title: 'Vite App' }] } };
    const before = Array.from({ length: 6 }, (_, i) => tool(`b${i}`));
    const after = Array.from({ length: 5 }, (_, i) => tool(`a${i}`));
    const groups = [tools(0, ...before), marker, tools(7, ...after), text(12, 'Fatto.')];
    const fold = foldFinishedTurn(groups, false)!;
    expect(fold.tools).toHaveLength(11);
    expect(fold.work).toEqual([tools(0, ...before), tools(7, ...after)]);
    expect(fold.shown).toEqual([marker, text(12, 'Fatto.')]);
  });

  test('an image drawn in the work stays in sight, and what follows the answer is shown', () => {
    const img: FoldableGroup = { kind: 'media', idx: 1, path: '/a.png', seq: 0 };
    const groups = [tools(0, tool('a'), tool('b')), img, text(2, 'Ecco.'), tools(3, tool('c'))];
    const fold = foldFinishedTurn(groups, false)!;
    expect(fold.shown).toEqual([img, text(2, 'Ecco.'), tools(3, tool('c'))]);
    expect(fold.work).toEqual([tools(0, tool('a'), tool('b'))]);
  });

  // 24/09: 55 compacted turns of 55 on the prod DB had the CLI recap folded
  // behind «N actions», boundary and «Context compacted» row included.
  test('a compaction recap is a boundary: it stays in sight, only the work after it folds', () => {
    const recap = text(2, 'This session is being continued from a previous conversation that ran out of context. Summary: ...');
    const groups = [text(0, 'Prima.'), tools(1, tool('a')), recap, tools(3, tool('b'), tool('c')), text(4, 'Fatto dopo la compattazione.')];
    const fold = foldFinishedTurn(groups, false)!;
    expect(fold.head).toEqual([text(0, 'Prima.'), tools(1, tool('a')), recap]);
    expect(fold.work).toEqual([tools(3, tool('b'), tool('c'))]);
    expect(fold.shown).toEqual([text(4, 'Fatto dopo la compattazione.')]);
  });

  // 04/10: the agent asks mid-turn, works on and closes with a text. Folded,
  // the answered question went back into «3 actions» after a reload, and the
  // choice the person made was out of sight again.
  test('an answered question stays in sight; the work around it still folds', () => {
    const ask = { ...tool('q'), name: 'AskUserQuestion', userResponse: { kind: 'questions', answers: { 'Quale database?': 'SQLite' }, submittedAt: '' } } as ToolCall;
    const groups = [tools(0, tool('r'), ask, tool('b')), text(3, 'Fatto: ho configurato SQLite.')];
    const fold = foldFinishedTurn(groups, false)!;
    expect(fold.work).toEqual([tools(0, tool('r')), tools(2, tool('b'))]);
    expect(fold.shown).toEqual([tools(1, ask), text(3, 'Fatto: ho configurato SQLite.')]);
    expect(fold.tools.map((t) => t.id)).toEqual(['r', 'b']);
    // What is left to fold is counted without it: one call is not worth a row.
    expect(foldFinishedTurn([tools(0, tool('r'), ask), text(2, 'Fatto.')], false)).toBeNull();
  });

  test('a recap that is the last text never becomes the folded answer', () => {
    const recap = text(2, 'This session is being continued from a previous conversation that ran out of context. Summary: ...');
    expect(foldFinishedTurn([tools(0, tool('a'), tool('b')), text(1, 'x'), recap], false)).toBeNull();
  });
});
