import { describe, expect, test } from 'bun:test';
import { createEchoHold, flingVelocity, scrollKeepingFractions } from './mirrorScroll';

/** @covers BROWSER-DOM-SCROLL-01 */

describe('flingVelocity', () => {
  test('the speed of the last 100ms of moves, in px per ms', () => {
    const moves = [
      { t: 0, dx: 0, dy: 50 }, // older than the window
      { t: 900, dx: 0, dy: 10 },
      { t: 916, dx: 0, dy: 16 },
      { t: 932, dx: 4, dy: 16 },
    ];
    const { vx, vy } = flingVelocity(moves, 940);
    expect(vy).toBeCloseTo(32 / 32);
    expect(vx).toBeCloseTo(4 / 32);
  });

  test('a finger that stopped before lifting, or a single move, flings nothing', () => {
    const moves = [{ t: 900, dx: 0, dy: 20 }, { t: 916, dx: 0, dy: 20 }];
    expect(flingVelocity(moves, 990)).toEqual({ vx: 0, vy: 0 });
    expect(flingVelocity([{ t: 900, dx: 0, dy: 20 }], 905)).toEqual({ vx: 0, vy: 0 });
    expect(flingVelocity([], 0)).toEqual({ vx: 0, vy: 0 });
  });
});

/** An element with WebKit's whole pixels, `max` px of room. */
function wholePixels(max = 10_000): Element {
  let top = 0;
  return {
    get scrollTop() { return top; },
    get scrollLeft() { return 0; },
    scrollTo(o: { top: number }) { top = Math.max(0, Math.min(max, Math.trunc(o.top))); },
  } as unknown as Element;
}

/** @covers BROWSER-DOM-SCROLL-02 */
describe('scrollKeepingFractions', () => {
  test('the fractions carry over: sixty steps of 2.7 px land on 162, not on 120', () => {
    const el = wholePixels();
    let pos: { top: number; left: number } | null = null;
    for (let i = 0; i < 60; i++) pos = scrollKeepingFractions(el, pos, 0, 2.7).pos;
    expect(el.scrollTop).toBe(162);
  });

  test('whatever else moved the element starts over from where it is', () => {
    const el = wholePixels();
    const { pos } = scrollKeepingFractions(el, null, 0, 10.4);
    el.scrollTo({ top: 50 }); // the source's echo
    scrollKeepingFractions(el, pos, 0, 1);
    expect(el.scrollTop).toBe(51);
  });

  test('at its edge nothing moves, and it says so', () => {
    const el = wholePixels(100);
    el.scrollTo({ top: 100 });
    expect(scrollKeepingFractions(el, null, 0, 5).moved).toBe(false);
    expect(scrollKeepingFractions(el, null, 0, -5).moved).toBe(true);
  });
});

type Echo = { type: number; data: { source: number; id: number; x: number; y: number; scrollSeq?: number; scrollFrom?: string } };

/** A hold on a clock the test turns, and the positions it applied, batch by batch. */
function holdRig() {
  let t = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const applied: number[][] = [];
  const hold = createEchoHold<Echo>({
    now: () => t,
    schedule: (fn, ms) => {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return () => { timer.live = false; };
    },
  });
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      t = next.at;
      next.live = false;
      next.fn();
    }
    t = end;
  };
  hold.applyWith((events) => applied.push(events.map((e) => e.data.y)));
  const echo = (id: number, y: number, scrollSeq?: number, scrollFrom = 'me'): Echo =>
    ({ type: 3, data: { source: 3, id, x: 0, y, ...(scrollSeq === undefined ? {} : { scrollSeq, scrollFrom }) } });
  return { hold, applied, advance, echo };
}

/** @covers BROWSER-DOM-SCROLL-02 */
describe('createEchoHold', () => {
  test('during the gesture the echoes wait, and only the latest per node lands when it ends', () => {
    const r = holdRig();
    r.hold.moved();
    expect(r.hold.hold(r.echo(1, 10))).toBe(true);
    expect(r.hold.hold(r.echo(1, 20))).toBe(true);
    r.advance(700);
    expect(r.applied).toEqual([[20]]);
  });

  test('a late source: its older echoes wait for the one at the relayed place, which ends the wait', () => {
    const r = holdRig();
    r.hold.moved();
    r.hold.relayed({ node: 1, top: 300, left: 0 });
    r.advance(700);
    expect(r.hold.hold(r.echo(1, 120))).toBe(true);
    expect(r.hold.hold(r.echo(1, 300))).toBe(false);
    r.advance(3_000);
    expect(r.applied).toEqual([]);
  });

  test('a source that never gets there is believed once it has had its time', () => {
    const r = holdRig();
    r.hold.moved();
    r.hold.relayed({ node: 1, top: 300, left: 0 });
    expect(r.hold.hold(r.echo(1, 0))).toBe(true);
    r.advance(1_900);
    expect(r.applied).toEqual([]);
    r.advance(200);
    expect(r.applied).toEqual([[0]]);
  });

  test('another node waits only for the gesture, not for the source to confirm', () => {
    const r = holdRig();
    r.hold.moved();
    r.hold.relayed({ node: 1, top: 300, left: 0 });
    r.hold.hold(r.echo(1, 100));
    r.hold.hold(r.echo(2, 50));
    r.advance(700);
    expect(r.applied).toEqual([[50]]);
    expect(r.hold.hold(r.echo(2, 60))).toBe(false);
    r.advance(1_400);
    expect(r.applied).toEqual([[50], [100]]);
  });

  test('what is not a scroll echo is never held', () => {
    const r = holdRig();
    r.hold.moved();
    expect(r.hold.hold({ type: 3, data: { source: 0, id: 1, x: 0, y: 0 } })).toBe(false);
    expect(r.hold.hold({ type: 2, data: { source: 3, id: 1, x: 0, y: 0 } })).toBe(false);
  });

  test('a numbered echo older than the latest relay is dropped, however late it comes', () => {
    const r = holdRig();
    r.hold.forwarded(2, 'me');
    r.advance(2_500);
    expect(r.hold.hold(r.echo(1, 120, 1))).toBe(true);
    r.advance(5_000);
    expect(r.applied).toEqual([]);
  });

  test('the answer to the latest relay lands once the gesture is over, with no confirmation to wait out', () => {
    const r = holdRig();
    r.hold.moved();
    r.hold.relayed({ node: 1, top: 300, left: 0 });
    r.hold.forwarded(2, 'me');
    r.advance(700);
    // Not the relayed place (the page kept part of the wheel), and still where the source is.
    expect(r.hold.hold(r.echo(1, 320, 2))).toBe(false);
  });

  test('mid-gesture even the answer to the latest relay waits: the mirror is already past it', () => {
    const r = holdRig();
    r.hold.moved();
    r.hold.forwarded(1, 'me');
    // A fast connection: the answer is back before the next batch goes out.
    expect(r.hold.hold(r.echo(1, 100, 1))).toBe(true);
    expect(r.applied).toEqual([]);
    r.advance(700);
    expect(r.applied).toEqual([[100]]);
  });

  test('a held answer that a newer relay overtakes is dropped, not applied late', () => {
    const r = holdRig();
    r.hold.moved();
    r.hold.forwarded(1, 'me');
    r.hold.hold(r.echo(1, 100, 1));
    r.hold.forwarded(2, 'me');
    r.advance(700);
    expect(r.applied).toEqual([]);
    expect(r.hold.hold(r.echo(1, 180, 2))).toBe(false);
  });

  test("another viewer's relay is not ordered against this one's: the page moved for them", () => {
    const r = holdRig();
    r.hold.forwarded(40, 'me');
    r.advance(700);
    // The source echoes the last relay it got, which was another device's third.
    expect(r.hold.hold(r.echo(1, 500, 3, 'them'))).toBe(false);
  });
});
