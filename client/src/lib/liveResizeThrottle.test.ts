/**
 * @covers TOPIC-BROWSER-01
 * During a drag the remote page follows the pane: sizes leave as they come,
 * at most every interval, and the last one always leaves.
 */
import { describe, expect, it } from 'bun:test';
import { createLiveResizeThrottle, type LiveResizeClock } from './liveResizeThrottle';

function fakeClock() {
  let t = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const clock: LiveResizeClock = {
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: t + ms, fn, id }); return id; },
    clearTimer: (id) => { timers = timers.filter(x => x.id !== id); },
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter(x => x !== due);
      t = due.at;
      due.fn();
    }
    t = end;
  };
  return { clock, advance };
}

describe('createLiveResizeThrottle', () => {
  it('sends the first change at once', () => {
    const { clock } = fakeClock();
    let runs = 0;
    createLiveResizeThrottle(() => { runs++; }, 50, clock).schedule();
    expect(runs).toBe(1);
  });

  it('keeps sending while the size keeps changing, instead of waiting for it to stop', () => {
    const { clock, advance } = fakeClock();
    let runs = 0;
    const th = createLiveResizeThrottle(() => { runs++; }, 50, clock);
    // A drag: a ResizeObserver tick every frame for half a second, never a pause.
    for (let i = 0; i < 30; i++) { th.schedule(); advance(16); }
    // A debounce would have sent 0 here; the throttle sent about every 50 ms.
    expect(runs).toBeGreaterThanOrEqual(8);
    expect(runs).toBeLessThanOrEqual(11);
  });

  it('the last change of a burst always leaves', () => {
    const { clock, advance } = fakeClock();
    const sent: number[] = [];
    let width = 400;
    const th = createLiveResizeThrottle(() => { sent.push(width); }, 50, clock);
    th.schedule();
    width = 420; advance(10); th.schedule();
    width = 440; advance(10); th.schedule();
    advance(100);
    expect(sent).toEqual([400, 440]);
  });

  it('cancel drops the pending run', () => {
    const { clock, advance } = fakeClock();
    let runs = 0;
    const th = createLiveResizeThrottle(() => { runs++; }, 50, clock);
    th.schedule();
    advance(10); th.schedule();
    th.cancel();
    advance(100);
    expect(runs).toBe(1);
  });
});
