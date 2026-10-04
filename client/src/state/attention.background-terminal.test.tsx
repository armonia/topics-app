/**
 * ONE TERMINAL WAITING ON ITS JOB, EVERY SURFACE SAYS «AT WORK» (ATTN-12).
 *
 * A hooked claude-code terminal whose turn left a Bash running is, on the
 * server, in the phase `watching` and in the attention state `working` (a job
 * the subject waits for is work in progress, since 2026-10-04). Its tab, its
 * project and the menu of agents say the same: the working ring and the
 * working list. Before, the tab said a grey `background` of its own.
 *
 * @covers ATTN-12
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import type { ReactElement } from 'react';
import { mount } from '../test/reactHarness';
import { attentionActions, useAttentionStore } from './attention';
import { derivePhaseTerminals, signalsActions, activeAgentRowsFrom, useSignalsStore } from './signals';
import { TopicsProvider } from '../contexts/TopicsContext';
import { ProjectStreamingSpinner, TerminalStreamingSpinner } from '../components/Layout/StreamingIndicator';
import type { TerminalSessionInfo } from '../types';

const term = { id: 'S', type: 'claude-code', name: 'bgwait', cwd: '/p', claudeSessionId: 'c1', createdAt: '2026-10-03T10:00:00.000Z' } as unknown as TerminalSessionInfo;

// The harness renders on the server, which reads zustand's initial state: point it at the live one.
(useAttentionStore as unknown as { getInitialState: unknown }).getInitialState = useAttentionStore.getState;
(useSignalsStore as unknown as { getInitialState: unknown }).getInitialState = useSignalsStore.getState;

beforeEach(() => {
  attentionActions.reset();
  attentionActions.applyInit([{
    subject: 'terminal:S', state: 'working', reason: null, outcome: null, detail: null,
    since: '2026-10-03T10:00:00.000Z', epoch: 0, seenEpoch: 0, lit: false, unread: 0, turnUnseen: false,
    lastTurnAt: '2026-10-03T10:00:00.000Z',
    background: [{ id: 'bash_1', kind: 'bash', label: 'sleep 600', startedAt: '2026-10-03T10:00:00.000Z' }],
  }]);
  // What the server's phase machine says at that Stop: `watching`.
  const { active, resting } = derivePhaseTerminals([term], new Map([['c1', { phase: 'watching' as const }]]));
  signalsActions.setClaudePhaseTerminals(active, resting);
});

function loaderOf(el: ReactElement): string | null {
  const h = mount(<TopicsProvider topics={{}} terminalSessions={[term]}>{el}</TopicsProvider>);
  const host = h.last().hosts.find((n) => 'data-loader-state' in n.props);
  h.unmount();
  return host ? String(host.props['data-loader-state']) : null;
}

describe('a terminal waiting on its background task', () => {
  test('its tab and its project tab draw the working ring', () => {
    expect(loaderOf(<TerminalStreamingSpinner sessionId="S" />)).toBe('working');
    expect(loaderOf(<ProjectStreamingSpinner projectPath="/p" />)).toBe('working');
  });

  test('without the phase (hooks silent) the attention state alone keeps it at work', () => {
    signalsActions.setClaudePhaseTerminals(new Set(), new Set(['S']));
    expect(loaderOf(<TerminalStreamingSpinner sessionId="S" />)).toBe('working');
  });

  test('the menu of agents lists it among the working ones', () => {
    const sig = useSignalsStore.getState();
    const menu = activeAgentRowsFrom([term], {}, {
      active: sig.claudePhaseActiveTermIds, resting: sig.claudePhaseRestingTermIds, busy: sig.terminalBusyIds,
      liveStream: sig.liveStreamTopics, hydratedStream: sig.hydratedStreamTopics, attention: useAttentionStore.getState().rows,
    });
    expect({ working: menu.working.map((r) => r.id), finished: menu.finished.map((r) => r.id) }).toEqual({ working: ['S'], finished: [] });
  });
});
