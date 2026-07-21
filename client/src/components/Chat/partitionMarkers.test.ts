import { describe, expect, test } from 'bun:test';
import { partitionMarkers } from './partitionMarkers';
import type { ChatMessage, CompactionMarker } from '../../types';

function msg(id: string, role: 'user' | 'assistant' = 'assistant'): ChatMessage {
  return { id, role, content: 'x', timestamp: '' };
}
function marker(id: string, afterMessageId: string | null, createdAt = '2026-01-01'): CompactionMarker {
  return { id, afterMessageId, trigger: 'auto', createdAt };
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

  test('multiple markers on the same anchor keep chronological order', () => {
    const p = partitionMarkers(
      [msg('a')],
      [marker('m2', 'a', '2026-01-02'), marker('m1', 'a', '2026-01-01')],
    );
    expect(p.byAfter.get('a')?.map(m => m.id)).toEqual(['m1', 'm2']);
  });
});
