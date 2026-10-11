/**
 * @covers BROWSER-CHAT-04
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../../test/reactHarness';
import { openInTopicWindow } from '../../lib/topicWindowDoor';
import { loadTopicWindowStore, usePaneWindowDoor, type TopicBrowserPresence } from './topicBrowserWindowLazy';
import { __resetTopicWindows } from '../../state/topicBrowserWindow';

const TOPIC = 'project-chat-agent-first-open';
const ABSENT: TopicBrowserPresence = { mode: 'hidden', expandedWidth: null, sheets: 0, promoted: 0 };
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetTopicWindows();
});

describe('project chat agent browser door', () => {
  it('accepts the first agent page in the minimized topic window while the first link stays in the project', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const store = await loadTopicWindowStore();
    await store.ensureTopicWindowLoaded(TOPIC);

    function Probe() {
      usePaneWindowDoor(TOPIC, ABSENT);
      return null;
    }

    const harness = mount(createElement(Probe));
    try {
      expect(openInTopicWindow(TOPIC, {
        contextId: TOPIC,
        url: 'https://example.test/agent',
        openedBy: 'agent',
      })).toBe(true);
      expect(openInTopicWindow(TOPIC, {
        contextId: 'clicked-link',
        url: 'https://example.test/link',
        openedBy: 'link',
      })).toBe(false);
      expect(openInTopicWindow(TOPIC, {
        contextId: 'slash-command',
        url: 'https://example.test/user',
        openedBy: 'user',
      })).toBe(false);

      await Promise.resolve();
      await Promise.resolve();
      expect(store.getTopicWindow(TOPIC)).toMatchObject({
        mode: 'min',
        activeContextId: TOPIC,
        tabs: [{ contextId: TOPIC, url: 'https://example.test/agent', openedBy: 'agent' }],
      });
    } finally {
      harness.unmount();
    }
  });
});
