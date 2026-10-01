/** @covers SUBAGENT-16 */
import { describe, expect, test } from 'bun:test';
import type { ContentBlock, SubagentResultCard } from '../../types';
import { latestSubagentResult, reasonText, spawnCardState } from './subagentResult';
import { ensureLocaleLoaded, t } from '../../lib/i18n';
import { buildToolDisplayLabel, resolveToolDetail } from './toolDetail';
import { toolCardHasBody } from './toolCardBody';

const card = (over: Partial<SubagentResultCard> = {}): SubagentResultCard => ({
  agentId: 'c1', name: 'scout', turn: 1, status: 'completed', partial: false, text: 'Report: 3 files', ...over,
});
const row = (results: SubagentResultCard[]): { blocks: ContentBlock[] } => ({ blocks: [{ kind: 'subagent-result', results }] });

describe('the result a spawn card shows', () => {
  test('the newest result of that child, across rows and inside one row', () => {
    const first = card();
    const second = card({ turn: 2, text: 'Two tests.' });
    const other = card({ agentId: 'c2' });
    expect(latestSubagentResult([row([first]), { blocks: [] }, row([other, second])], 'c1')).toBe(second);
    expect(latestSubagentResult([row([other])], 'c1')).toBeNull();
  });
});

describe('the state a spawn card shows', () => {
  test('a live child says its own phase, from its transcript', () => {
    expect(spawnCardState({ live: { subAgentPhase: 'waiting-prompt' }, result: null, isRunning: false })).toBe('waiting-prompt');
    expect(spawnCardState({ live: { subAgentPhase: 'working' }, result: null, isRunning: false })).toBe('working');
    expect(spawnCardState({ live: { subAgentPhase: 'finished' }, result: card(), isRunning: false })).toBe('finished');
  });

  test('gone from the roster: finished with a result, ended without; starting while the call runs', () => {
    expect(spawnCardState({ live: null, result: card({ status: 'undelivered' }), isRunning: false })).toBe('finished');
    expect(spawnCardState({ live: null, result: null, isRunning: false })).toBe('ended');
    expect(spawnCardState({ live: null, result: null, isRunning: true })).toBe('starting');
  });
});

describe('spawn_agent is drawn as the sub-agent card, not the generic MCP one', () => {
  const answer = 'spawned sub-agent "foglio-tab" · agentId=0b7c2f0e-1d2a-4c3b-9e8f-1234567890ab · cwd=/p · model=claude-sonnet-5-5[1m] · agent_type=scout · effort=low — its result will wake this chat';
  for (const name of ['spawn_agent', 'mcp__topics__spawn_agent']) {
    test(`${name} under its name`, () => {
      const detail = resolveToolDetail({ id: 't1', name, args: { prompt: 'Find the call sites.', name: 'foglio-tab', agent_type: 'scout' }, result: answer, status: 'success' } as never);
      expect(detail).toMatchObject({
        type: 'sub_agent', via: 'spawn_agent', name: 'foglio-tab', subAgentType: 'scout',
        model: 'claude-sonnet-5-5[1m]', agentId: '0b7c2f0e-1d2a-4c3b-9e8f-1234567890ab',
      });
      expect(buildToolDisplayLabel(detail).name).toBe('Sub-agent');
      expect(toolCardHasBody(detail)).toBe(true);
    });
  }
});

describe('the reason a result card names', () => {
  test('a Reload has words of its own, in both languages', async () => {
    await ensureLocaleLoaded('en');
    const tr = (lang: 'it' | 'en') => ((key: string, vars?: Record<string, string>) => t(key, lang, vars)) as never;
    expect(reasonText(tr('it'), { code: 'reloaded' })).toBe('la sua tab è stata ricaricata');
    expect(reasonText(tr('en'), { code: 'reloaded' })).toBe('its tab was reloaded');
  });
});
