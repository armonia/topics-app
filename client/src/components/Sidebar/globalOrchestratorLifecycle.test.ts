/**
 * Source-level pins: no client path archives the coordinator.
 * @covers GLOBAL-ORCHESTRATOR-LIFECYCLE-01
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SIDEBAR_DIR = import.meta.dir;
const read = (...path: string[]) => readFileSync(join(SIDEBAR_DIR, ...path), 'utf8');

const lifecycle = read('..', '..', 'hooks', 'usePanelLifecycle.ts');
const app = read('..', '..', 'App.tsx');
const topicItem = read('TopicItem.tsx');
const topicTree = read('TopicTree.tsx');
const contextMenu = read('..', 'Modals', 'ContextMenu.tsx');

describe('global Kanban coordinator lifecycle', () => {
  test('keeps the durable coordinator outside every close, reopen, and project-window archive transition', () => {
    expect(lifecycle).toContain('!resolvedTopic.isGlobalOrchestrator');
    expect(lifecycle).toContain('!t.isGlobalOrchestrator');
    expect(lifecycle).toContain('!topicsRef.current[id]?.isGlobalOrchestrator');
    expect(lifecycle).toContain('!closingTopic.isGlobalOrchestrator');
    expect(lifecycle).toContain('!topicsRef.current[pane.topicId]?.isGlobalOrchestrator');
  });

  test('removes only archive affordances while preserving normal topic controls', () => {
    expect(topicItem).toContain('{onArchive && !topic.isGlobalOrchestrator && (');
    expect(contextMenu).toContain('{!topic.isGlobalOrchestrator && <>');
    expect(topicTree).toContain('onStopStreaming={!topic.isGlobalOrchestrator && stopSession ? () => {');
  });

  test('does not let stale deferred or unpin callbacks archive a marked coordinator', () => {
    expect(app).toContain('const topicsRef = useRefMirror(topics);');
    expect(app).toContain('if (topic?.isGlobalOrchestrator) return Promise.resolve(false);');
    expect(app).toContain('if (!topicsRef.current[topicId]?.isGlobalOrchestrator) {');
    expect(app).toContain('if (!topic || topic.archived || topic.isGlobalOrchestrator) return false;');
  });
});
