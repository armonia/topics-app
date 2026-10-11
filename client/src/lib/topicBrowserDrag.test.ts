/**
 * @covers TOPIC-BROWSER-01
 * A pointer sample is only a proposal; position commits once when the gesture ends.
 */
import { describe, expect, it } from 'bun:test';
import { createAnimationFrameCoalescer, resolveTopicBrowserDragPosition } from './topicBrowserDrag';

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
