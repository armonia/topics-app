import { describe, expect, test } from 'bun:test';
import { isChronicleRow, liveToolRow, type ChronicleDeps } from './columnFilter';
import type { TimelineItem } from './taskTimeline';

const deps: ChronicleDeps = { isService: () => false, hasQuestion: (c) => c.includes('```question') };

const comment = (author: string, kind: string, content = 'x'): TimelineItem => ({
  source: 'comment', id: 'c', at: '', author, kind, content,
  comment: { id: 'c', author, kind, content },
}) as unknown as TimelineItem;

const session = (role: 'user' | 'assistant', blocks: unknown[] = [], extra: object = {}): TimelineItem => ({
  source: 'session', id: `s${Math.random()}`, at: '', author: role, kind: 'comment', content: 'x',
  msg: { id: 'm', role, content: 'x', blocks },
  ...extra,
}) as unknown as TimelineItem;

describe('isChronicleRow: what leaves the column', () => {
  test('status change', () => expect(isChronicleRow(comment('dispatcher', 'status'), deps)).toBe(true));
  test('review note', () => expect(isChronicleRow(comment('verifier', 'review-note'), deps)).toBe(true));
  test('service note', () => expect(isChronicleRow(comment('agent', 'comment'), { ...deps, isService: () => true })).toBe(true));
  test('system comment', () => expect(isChronicleRow(comment('system', 'comment'), deps)).toBe(true));
  test('envelope', () => expect(isChronicleRow(session('user', [], { envelope: true }), deps)).toBe(true));
  test('process exit', () => expect(isChronicleRow(session('user', [{ kind: 'process-exit' }]), deps)).toBe(true));
  test('goal nudge', () => expect(isChronicleRow(session('user', [{ kind: 'goal-nudge' }]), deps)).toBe(true));
  test('goal stop', () => expect(isChronicleRow(session('user', [{ kind: 'goal-stop' }]), deps)).toBe(true));
  test('machine stop', () => expect(isChronicleRow(session('assistant', [{ kind: 'machine-stop' }]), deps)).toBe(true));
  test('background notice', () => expect(isChronicleRow(session('assistant', [{ kind: 'background-notice' }]), deps)).toBe(true));
});

describe('isChronicleRow: what stays in the column', () => {
  test('person comment', () => expect(isChronicleRow(comment('human', 'comment'), deps)).toBe(false));
  test('agent comment', () => expect(isChronicleRow(comment('agent', 'comment'), deps)).toBe(false));
  test('system question', () => expect(isChronicleRow(comment('system', 'comment', '```question\nq'), deps)).toBe(false));
  test('typed user row', () => expect(isChronicleRow(session('user'), deps)).toBe(false));
  test('assistant words', () => expect(isChronicleRow(session('assistant'), deps)).toBe(false));
  test('sub-agent result', () => expect(isChronicleRow(session('user', [{ kind: 'subagent-result' }]), deps)).toBe(false));
});

describe('liveToolRow', () => {
  test('current assistant turn', () => {
    const a = session('assistant');
    expect(liveToolRow([session('user'), a])).toBe(a as never);
  });
  test('a new user turn hides the previous turn', () => {
    expect(liveToolRow([session('assistant'), session('user')])).toBeNull();
  });
  test('envelopes are skipped', () => {
    const a = session('assistant');
    expect(liveToolRow([a, session('user', [], { envelope: true })])).toBe(a as never);
  });
});
