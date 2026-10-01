/**
 * One marker per context per message, and only for openings that worked.
 *
 * @covers CHAT-BROWSER-01
 */
import { describe, expect, test } from 'bun:test';
import type { ToolCall } from '../../types';
import { browserMarkerState, coalesceBrowserOpens, currentPage, markerTitle } from './browserOpens';

const opened = (id: string, url: string, extra: { contextId?: string; title?: string; name?: string; visible?: boolean } = {}): ToolCall => {
  const where = url + (extra.title ? ` (title: ${extra.title})` : '');
  const head = extra.visible === false ? `Browser context ready at ${where} — but NO visible pane is mounted.` : `Opened browser pane at ${where}`;
  return {
    id,
    name: 'mcp__topics__open_browser_pane',
    args: { url, ...(extra.name ? { name: extra.name } : {}) },
    status: 'success',
    result: extra.contextId ? `${head} [contextId: ${extra.contextId}]` : head,
    endedAt: Number(id.replace(/\D/g, '')) || undefined,
  };
};
const read = (id: string): ToolCall => ({ id, name: 'Read', args: { file_path: '/a.ts' }, status: 'success' });

describe('coalesceBrowserOpens', () => {
  test('three openings of one context are ONE marker, on the first, showing the last page', () => {
    const tools = [
      opened('o1', 'http://localhost:5173/a', { contextId: 'topic-1', title: 'A' }),
      read('r1'),
      opened('o2', 'http://localhost:5173/b', { contextId: 'topic-1', title: 'B' }),
      opened('o3', 'http://localhost:5173/c', { contextId: 'topic-1', title: 'C' }),
    ];
    const plan = coalesceBrowserOpens(tools);

    const marker = plan.get('o1')!;
    expect(marker.pages.map((p) => p.url)).toEqual(['http://localhost:5173/a', 'http://localhost:5173/b', 'http://localhost:5173/c']);
    expect(currentPage(marker).url).toBe('http://localhost:5173/c');
    expect(markerTitle(marker)).toBe('C');
    expect(plan.get('o2')).toBeNull();
    expect(plan.get('o3')).toBeNull();
    expect(plan.has('r1')).toBe(false);
  });

  test('two contexts are two markers, named as the agent named them', () => {
    const plan = coalesceBrowserOpens([
      opened('o1', 'https://app.test/', { contextId: 'task-1-napp', name: 'App', title: 'Home' }),
      opened('o2', 'https://report.test/', { contextId: 'task-1-nreport', name: 'Report' }),
    ]);
    expect([plan.get('o1'), plan.get('o2')].map((m) => markerTitle(m!))).toEqual(['App', 'Report']);
  });

  test('old rows without a context share the topic one', () => {
    const plan = coalesceBrowserOpens([opened('o1', 'https://example.com/'), opened('o2', 'https://example.com/x')]);
    expect(plan.get('o1')!.pages).toHaveLength(2);
    expect(plan.get('o1')!.contextId).toBeUndefined();
    expect(markerTitle(plan.get('o1')!)).toBe('example.com');
  });

  test('a failed or still running opening is not a marker', () => {
    const failed: ToolCall = { ...opened('o1', 'http://localhost:1/'), status: 'error', result: 'navigation failed: goto: net::ERR_CONNECTION_REFUSED' };
    const running: ToolCall = { ...opened('o2', 'http://localhost:2/'), status: 'running', result: undefined };
    expect(coalesceBrowserOpens([failed, running]).size).toBe(0);
  });

  test('the marker says off-screen only while its LAST opening was', () => {
    const plan = coalesceBrowserOpens([
      opened('o1', 'https://a.test/', { contextId: 'c', visible: false }),
      opened('o2', 'https://a.test/', { contextId: 'c', visible: true }),
    ]);
    expect(plan.get('o1')!.visible).toBe(true);
  });
});

describe('browserMarkerState', () => {
  test('from where the page lives now', () => {
    expect(browserMarkerState('window', true)).toBe('window');
    expect(browserMarkerState('layout', true)).toBe('tab');
    expect(browserMarkerState('task', false)).toBe('tab');
    expect(browserMarkerState(null, true)).toBe('closed');
    expect(browserMarkerState(null, undefined)).toBe('closed');
    expect(browserMarkerState(null, false)).toBe('offscreen');
  });
});
