/**
 * @covers TOPIC-BROWSER-01
 * Pin the drag wiring that keeps the native page visible and follows its window.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

const windowSource = readFileSync(`${import.meta.dir}/TopicBrowserWindow.tsx`, 'utf8');
const moveStart = windowSource.indexOf('const startMove');
const resizeStart = windowSource.indexOf('const startResize', moveStart);
const moveSource = windowSource.slice(moveStart, resizeStart);
const runResizeStart = windowSource.indexOf('const runResize');
const resizeSource = windowSource.slice(runResizeStart, windowSource.indexOf('/** Hand the active sheet', runResizeStart));
const placeholderSource = readFileSync(`${import.meta.dir}/NativeBrowserPlaceholder.tsx`, 'utf8');

describe('topic browser window drag wiring', () => {
  it('captures and cancels the bar press without starting the native-view hide gate', () => {
    expect(moveStart).toBeGreaterThanOrEqual(0);
    expect(resizeStart).toBeGreaterThan(moveStart);
    expect(moveSource).toContain('setPointerCapture');
    expect(moveSource).toContain('preventDefault');
    expect(moveSource).toContain('suppressTextSelection');
    expect(moveSource).not.toContain('freezeNativeViews');
  });

  it('requests native bounds from the already scheduled animation frame', () => {
    expect(moveSource).toContain('createAnimationFrameCoalescer');
    expect(moveSource).toContain('requestReflow(state.activeContextId, true)');
    expect(placeholderSource).toContain('ce.detail?.atAnimationFrame');
    expect(placeholderSource).toContain('updateBounds();');
  });

  it('resizes live: no native-view hide gate, store committed once per frame', () => {
    expect(runResizeStart).toBeGreaterThanOrEqual(0);
    expect(windowSource).not.toContain('topics:pane-resize-start');
    expect(resizeSource).toContain('setPointerCapture');
    expect(resizeSource).toContain('createAnimationFrameCoalescer');
    expect(resizeSource).toContain('topicBrowserWindow.setWidth(topicId, width)');
    expect(resizeSource).toContain('topicBrowserWindow.resizeFloating(topicId');
    // The page's bounds leave in the same frame as the DOM's new size.
    expect(windowSource).toContain('useLayoutEffect(() => {');
    expect(windowSource).toContain('requestReflow(state.activeContextId ?? undefined, true)');
  });
});
