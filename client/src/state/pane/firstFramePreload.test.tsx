import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Suspense } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { firstFrameLoaders, loadChatPane, loadPanelGrid, loadTopicTree } from './panePreload';
import { lazyWarm, warm } from '../../lib/lazyWarm';

function Body() {
  return <section>chat ready</section>;
}

function usesSharedWarmLoader(source: string): boolean {
  return /lazyWarm\(loadChatPane/.test(source);
}

function readLayoutSource(file: string): string {
  const copyRoot = process.env.D2D_MUTATION_SOURCE_ROOT;
  return copyRoot
    ? readFileSync(`${copyRoot}/${file}`, 'utf8')
    : readFileSync(new URL(`../../components/Layout/${file}`, import.meta.url), 'utf8');
}

describe('first-frame app chunks', () => {
  test('always warms TopicTree and PanelGrid, and warms ChatPane only for a visible chat', () => {
    const withoutChat = firstFrameLoaders([{ type: 'board' }]);
    expect(withoutChat).toContain(loadTopicTree);
    expect(withoutChat).toContain(loadPanelGrid);
    expect(withoutChat).not.toContain(loadChatPane);

    expect(firstFrameLoaders([{ type: 'chat' }])).toContain(loadChatPane);
  });

  test('a warmed module renders without fallback', async () => {
    const loader = () => Promise.resolve({ ChatPane: Body });
    await warm(loader);
    const WarmChatPane = lazyWarm(loader, (module) => module.ChatPane);
    const html = renderToStaticMarkup(
      <Suspense fallback={<i>spinner</i>}><WarmChatPane /></Suspense>,
    );
    expect(html).toContain('chat ready');
    expect(html).not.toContain('spinner');
  });

  test('ChatPanel and ProjectWindow keep the shared warm wrapper', () => {
    const chatPanel = readLayoutSource('ChatPanel.tsx');
    const projectWindow = readLayoutSource('ProjectWindow.tsx');
    expect(usesSharedWarmLoader(chatPanel)).toBe(true);
    expect(usesSharedWarmLoader(projectWindow)).toBe(true);
    expect(usesSharedWarmLoader(chatPanel.replace('lazyWarm(loadChatPane', 'lazy(loadChatPane'))).toBe(false);
  });
});
