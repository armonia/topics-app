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
const drawer = read('OrchestratorDrawer.tsx');
const taskShell = read('TaskDetail.tsx');
const standalone = read('../Layout/StandaloneChatGroup.tsx');
const api = read('../../lib/api.ts');
const lifecycle = read('../../hooks/usePanelLifecycle.ts');
const icons = read('../../lib/topicIcons.tsx');
const route = readFileSync(join(BOARD_DIR, '../../../../server/routes/orchestrator-sessions.ts'), 'utf8');

/**
 * `toContain` on a 2000-line file prints the FILE when it fails: 120 KB of
 * noise in which the missing line is invisible. Here the diagnosis is the line
 * that was looked for, and nothing else.
 */
const pin = (source: string, needle: string) =>
  expect(source.includes(needle) ? needle : `MISSING: ${needle}`).toBe(needle);

describe('global board orchestrator entry', () => {
  test('exists only on the global board, as a toggle carrying the coordinator glyph', () => {
    pin(board, 'global && orchestrator && (');
    pin(board, 'data-testid="board-open-orchestrator"');
    pin(board, 'aria-pressed={!!orchestratorTopic}');
    pin(board, 'if (orchestratorTopic) closeOrchestrator(); else void openOrchestrator();');
    pin(board, "tr('board.orchestrator.open')");
    // The notes, not the bubble: the button's glyph is the topic's glyph.
    pin(board, '<Music4 className="h-3 w-3 shrink-0" />');
  });

  test('the two halves travel as ONE prop: no board can have the button without the surface', () => {
    pin(board, 'ensure: () => Promise<{ topicId: string; topic: Topic }>;');
    pin(board, 'render: (args: { topic: Topic }) => React.ReactNode;');
    pin(api, "request<{ topicId: string; topic: Topic }>('/orchestrator-sessions/global/ensure'");
    pin(api, "method: 'POST'");
    pin(standalone, 'const ensureGlobalOrchestrator = useCallback(() => orchestratorSessionsApi.ensureGlobal(), []);');
    pin(standalone, 'ensure: ensureGlobalOrchestrator,');
    pin(standalone, 'render: ({ topic }) => renderOrchestratorChat(topic, paneId, isPaneActive && focusedPanelId === paneId),');
  });

  test('the conversation mounts INSIDE the board, in the slot the task preview uses', () => {
    pin(board, '<OrchestratorDrawer');
    pin(board, '{orchestrator.render({ topic: orchestratorTopic })}');
    // The task drawer's geometry: in-flow sibling from lg up, full-screen
    // overlay below. If either side drifts this pin says so, instead of
    // leaving two drawers that open differently.
    for (const cls of [
      'absolute inset-0 z-40 w-full lg:relative lg:inset-auto lg:z-auto lg:shrink-0 lg:border-l',
      'lg:w-[min(64rem,72%)] lg:shadow-2xl',
      'lg:w-96 lg:max-w-[75%]',
    ]) {
      pin(taskShell, cls);
      pin(drawer, cls);
    }
  });

  test('the two drawers are mutually exclusive — one slot, one thing in it', () => {
    // Opening a card closes the coordinator…
    pin(board, 'setPendingPaneId(focusPaneId ?? null);\n    setOrchestratorTopic(null);');
    // …and opening the coordinator closes the card.
    pin(board, 'setOrchestratorTopic(topic);\n      setSelectedId(null);');
  });

  test('pop-out promotes the same conversation through the ordinary permanent flow', () => {
    pin(board, "new CustomEvent('topics:open-topic'");
    pin(board, "detail: { topicId: topic.id, topic, mode: 'permanent' },");
    pin(drawer, 'data-testid="board-orchestrator-popout"');
    pin(lifecycle, 'if (detail.topic) applyTopicFromWS(detail.topic)');
    pin(lifecycle, "openPanel(detail.topicId, detail.mode ?? 'preview', true, detail.topic)");
  });

  test('the coordinator glyph is in the palette — an unknown name falls back in silence', () => {
    pin(route, 'const ORCHESTRATOR_ICON = "Music4";');
    pin(route, 'icon: ORCHESTRATOR_ICON,');
    pin(route, 'if (result.topic.icon !== ORCHESTRATOR_ICON) {');
    pin(icons, '  Music4,\n');
  });
});
