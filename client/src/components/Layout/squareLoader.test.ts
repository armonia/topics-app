/**
 * The square loader runs by the dozen, so its cost is part of the contract:
 * 50 bodies on one clock stay under 2 ms of work per frame, and a hidden
 * window draws nothing at all.
 */
import { describe, expect, test } from "bun:test";
import { createLoaderClock, LoaderBody, type ClockClient, type LoaderActivity, type LoaderContext } from "./squareLoader";

function fakeContext(counter: { fills: number; clears: number }): LoaderContext {
  return {
    clearRect: () => { counter.clears++; },
    beginPath: () => {},
    roundRect: () => {},
    fill: () => { counter.fills++; },
    fillStyle: "",
    globalAlpha: 1,
  };
}

const MOVEMENTS: LoaderActivity[] = ["think", "search", "write", "tool", "sync", "wait", "think", "search", "write", "tool"];
const SIZES = [12, 16, 20, 20, 14];

function setup(count: number) {
  const counter = { fills: 0, clears: 0 };
  const clients: ClockClient[] = Array.from({ length: count }, (_, i) => {
    const size = SIZES[i % SIZES.length];
    const activity = MOVEMENTS[i % MOVEMENTS.length];
    return { body: new LoaderBody(size, fakeContext(counter), { scale: 2, hollow: size === 20 && i % 2 === 0 }), activity: () => activity, color: () => "rgb(0,0,0)" };
  });
  let hidden = false;
  let pending: ((ms: number) => void) | null = null;
  const clock = createLoaderClock({
    raf: (cb) => { pending = cb; return 1; },
    cancel: () => { pending = null; },
    hidden: () => hidden,
  });
  const frame = (ms: number) => { const cb = pending; pending = null; cb?.(ms); };
  return { counter, clients, clock, frame, setHidden: (v: boolean) => { hidden = v; clock.visibilityChanged(); }, isScheduled: () => pending !== null };
}

describe("square loader clock", () => {
  test("50 loaders cost under 2 ms of work per frame on average", () => {
    const { clients, clock, frame } = setup(50);
    clients.forEach((c) => clock.add(c));
    // Warm up so the one-off shape assignment is not counted as steady state.
    let ms = 1000;
    for (let i = 0; i < 20; i++) { ms += 16.7; frame(ms); }
    const frames = 240;
    const started = performance.now();
    for (let i = 0; i < frames; i++) { ms += 16.7; frame(ms); }
    const perFrame = (performance.now() - started) / frames;
    console.log(`square loader: 50 bodies, ${perFrame.toFixed(3)} ms per frame`);
    expect(perFrame).toBeLessThan(2);
  });

  test("a hidden window draws nothing and stops asking for frames", () => {
    const { clients, clock, frame, counter, setHidden, isScheduled } = setup(50);
    clients.forEach((c) => clock.add(c));
    frame(1000);
    expect(counter.fills).toBeGreaterThan(0);
    setHidden(true);
    const before = counter.clears;
    expect(isScheduled()).toBe(false);
    frame(1100);
    frame(1200);
    expect(counter.clears).toBe(before);
    setHidden(false);
    expect(isScheduled()).toBe(true);
  });

  test("bodies under 24px step at most 30 times a second, larger ones every frame", () => {
    const { clock, frame, counter } = setup(0);
    const small = { body: new LoaderBody(16, fakeContext(counter), { scale: 2 }), activity: () => "think" as const, color: () => "red" };
    const large = { body: new LoaderBody(32, fakeContext(counter), { scale: 2 }), activity: () => "think" as const, color: () => "red" };
    clock.add(small);
    clock.add(large);
    for (let i = 0; i < 60; i++) frame(1000 + i * (1000 / 60));
    expect(clock.stats.draws).toBeGreaterThan(80);
    expect(clock.stats.draws).toBeLessThanOrEqual(60 + 31);
  });

  test("with no loader registered the clock does not schedule a frame", () => {
    const { clients, clock, isScheduled } = setup(2);
    clients.forEach((c) => clock.add(c));
    expect(isScheduled()).toBe(true);
    clients.forEach((c) => clock.remove(c));
    expect(isScheduled()).toBe(false);
  });
});

describe("hollow body", () => {
  test("keeps the centre of the 9x9 grid free", () => {
    const rects: Array<[number, number]> = [];
    const ctx = { ...fakeContext({ fills: 0, clears: 0 }), roundRect: (x: number, y: number) => { rects.push([x, y]); } };
    const body = new LoaderBody(20, ctx, { scale: 2, hollow: true });
    body.snap("think", 2);
    body.draw("black");
    expect(rects.length).toBeGreaterThan(0);
    // 20px at 2x is 40px, cells of 4px: edge cells sit at 0.5 and 32.5, inner ones between.
    for (const [x, y] of rects) expect(x < 3 || x > 30 || y < 3 || y > 30).toBe(true);
  });
});
