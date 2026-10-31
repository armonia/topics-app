/**
 * The end of a turn waits for the frame that shows its last words
 * (`textPaintGate.ts`, card 40ea050c). The wiring is measured end to end by
 * `tests/e2e/chat-turn-end-still.spec.ts` (scenario `quick`); here, the gate
 * alone, on a hand-driven frame clock.
 *
 * @covers USAGE-20
 */
import { describe, expect, test } from 'bun:test';
import { PAINT_GATE_FALLBACK_MS, TextPaintGate, type FrameScheduler } from './textPaintGate';

function clock() {
  let frames: Array<() => void> = [];
  const timers: Array<{ at: number; cb: () => void }> = [];
  let now = 0;
  const scheduler: FrameScheduler = {
    requestFrame: (cb) => { frames.push(cb); },
    setTimer: (cb, ms) => { timers.push({ at: now + ms, cb }); },
  };
  return {
    scheduler,
    /** One animation frame: the callbacks queued before it run, the ones they queue wait. */
    frame() {
      const due = frames;
      frames = [];
      for (const cb of due) cb();
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers.splice(0)) {
        if (t.at <= now) t.cb();
        else timers.push(t);
      }
    },
  };
}

describe('the end of a turn waits for its last words to be painted', () => {
  test('nothing committed: the end runs at once', () => {
    const c = clock();
    const gate = new TextPaintGate(c.scheduler);
    let ran = false;
    gate.afterPaint('s', () => { ran = true; });
    expect(gate.isPending('s')).toBe(false);
    expect(ran).toBe(true);
  });

  test('text committed in this frame: the end runs after the next frame has been painted', () => {
    const c = clock();
    const gate = new TextPaintGate(c.scheduler);
    gate.markCommitted('s');
    let ran = false;
    gate.afterPaint('s', () => { ran = true; });
    expect(ran).toBe(false);
    // The frame the commit renders in: not painted yet when its callbacks run.
    c.frame();
    expect(ran).toBe(false);
    // The next frame's callback comes after that paint.
    c.frame();
    expect(ran).toBe(true);
    expect(gate.isPending('s')).toBe(false);
  });

  test('text committed again meanwhile: the end waits for the frame that shows the latest words', () => {
    const c = clock();
    const gate = new TextPaintGate(c.scheduler);
    gate.markCommitted('s');
    c.frame();
    gate.markCommitted('s');
    let ran = false;
    gate.afterPaint('s', () => { ran = true; });
    c.frame();
    // The first commit's two frames are over, the second commit's are not.
    expect(ran).toBe(false);
    c.frame();
    expect(ran).toBe(true);
  });

  test('a session waits only for its own text', () => {
    const c = clock();
    const gate = new TextPaintGate(c.scheduler);
    gate.markCommitted('other');
    let ran = false;
    gate.afterPaint('s', () => { ran = true; });
    expect(ran).toBe(true);
    expect(gate.isPending('other')).toBe(true);
  });

  test('a page that paints no frame (a hidden tab) lets the end through on the timer', async () => {
    const c = clock();
    const gate = new TextPaintGate(c.scheduler);
    gate.markCommitted('s');
    const order: string[] = [];
    gate.afterPaint('s', () => order.push('first'));
    const done = gate.painted('s').then(() => order.push('second'));
    c.advance(PAINT_GATE_FALLBACK_MS - 1);
    expect(order).toEqual([]);
    c.advance(1);
    await done;
    expect(order).toEqual(['first', 'second']);
    // The frames that come later find it released and do nothing twice.
    c.frame();
    c.frame();
    expect(order).toEqual(['first', 'second']);
  });
});
