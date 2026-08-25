/**
 * @covers CHAT-COMPACT-01
 */
import { describe, expect, test } from 'bun:test';
import { partitionMarkers } from './partitionMarkers';
import type { ChatMessage, CompactionMarker } from '../../types';

function msg(id: string, role: 'user' | 'assistant' = 'assistant'): ChatMessage {
  return { id, role, content: 'x', timestamp: '' };
}
function marker(
  id: string,
  afterMessageId: string | null,
  createdAt = '2026-01-01',
  tokens?: { preTokens?: number; postTokens?: number },
): CompactionMarker {
  // `topicId` e `sessionKey` non li legge `partitionMarkers`, ma un marcatore
  // senza di essi non esiste: il server li scrive sempre (sono le due chiavi
  // con cui la riga viene letta indietro). Una fixture che li ometteva
  // descriveva una riga che il sistema non produce.
  return {
    id,
    topicId: 'topic-1',
    sessionKey: 'topic-1:main',
    afterMessageId,
    trigger: 'auto',
    createdAt,
    ...tokens,
  };
}

describe('partitionMarkers', () => {
  test('no markers → empty partition', () => {
    const p = partitionMarkers([msg('a')], undefined);
    expect(p.leading.length).toBe(0);
    expect(p.byAfter.size).toBe(0);
  });

  test('anchors after the matching message', () => {
    const p = partitionMarkers([msg('a'), msg('b')], [marker('m1', 'a')]);
    expect(p.leading.length).toBe(0);
    expect(p.byAfter.get('a')?.map(m => m.id)).toEqual(['m1']);
    expect(p.byAfter.has('b')).toBe(false);
  });

  test('null anchor surfaces at top', () => {
    const p = partitionMarkers([msg('a')], [marker('m1', null)]);
    expect(p.leading.map(m => m.id)).toEqual(['m1']);
  });

  test('anchor not in the visible set surfaces at top (never lost)', () => {
    const p = partitionMarkers([msg('a')], [marker('m1', 'paginated-out')]);
    expect(p.leading.map(m => m.id)).toEqual(['m1']);
  });

  test('repeated markers on the same anchor collapse to a single divider', () => {
    // Compaction firing several times in one turn anchors every marker to the
    // same message; the transcript position is identical, so we render one.
    const p = partitionMarkers(
      [msg('a')],
      [marker('m2', 'a', '2026-01-02'), marker('m1', 'a', '2026-01-01'), marker('m3', 'a', '2026-01-03')],
    );
    expect(p.byAfter.get('a')?.length).toBe(1);
    // The earliest survives when none carry token info.
    expect(p.byAfter.get('a')?.[0].id).toBe('m1');
  });

  test('collapse keeps the richest same-anchor marker (token delta wins)', () => {
    const p = partitionMarkers(
      [msg('a')],
      [
        marker('m1', 'a', '2026-01-01'),
        marker('m2', 'a', '2026-01-02', { preTokens: 120_000, postTokens: 40_000 }),
        marker('m3', 'a', '2026-01-03', { preTokens: 130_000 }),
      ],
    );
    expect(p.byAfter.get('a')?.length).toBe(1);
    expect(p.byAfter.get('a')?.[0].id).toBe('m2');
  });

  test('distinct anchors are not collapsed together', () => {
    const p = partitionMarkers(
      [msg('a'), msg('b')],
      [marker('m1', 'a'), marker('m2', 'b')],
    );
    expect(p.byAfter.get('a')?.map(m => m.id)).toEqual(['m1']);
    expect(p.byAfter.get('b')?.map(m => m.id)).toEqual(['m2']);
  });
});
