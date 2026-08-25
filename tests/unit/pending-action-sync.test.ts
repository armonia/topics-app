/**
 * Sidebar ↔ Topbar pending-action sync test.
 *
 * Verifies the aggregator helpers added to `PendingActionContext`:
 *   - useTopicPendingStatus    picks up `archive-topic:` OR `close-tab:chat:`
 *   - useTerminalPendingStatus picks up `close-terminal:` OR `close-tab:terminal:`
 *   - useBrowserPendingStatus  picks up `close-browser:` OR `close-tab:browser:`
 *   - usePanePendingStatus     picks up `close-tab:<paneId>` AND the
 *                              corresponding sidebar key (`archive-topic:`,
 *                              `close-terminal:`, `close-browser:`)
 *
 * The hooks themselves are React-only; this test exercises the KEY
 * RESOLUTION LOGIC directly against an entries array, replicating the
 * priority order. Keep the candidate-key tables in lockstep with
 * `PendingActionContext.tsx`.
 *
 * Run with: `bun test tests/unit/pending-action-sync.test.ts`
  * @covers PENDSYNC-01
 */
import { describe, expect, test } from 'bun:test';

// Replica of the priority lists from PendingActionContext.tsx. Keep in
// sync with the source — the test verifies the CONTRACT.
function topicCandidates(topicId: string, isArchived: boolean): string[] {
  const out: string[] = [];
  if (!isArchived) out.push(`archive-topic:${topicId}`);
  out.push(`close-tab:chat:${topicId}`);
  return out;
}

function terminalCandidates(sessionId: string): string[] {
  return [`close-terminal:${sessionId}`, `close-tab:terminal:${sessionId}`];
}

function browserCandidates(contextId: string): string[] {
  return [`close-browser:${contextId}`, `close-tab:browser:${contextId}`];
}

function paneCandidates(paneId: string): string[] {
  const out: string[] = [`close-tab:${paneId}`];
  if (paneId.startsWith('chat:')) {
    out.push(`archive-topic:${paneId.slice('chat:'.length)}`);
  } else if (paneId.startsWith('terminal:')) {
    out.push(`close-terminal:${paneId.slice('terminal:'.length)}`);
  } else if (paneId.startsWith('browser:')) {
    out.push(`close-browser:${paneId.slice('browser:'.length)}`);
  }
  return out;
}

// Helper: resolve a candidate list against an entries-array; returns the
// matched key or null. This is what each hook does internally.
function pickFirst(candidates: string[], entries: { key: string }[]): string | null {
  for (const key of candidates) {
    if (entries.some((e) => e.key === key)) return key;
  }
  return null;
}

describe('useTopicPendingStatus — candidate keys', () => {
  test('returns archive-topic when only sidebar key is queued', () => {
    expect(pickFirst(topicCandidates('t-1', false), [{ key: 'archive-topic:t-1' }]))
      .toBe('archive-topic:t-1');
  });

  test('returns close-tab:chat when only topbar key is queued', () => {
    expect(pickFirst(topicCandidates('t-1', false), [{ key: 'close-tab:chat:t-1' }]))
      .toBe('close-tab:chat:t-1');
  });

  test('archive-topic wins when both are queued (user intent priority)', () => {
    expect(pickFirst(topicCandidates('t-1', false), [
      { key: 'close-tab:chat:t-1' },
      { key: 'archive-topic:t-1' },
    ])).toBe('archive-topic:t-1');
  });

  test('isArchived=true skips archive-topic candidate (unarchive is immediate)', () => {
    expect(pickFirst(topicCandidates('t-1', true), [{ key: 'archive-topic:t-1' }]))
      .toBe(null);
    expect(pickFirst(topicCandidates('t-1', true), [{ key: 'close-tab:chat:t-1' }]))
      .toBe('close-tab:chat:t-1');
  });

  test('does not pick up other topics', () => {
    expect(pickFirst(topicCandidates('t-1', false), [{ key: 'archive-topic:t-2' }]))
      .toBe(null);
  });
});

describe('useTerminalPendingStatus — candidate keys', () => {
  test('returns sidebar close-terminal key', () => {
    expect(pickFirst(terminalCandidates('term-1'), [{ key: 'close-terminal:term-1' }]))
      .toBe('close-terminal:term-1');
  });

  test('returns topbar close-tab:terminal key', () => {
    expect(pickFirst(terminalCandidates('term-1'), [{ key: 'close-tab:terminal:term-1' }]))
      .toBe('close-tab:terminal:term-1');
  });

  test('sidebar key wins when both queued', () => {
    expect(pickFirst(terminalCandidates('term-1'), [
      { key: 'close-tab:terminal:term-1' },
      { key: 'close-terminal:term-1' },
    ])).toBe('close-terminal:term-1');
  });

  test('does not pick up other terminals', () => {
    expect(pickFirst(terminalCandidates('term-1'), [{ key: 'close-terminal:term-2' }]))
      .toBe(null);
  });
});

describe('useBrowserPendingStatus — candidate keys', () => {
  test('returns sidebar close-browser key', () => {
    expect(pickFirst(browserCandidates('br-1'), [{ key: 'close-browser:br-1' }]))
      .toBe('close-browser:br-1');
  });

  test('returns topbar close-tab:browser key', () => {
    expect(pickFirst(browserCandidates('br-1'), [{ key: 'close-tab:browser:br-1' }]))
      .toBe('close-tab:browser:br-1');
  });

  test('sidebar key wins when both queued', () => {
    expect(pickFirst(browserCandidates('br-1'), [
      { key: 'close-tab:browser:br-1' },
      { key: 'close-browser:br-1' },
    ])).toBe('close-browser:br-1');
  });
});

describe('usePanePendingStatus — pane-type resolution', () => {
  test('chat pane resolves to close-tab + archive-topic', () => {
    expect(pickFirst(paneCandidates('chat:t-1'), [{ key: 'archive-topic:t-1' }]))
      .toBe('archive-topic:t-1');
    expect(pickFirst(paneCandidates('chat:t-1'), [{ key: 'close-tab:chat:t-1' }]))
      .toBe('close-tab:chat:t-1');
  });

  test('terminal pane resolves to close-tab + close-terminal', () => {
    expect(pickFirst(paneCandidates('terminal:term-1'), [{ key: 'close-terminal:term-1' }]))
      .toBe('close-terminal:term-1');
  });

  test('browser pane resolves to close-tab + close-browser', () => {
    expect(pickFirst(paneCandidates('browser:br-1'), [{ key: 'close-browser:br-1' }]))
      .toBe('close-browser:br-1');
  });

  test('close-tab key wins (topbar-originated) over sidebar', () => {
    expect(pickFirst(paneCandidates('terminal:term-1'), [
      { key: 'close-terminal:term-1' },
      { key: 'close-tab:terminal:term-1' },
    ])).toBe('close-tab:terminal:term-1');
  });

  test('project / session-viewer panes only resolve to close-tab', () => {
    expect(pickFirst(paneCandidates('project:%2FUsers%2Fme%2Fp'), [
      { key: 'close-tab:project:%2FUsers%2Fme%2Fp' },
    ])).toBe('close-tab:project:%2FUsers%2Fme%2Fp');
    // No sidebar counterpart for project panes — only close-tab path.
    expect(pickFirst(paneCandidates('session-viewer:sk-1'), [
      { key: 'close-tab:session-viewer:sk-1' },
    ])).toBe('close-tab:session-viewer:sk-1');
  });
});

describe('Sync invariant: sidebar↔topbar pair always share visibility', () => {
  const matrix: Array<{ scenario: string; sidebarKey: string; topbarKey: string; topbarPaneId: string }> = [
    {
      scenario: 'chat topic close',
      sidebarKey: 'archive-topic:t-1',
      topbarKey: 'close-tab:chat:t-1',
      topbarPaneId: 'chat:t-1',
    },
    {
      scenario: 'terminal close',
      sidebarKey: 'close-terminal:term-1',
      topbarKey: 'close-tab:terminal:term-1',
      topbarPaneId: 'terminal:term-1',
    },
    {
      scenario: 'browser close',
      sidebarKey: 'close-browser:br-1',
      topbarKey: 'close-tab:browser:br-1',
      topbarPaneId: 'browser:br-1',
    },
  ];

  for (const m of matrix) {
    test(`${m.scenario}: sidebar-triggered → topbar sees it`, () => {
      const entries = [{ key: m.sidebarKey }];
      // Topbar `usePanePendingStatus` must resolve to a non-null key.
      expect(pickFirst(paneCandidates(m.topbarPaneId), entries)).not.toBe(null);
    });

    test(`${m.scenario}: topbar-triggered → sidebar aggregator sees it`, () => {
      const entries = [{ key: m.topbarKey }];
      // Pick the sidebar-side candidate list for this scenario.
      let candidates: string[];
      if (m.topbarPaneId.startsWith('chat:')) {
        candidates = topicCandidates(m.topbarPaneId.slice('chat:'.length), false);
      } else if (m.topbarPaneId.startsWith('terminal:')) {
        candidates = terminalCandidates(m.topbarPaneId.slice('terminal:'.length));
      } else {
        candidates = browserCandidates(m.topbarPaneId.slice('browser:'.length));
      }
      expect(pickFirst(candidates, entries)).not.toBe(null);
    });
  }
});
