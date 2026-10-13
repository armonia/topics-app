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
});
