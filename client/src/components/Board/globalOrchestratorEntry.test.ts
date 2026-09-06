/**
 * Source-level pins for the Kanban entry into the coordinator conversation.
 * @covers GLOBAL-ORCHESTRATOR-CLIENT-01
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BOARD_DIR = import.meta.dir;
const read = (relative: string) => readFileSync(join(BOARD_DIR, relative), 'utf8');
const board = read('KanbanBoardPane.tsx');
const standalone = read('../Layout/StandaloneChatGroup.tsx');
const api = read('../../lib/api.ts');
const lifecycle = read('../../hooks/usePanelLifecycle.ts');

describe('global board orchestrator entry', () => {
  test('exists only on the global board and has one named action', () => {
    expect(board).toContain('onOpenGlobalOrchestrator?: () => Promise<void>');
    expect(board).toContain('global && onOpenGlobalOrchestrator && (');
    expect(board).toContain('data-testid="board-open-orchestrator"');
    expect(board).toContain("tr('board.orchestrator.open')");
  });

  test('ensures the server-owned singleton, then uses the normal permanent topic-open flow', () => {
    expect(api).toContain("request<{ topicId: string; topic: Topic }>('/orchestrator-sessions/global/ensure'");
    expect(api).toContain("method: 'POST'");
    expect(standalone).toContain('const openGlobalOrchestrator = useCallback(async () => {');
    expect(standalone).toContain('await orchestratorSessionsApi.ensureGlobal()');
    expect(standalone).toContain("new CustomEvent('topics:open-topic'");
    expect(standalone).toContain('const { topicId, topic } = await orchestratorSessionsApi.ensureGlobal()');
    expect(standalone).toContain("detail: { topicId, topic, mode: 'permanent' }");
  });

  test('passes the action into the global board host rather than rendering another chat surface', () => {
    const start = standalone.indexOf("utilityType === 'board'");
    const end = standalone.indexOf('// Chat (real or draft).', start);
    const globalBoard = standalone.slice(start, end);
    expect(globalBoard).toContain('onOpenGlobalOrchestrator={openGlobalOrchestrator}');
    expect(globalBoard).not.toContain('<ChatPanel');
  });

  test('hydrates the returned Topic before opening when the WebSocket is reconnecting', () => {
    expect(lifecycle).toContain('if (detail.topic) applyTopicFromWS(detail.topic)');
    expect(lifecycle).toContain("openPanel(detail.topicId, detail.mode ?? 'preview', true, detail.topic)");
  });
});
