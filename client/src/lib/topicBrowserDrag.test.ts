/**
 * @covers TOPIC-BROWSER-01
 * A pointer sample is only a proposal; position commits once when the gesture ends.
 */
import { describe, expect, it } from 'bun:test';
import { createAnimationFrameCoalescer, resolveTopicBrowserDragPosition, resolveTopicBrowserResize } from './topicBrowserDrag';

function fakeFrames() {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  const canceled: number[] = [];
  return {
    scheduler: {
      request(callback: () => void) {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      },
      cancel(id: number) {
        canceled.push(id);
        callbacks.delete(id);
      },
    },
    run() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
    pending: () => callbacks.size,
    canceled,
  };
}

describe('topic browser window dragging', () => {
  it('clamps the pointer-derived position to the area and composer floor', () => {
    expect(resolveTopicBrowserDragPosition({
      areaWidth: 800,
      areaHeight: 600,
      windowWidth: 420,
      windowHeight: 320,
      startLeft: 300,
      startTop: 150,
      deltaX: -100,
      deltaY: -50,
      minimumBottom: 40,
    })).toEqual({ right: 180, bottom: 180 });

    expect(resolveTopicBrowserDragPosition({
      areaWidth: 800,
      areaHeight: 600,
      windowWidth: 420,
      windowHeight: 320,
      startLeft: 300,
      startTop: 150,
      deltaX: 1000,
      deltaY: 1000,
      minimumBottom: 40,
    })).toEqual({ right: 0, bottom: 40 });
  });

  it('coalesces rapid pointer samples into one frame and applies the latest position', () => {
    const frames = fakeFrames();
    const applied: number[] = [];
    const queue = createAnimationFrameCoalescer(frames.scheduler, (position: number) => applied.push(position));

    queue.schedule(10);
    queue.schedule(20);
    queue.schedule(30);

    expect(frames.pending()).toBe(1);
    expect(applied).toEqual([]);
    frames.run();
    expect(applied).toEqual([30]);
  });

  it('flushes the final pointer sample once when pointerup beats the scheduled frame', () => {
    const frames = fakeFrames();
    const applied: number[] = [];
    const queue = createAnimationFrameCoalescer(frames.scheduler, (position: number) => applied.push(position));

    queue.schedule(12);
    queue.schedule(24);
    queue.flush();
    frames.run();

    expect(applied).toEqual([24]);
    expect(frames.pending()).toBe(0);
    expect(frames.canceled).toHaveLength(1);
  });
});

describe('topic browser window resizing', () => {
  const base = {
    areaWidth: 1000,
    areaHeight: 800,
    start: { left: 500, top: 400, width: 420, height: 320 },
    minWidth: 280,
    minHeight: 200,
    minimumBottom: 0,
  };

  it('a dragged left/top corner grows away from the bottom-right anchor', () => {
    expect(resolveTopicBrowserResize({ ...base, edges: { left: true, top: true }, deltaX: -100, deltaY: -50 })).toEqual({
      position: { right: 80, bottom: 80 },
      size: { width: 520, height: 370 },
    });
  });

  it('a dragged right/bottom corner moves the anchor, the left/top edges stay', () => {
    expect(resolveTopicBrowserResize({ ...base, edges: { right: true, bottom: true }, deltaX: 40, deltaY: 30 })).toEqual({
      position: { right: 40, bottom: 50 },
      size: { width: 460, height: 350 },
    });
  });

  it('stops at the area and at the minimum size, without dragging the opposite edge', () => {
    const grown = resolveTopicBrowserResize({ ...base, edges: { left: true, top: true }, deltaX: -5000, deltaY: -5000 });
    expect(grown).toEqual({ position: { right: 80, bottom: 80 }, size: { width: 920, height: 720 } });
    const shrunk = resolveTopicBrowserResize({ ...base, edges: { left: true }, deltaX: 5000, deltaY: 0 });
    expect(shrunk).toEqual({ position: { right: 80, bottom: 80 }, size: { width: 280, height: 320 } });
  });

  it('the bottom edge does not go below the composer floor', () => {
    const r = resolveTopicBrowserResize({
      ...base,
      start: { left: 500, top: 100, width: 420, height: 320 },
      edges: { bottom: true },
      deltaX: 0,
      deltaY: 1000,
      minimumBottom: 200,
    });
    expect(r.position.bottom).toBe(200);
    expect(r.size.height).toBe(500);
  });
});
