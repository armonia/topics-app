/**
 * @covers KANBAN-52
 */
import { describe, expect, it } from 'bun:test';
import { bucketSessionMsgs, sessionPaneRows, type SessionBoundary, type SessionMsg } from './sessionBuckets';

const msg = (timestamp: string, role = 'assistant', content = timestamp): SessionMsg => ({ role, content, timestamp });
const at = (id: string, createdAt: string): SessionBoundary => ({ id, createdAt });

describe('bucketSessionMsgs', () => {
  it('cuts the session at the comment boundaries, upper bound included', () => {
    const msgs = [msg('2026-01-01T10:00:00.000Z'), msg('2026-01-01T10:05:00.000Z'), msg('2026-01-01T10:20:00.000Z')];
    const b = bucketSessionMsgs(msgs, [at('c1', '2026-01-01T10:05:00.000Z'), at('c2', '2026-01-01T10:10:00.000Z')]);
    expect(b.byComment.get('c1')?.map((m) => m.timestamp)).toEqual(['2026-01-01T10:00:00.000Z', '2026-01-01T10:05:00.000Z']);
    expect(b.byComment.get('c2')).toEqual([]);
    expect(b.tail.map((m) => m.timestamp)).toEqual(['2026-01-01T10:20:00.000Z']);
  });

  it('puts everything in the tail when the thread has no comments', () => {
    const msgs = [msg('2026-01-01T10:00:00.000Z'), msg('2026-01-01T10:05:00.000Z')];
    expect(bucketSessionMsgs(msgs, []).tail).toHaveLength(2);
  });

  it('drops rows with no timestamp: they cannot be placed', () => {
    const b = bucketSessionMsgs([msg(''), msg('2026-01-01T10:00:00.000Z')], [at('c1', '2026-01-01T10:00:00.000Z')]);
    expect(b.byComment.get('c1')).toHaveLength(1);
  });

  it('places rows that arrive out of order', () => {
    const msgs = [msg('2026-01-01T10:20:00.000Z'), msg('2026-01-01T10:00:00.000Z')];
    const b = bucketSessionMsgs(msgs, [at('c1', '2026-01-01T10:05:00.000Z')]);
    expect(b.byComment.get('c1')?.map((m) => m.timestamp)).toEqual(['2026-01-01T10:00:00.000Z']);
    expect(b.tail.map((m) => m.timestamp)).toEqual(['2026-01-01T10:20:00.000Z']);
  });

  it('gives every comment an empty slice when the session is empty', () => {
    const b = bucketSessionMsgs(null, [at('c1', '2026-01-01T10:00:00.000Z')]);
    expect(b.byComment.get('c1')).toEqual([]);
    expect(b.tail).toEqual([]);
  });

  // The poll rebuilds the message objects from JSON every 3s, so identity can
  // never match: only a value comparison can keep a slice stable, and a stable
  // slice is what lets an unchanged `SessionSlice` skip its render.
  it('keeps the SAME array for a bucket whose messages did not change', () => {
    const boundaries = [at('c1', '2026-01-01T10:05:00.000Z'), at('c2', '2026-01-01T10:30:00.000Z')];
    const first = bucketSessionMsgs([msg('2026-01-01T10:00:00.000Z')], boundaries);
    // Fresh objects, same values, plus a new message in the tail.
    const second = bucketSessionMsgs(
      [msg('2026-01-01T10:00:00.000Z'), msg('2026-01-01T10:40:00.000Z')],
      boundaries,
      first,
    );
    expect(second.byComment.get('c1')).toBe(first.byComment.get('c1')!);
    expect(second.byComment.get('c2')).toBe(first.byComment.get('c2')!);
    expect(second.tail).not.toBe(first.tail);
    expect(second.tail).toHaveLength(1);
  });

  it('hands back a NEW array when a bucket gains content', () => {
    const boundaries = [at('c1', '2026-01-01T10:05:00.000Z')];
    const first = bucketSessionMsgs([msg('2026-01-01T10:00:00.000Z')], boundaries);
    const second = bucketSessionMsgs(
      [msg('2026-01-01T10:00:00.000Z'), msg('2026-01-01T10:01:00.000Z')],
      boundaries,
      first,
    );
    expect(second.byComment.get('c1')).not.toBe(first.byComment.get('c1')!);
    expect(second.byComment.get('c1')).toHaveLength(2);
  });

  // A partial message that grew mid-stream has the SAME timestamp and a longer
  // body. Reusing the old array there would freeze the live preview.
  it('hands back a NEW array when a message body grew in place', () => {
    const boundaries = [at('c1', '2026-01-01T10:05:00.000Z')];
    const first = bucketSessionMsgs([msg('2026-01-01T10:00:00.000Z', 'assistant', 'sto')], boundaries);
    const second = bucketSessionMsgs([msg('2026-01-01T10:00:00.000Z', 'assistant', 'sto scrivendo')], boundaries, first);
    expect(second.byComment.get('c1')).not.toBe(first.byComment.get('c1')!);
    expect(second.byComment.get('c1')?.[0].content).toBe('sto scrivendo');
  });

  // The point of the rewrite. The per-row `filter` it replaced walked the whole
  // history once PER COMMENT: 200 x 28 = 5600 reads per poll tick, every 3s.
  it('reads the history a bounded number of times, not once per comment', () => {
    let reads = 0;
    const msgs: SessionMsg[] = Array.from({ length: 200 }, (_, i) => {
      const ts = `2026-01-01T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`;
      return { role: 'assistant', content: `m${i}`, get timestamp() { reads++; return ts; } };
    });
    const boundaries = Array.from({ length: 28 }, (_, i) => at(`c${i}`, `2026-01-01T10:${String(i * 2).padStart(2, '0')}:00.000Z`));
    bucketSessionMsgs(msgs, boundaries);
    expect(reads).toBeLessThan(8 * (msgs.length + boundaries.length));
  });
});

describe('sessionPaneRows', () => {
  const buckets = (msgs: SessionMsg[], bs: SessionBoundary[]) => bucketSessionMsgs(msgs, bs);

  it('draws the session whole when the thread has no comments', () => {
    const rows = sessionPaneRows(buckets([msg('2026-01-01T10:00:00.000Z'), msg('2026-01-01T10:05:00.000Z')], []), []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('steps');
    expect(rows[0]!.kind === 'steps' && rows[0]!.msgs).toHaveLength(2);
  });

  it('marks the boundary BETWEEN two stretches of steps', () => {
    const bs = [at('c1', '2026-01-01T10:05:00.000Z')];
    const rows = sessionPaneRows(
      buckets([msg('2026-01-01T10:00:00.000Z'), msg('2026-01-01T10:20:00.000Z')], bs),
      ['c1'],
    );
    expect(rows.map((r) => r.kind)).toEqual(['steps', 'mark', 'steps']);
    expect(rows[1]!.id).toBe('c1');
  });

  // A card with 28 comments and two agent turns must not draw 28 dividers: a
  // mark is a separator, and a separator with nothing on one side separates
  // nothing.
  it('never opens or closes on a mark, and collapses a run of them', () => {
    const bs = [
      at('c1', '2026-01-01T09:00:00.000Z'),   // before anything was said
      at('c2', '2026-01-01T10:10:00.000Z'),
      at('c3', '2026-01-01T10:11:00.000Z'),   // adjacent replies, nothing between
      at('c4', '2026-01-01T11:00:00.000Z'),   // after the last word
    ];
    const rows = sessionPaneRows(
      buckets([msg('2026-01-01T10:00:00.000Z'), msg('2026-01-01T10:30:00.000Z')], bs),
      ['c1', 'c2', 'c3', 'c4'],
    );
    expect(rows.map((r) => r.kind)).toEqual(['steps', 'mark', 'steps']);
    // The LAST boundary crossed before the agent spoke again is the one drawn.
    expect(rows[1]!.id).toBe('c3');
  });

  it('drops the human turns injected into the session: the thread already shows them', () => {
    const rows = sessionPaneRows(
      buckets([msg('2026-01-01T10:00:00.000Z', 'user'), msg('2026-01-01T10:05:00.000Z')], []),
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind === 'steps' && rows[0]!.msgs.map((m) => m.role)).toEqual(['assistant']);
  });

  it('is empty when the agent has said nothing yet', () => {
    expect(sessionPaneRows(bucketSessionMsgs(null, [at('c1', '2026-01-01T10:00:00.000Z')]), ['c1'])).toEqual([]);
  });
});
