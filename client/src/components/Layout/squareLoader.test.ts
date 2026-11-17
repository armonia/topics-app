/**
 * The square loader runs by the dozen, so its cost is part of the contract:
 * 50 bodies on one clock stay under 2 ms of work per frame, and a hidden
 * window draws nothing at all.
 *
 * @covers LAYOUT-33
 */
import { describe, expect, test } from "bun:test";
import { loaderOutcomeInkClass } from "./loaderState";
import { createLoaderClock, LoaderBody, SETTLE_S, type ClockClient, type LoaderActivity, type LoaderContext } from "./squareLoader";

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
    // A new body grows out of nothing, so the first frames may draw no square yet.
    for (let i = 0; i < 20; i++) frame(1000 + i * 34);
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
    // A change of shape gets every frame: the cap starts once the body has settled.
    for (let i = 0; i < 90; i++) frame(1000 + i * (1000 / 60));
    const settled = clock.stats.draws;
    for (let i = 90; i < 150; i++) frame(1000 + i * (1000 / 60));
    const draws = clock.stats.draws - settled;
    expect(draws).toBeGreaterThan(80);
    expect(draws).toBeLessThanOrEqual(60 + 31);
  });

  test("with no loader registered the clock does not schedule a frame", () => {
    const { clients, clock, isScheduled } = setup(2);
    clients.forEach((c) => clock.add(c));
    expect(isScheduled()).toBe(true);
    clients.forEach((c) => clock.remove(c));
    expect(isScheduled()).toBe(false);
  });
});

describe("a change of shape", () => {
  const ALL: LoaderActivity[] = ["rest", "think", "search", "write", "tool", "sync", "wait", "done", "error"];
  /** The faintest square a small body draws for any shape: 0.1 of light, drawn at its root. */
  const FLOOR = 0.3;

  function minAlphaDuringChange(size: number, from: LoaderActivity, to: LoaderActivity): number {
    let minAlpha = 1;
    const ctx: LoaderContext = {
      clearRect: () => {},
      beginPath: () => {},
      roundRect: () => { minAlpha = Math.min(minAlpha, ctx.globalAlpha); },
      fill: () => {},
      fillStyle: "",
      globalAlpha: 1,
    };
    const body = new LoaderBody(size, ctx, { scale: 2 });
    let t = 5;
    for (let i = 0; i < 120; i++) { body.step(from, t, 1 / 30); t += 1 / 30; }
    for (let i = 0; i < 30; i++) { body.step(to, t, 1 / 30); t += 1 / 30; body.draw("black"); }
    return minAlpha;
  }

  // Before, the squares left over faded out on the way, all the way down to nothing.
  test("no square fades away: leftovers shrink instead", () => {
    for (const size of [12, 20]) {
      for (const from of ALL) for (const to of ALL) {
        if (from !== to) expect(minAlphaDuringChange(size, from, to), `${size}px ${from} to ${to}`).toBeGreaterThanOrEqual(FLOOR);
      }
    }
  });
});

describe("a change never cuts a change short", () => {
  const blank = fakeContext({ fills: 0, clears: 0 });
  /** Requests one shape after another every `everyS`, for `n` requests; returns the shapes really started and whether each began from a settled body. */
  function play(everyS: number, seq: LoaderActivity[]) {
    const body = new LoaderBody(12, blank, { scale: 2 });
    const dt = 1 / 60;
    let t = 5;
    for (let i = 0; i < 120; i++) { body.step(seq[0], t, dt); t += dt; }
    const t0 = t;
    const started: LoaderActivity[] = [];
    let lastChange = t0 - 2;
    let fromSettled = true;
    while (t - t0 < everyS * seq.length + 2) {
      const before = body.shape;
      body.step(seq[Math.min(seq.length - 1, Math.floor((t - t0) / everyS))], t, dt);
      if (body.shape !== before) {
        started.push(body.shape!);
        if (t - lastChange < SETTLE_S - 1e-9) fromSettled = false;
        lastChange = t;
      }
      t += dt;
    }
    return { started, fromSettled };
  }
  const SEQ: LoaderActivity[] = ["think", "search", "tool", "write", "think", "search", "tool", "write", "wait"];

  // Before, actions 700 ms apart restarted the change before it settled: 7 of 8 changes were cut short.
  test("actions every 700 ms: every change starts from a settled body, and the last one is reached", () => {
    const { started, fromSettled } = play(0.7, SEQ);
    expect(fromSettled).toBe(true);
    expect(started.at(-1)).toBe("wait");
    expect(started.length).toBeGreaterThanOrEqual(5);
  });

  test("actions slower than the change all play, in order", () => {
    expect(play(SETTLE_S + 0.2, SEQ).started).toEqual(SEQ.slice(1));
  });

  test("the still frame of reduced motion changes shape at once", () => {
    const counter = { fills: 0, clears: 0 };
    const body = new LoaderBody(12, fakeContext(counter), { scale: 2 });
    body.snap("think", 2);
    body.snap("tool", 2);
    expect(body.shape).toBe("tool");
  });
});

/** Steps `bodies` on one shared clock at 60 fps; each one is born (first steps) at its own time and is asked for `asked(t)`. */
function playShared(births: number[], asked: (t: number) => LoaderActivity, until: number) {
  const dt = 1 / 60;
  const bodies = births.map(() => new LoaderBody(12, fakeContext({ fills: 0, clears: 0 }), { scale: 2, onGrid: true }));
  const changes: Array<Array<{ t: number; shape: LoaderActivity }>> = births.map(() => []);
  const frames = Math.round(until / dt);
  for (let i = 0; i <= frames; i++) {
    const t = i * dt;
    bodies.forEach((b, k) => {
      if (t < births[k]) return;
      const before = b.shape;
      b.step(asked(t), t, dt);
      if (b.shape !== before) changes[k].push({ t, shape: b.shape! });
    });
  }
  return { bodies, changes };
}

describe("loaders of one chat change shape in the same frame", () => {
  // One chat, three loaders (the tab, the sidebar row, the project row), each born when its surface mounted.
  const ASKED: Array<[number, LoaderActivity]> = [[0, "think"], [5.9, "tool"], [6.4, "write"], [7.5, "search"], [8.2, "think"], [10.3, "wait"]];
  const asked = (t: number): LoaderActivity => ASKED.filter(([from]) => t >= from).at(-1)![1];

  test("born in the same second, they change at the same time, every time", () => {
    const { changes } = playShared([5.3, 5.8], asked, 14);
    // The first entry of each list is the birth itself, which is at its own time by definition.
    expect(changes[0].length).toBeGreaterThanOrEqual(5);
    expect(changes[1].slice(1)).toEqual(changes[0].slice(1));
  });

  test("born in different seconds, they meet on the grid after their first change", () => {
    const { changes } = playShared([5.3, 6.2], asked, 14);
    const late = (c: typeof changes[0]) => c.filter((x) => x.t >= 8.5);
    expect(late(changes[0]).length).toBeGreaterThanOrEqual(2);
    expect(late(changes[1])).toEqual(late(changes[0]));
  });

  test("every change still starts from a settled body", () => {
    const { changes } = playShared([5.3, 5.8, 6.2], asked, 14);
    for (const list of changes) {
      for (let i = 1; i < list.length; i++) expect(list[i].t - list[i - 1].t).toBeGreaterThanOrEqual(SETTLE_S - 1e-6);
    }
  });

  test("without the grid a body keeps counting from its own start (the tray's frames depend on it)", () => {
    const a = new LoaderBody(12, fakeContext({ fills: 0, clears: 0 }), { scale: 2 });
    const dt = 1 / 60;
    let t = 5.3;
    a.step("think", t, dt);
    let changedAt = 0;
    for (let i = 0; i < 180 && !changedAt; i++) { t += dt; a.step("tool", t, dt); if (a.shape === "tool") changedAt = t; }
    expect(changedAt).toBeCloseTo(6.3, 1);
  });
});

describe("the colour of an outcome follows the shape on screen", () => {
  test("a done that arrives in the middle of a change stays the colour of the work until the shape is done", () => {
    const body = new LoaderBody(12, fakeContext({ fills: 0, clears: 0 }), { scale: 2, onGrid: true });
    const dt = 1 / 60;
    // think from 5.0; tool asked at 7.2 starts at once (the first settle is over) and holds the grid until 9;
    // done asked at 7.5 must wait for it, and its green must wait with it.
    const asked = (t: number): LoaderActivity => (t >= 7.5 ? "done" : t >= 7.2 ? "tool" : "think");
    const inkWhileWaiting = new Set<string>();
    let doneAt = 0;
    for (let i = 0; i < Math.round(10 / dt); i++) {
      const t = 5 + i * dt;
      body.step(asked(t), t, dt);
      const ink = loaderOutcomeInkClass(body.shape);
      if (t >= 7.5 && body.shape !== "done") inkWhileWaiting.add(ink);
      if (body.shape === "done" && !doneAt) doneAt = t;
      expect(ink === "text-green-500", `t=${t.toFixed(2)} shape=${body.shape}`).toBe(body.shape === "done");
    }
    expect(inkWhileWaiting).toEqual(new Set([""]));
    // The wait really happened: done was asked at 7.5 and arrived at the first whole second after tool settled.
    expect(doneAt).toBeGreaterThanOrEqual(9 - 1e-6);
    expect(doneAt).toBeLessThan(9.1);
    // ...so tool, which began at 7.2, had its whole settle before done started.
    expect(doneAt - 7.2).toBeGreaterThanOrEqual(SETTLE_S);
  });

  test("an error is red and nothing else is", () => {
    expect(loaderOutcomeInkClass("error")).toBe("text-red-500");
    for (const shape of ["think", "search", "write", "tool", "wait", "sync", "rest", null]) expect(loaderOutcomeInkClass(shape)).toBe("");
  });
});

describe("hollow body", () => {
  test("keeps the centre free for the number", () => {
    const rects: Array<[number, number]> = [];
    const ctx = { ...fakeContext({ fills: 0, clears: 0 }), roundRect: (x: number, y: number, w: number) => { rects.push([x + w / 2, y + w / 2]); } };
    const body = new LoaderBody(20, ctx, { scale: 2, hollow: true });
    body.snap("think", 2);
    body.draw("black");
    expect(rects.length).toBeGreaterThan(0);
    // 20px at 2x is 40px: every square keeps out of the middle half of the slot.
    for (const [x, y] of rects) expect(Math.max(Math.abs(x - 20), Math.abs(y - 20))).toBeGreaterThan(10);
  });

  test("a 16px and a 20px body in the same frame each keep their own shape", () => {
    const tinyCount = { fills: 0, clears: 0 };
    const fineCount = { fills: 0, clears: 0 };
    const tiny = new LoaderBody(16, fakeContext(tinyCount), { scale: 2 });
    const fine = new LoaderBody(20, fakeContext(fineCount), { scale: 2 });
    for (let i = 0; i < 40; i++) {
      const cache = new Map();
      tiny.step("think", 5 + i * 0.05, 0.05, cache);
      fine.step("think", 5 + i * 0.05, 0.05, cache);
    }
    tiny.draw("black");
    fine.draw("black");
    expect(tinyCount.fills).toBeLessThanOrEqual(5);
    expect(fineCount.fills).toBeGreaterThan(10);
  });
});
