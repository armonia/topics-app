/**
 * ONE TERMINAL IN BACKGROUND, EVERY SURFACE SAYS SO (ATTN-12, design 2.3).
 *
 * A hooked claude-code terminal whose turn left a Bash running is, on the
 * server, in the phase `watching` and in the attention tier `background` at
 * once. The phase partition counts `watching` as active; the tier is what the
 * surfaces must read. Before, the terminal's own tab said `background` while
 * its project tab and row said `working` («a chat of this project is
 * answering») and the menu of agents listed it as working.
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
    subject: 'terminal:S', state: 'background', reason: null, outcome: null, detail: null,
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
  test('its tab and its project tab draw the grey glyph, not the working ring', () => {
    expect(loaderOf(<TerminalStreamingSpinner sessionId="S" />)).toBe('background');
    expect(loaderOf(<ProjectStreamingSpinner projectPath="/p" />)).toBe('background');
  });

  test('the menu of agents lists it under background, not working', () => {
    const sig = useSignalsStore.getState();
    const menu = activeAgentRowsFrom([term], {}, {
      active: sig.claudePhaseActiveTermIds, resting: sig.claudePhaseRestingTermIds, busy: sig.terminalBusyIds,
      liveStream: sig.liveStreamTopics, hydratedStream: sig.hydratedStreamTopics, attention: useAttentionStore.getState().rows,
    });
    expect({ working: menu.working.map((r) => r.id), background: menu.background.map((r) => r.id) }).toEqual({ working: [], background: ['S'] });
  });
});
