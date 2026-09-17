/**
 * THE HEAVY VERDICT IS A MATTER OF TIME, NOT OF HOW OFTEN SOMEBODY LOOKED.
 *
 * The rows come from whoever polls the shell, at 5 s (status bar) or 1.5-2 s
 * (dropdown open), and the shell hands every reader inside its 2 s window the
 * same cached sample. So every case here that matters is written twice: at the
 * status-bar cadence and at the dropdown cadence with duplicates, and the
 * verdict has to land at the same instant.
 *
 * @covers BROWSER-HEAVY-02
 */
import { describe, expect, test } from 'bun:test';
import {
  CLEAR_SPAN_MS,
  attributeSample,
  initialVerdict,
  stepVerdict,
  type PaneSampleContext,
  type PaneVerdictState,
} from './heavyPanes';

const URL_KEY = 'http://localhost:4600/';
/** Shown and unpaused since t=0, no navigation, not loading. */
const LIVE: PaneSampleContext = { liveSince: 0, loading: false, navigatedAt: null, urlKey: URL_KEY };

function run(samples: Array<[number, number | null]>, ctx: PaneSampleContext = LIVE, from = initialVerdict(URL_KEY)) {
  let s: PaneVerdictState = from;
  const heavyAt: number[] = [];
  for (const [at, cpu] of samples) {
    const wasHeavy = s.heavy;
    s = stepVerdict(s, cpu, at, ctx);
    if (s.heavy && !wasHeavy) heavyAt.push(at);
  }
  return { state: s, heavyAt };
}

/** Samples every `step` ms from `start` to `end` inclusive, all at `cpu`. */
function series(start: number, end: number, step: number, cpu: number | null): Array<[number, number | null]> {
  const out: Array<[number, number | null]> = [];
  for (let t = start; t <= end; t += step) out.push([t, cpu]);
  return out;
}

describe('heavy verdict', () => {
  test('samples at or above 8% spanning 10 s make a pane heavy', () => {
    const { state, heavyAt } = run(series(8_000, 18_000, 5_000, 16.9));
    expect(heavyAt).toEqual([18_000]);
    expect(state.cpu).toBeCloseTo(16.9);
  });

  test('the same samples spanning 9 s do not', () => {
    expect(run([[8_000, 16.9], [12_500, 16.9], [17_000, 16.9]]).state.heavy).toBe(false);
  });

  test('the dropdown cadence with cached duplicates reaches the verdict at the same instant', () => {
    // 2 s readers: each real sample is served twice (the shell cache), so the
    // series has pairs of equal values one reader apart.
    const dup: Array<[number, number | null]> = [];
    for (let t = 8_000; t <= 18_000; t += 2_000) dup.push([t, 16.9], [t + 1, 16.9]);
    expect(run(dup).heavyAt).toEqual([18_000]);
  });

  test('a null or a 5% sample inside the streak starts it again', () => {
    expect(run([[8_000, 12], [13_000, null], [18_000, 12]]).state.heavy).toBe(false);
    expect(run([[8_000, 12], [13_000, 5], [18_000, 12], [23_000, 12]]).state.heavy).toBe(false);
  });

  test('a sample whose interval may include hidden or paused time does not count', () => {
    // liveSince 5 s before: under the 8 s cover.
    const ctx = { ...LIVE, liveSince: 20_000 };
    expect(run(series(25_000, 35_000, 5_000, 20), ctx).heavyAt).toEqual([]);
    expect(run(series(28_000, 38_000, 5_000, 20), ctx).heavyAt).toEqual([38_000]);
    expect(run(series(8_000, 30_000, 5_000, 20), { ...LIVE, liveSince: null }).heavyAt).toEqual([]);
  });

  test('a page that is loading, or navigated under 10 s ago, is not judged', () => {
    expect(run(series(8_000, 30_000, 5_000, 30), { ...LIVE, loading: true }).state.heavy).toBe(false);
    const nav = { ...LIVE, navigatedAt: 15_000 };
    expect(run(series(8_000, 24_000, 4_000, 30), nav).state.heavy).toBe(false);
    expect(run(series(25_000, 35_000, 5_000, 30), nav).heavyAt).toEqual([35_000]);
  });

  test('a paused pane keeps its verdict: nothing counts, nothing clears it', () => {
    const heavy = run(series(8_000, 18_000, 5_000, 20)).state;
    const paused = { ...LIVE, liveSince: null };
    expect(run(series(20_000, 200_000, 5_000, 0), paused, heavy).state.heavy).toBe(true);
  });

  test('a heavy pane clears after 55 s of live samples under 3%', () => {
    const heavy = run(series(8_000, 18_000, 5_000, 20)).state;
    expect(run(series(20_000, 20_000 + CLEAR_SPAN_MS - 5_000, 5_000, 1), LIVE, heavy).state.heavy).toBe(true);
    expect(run(series(20_000, 20_000 + CLEAR_SPAN_MS, 5_000, 1), LIVE, heavy).state.heavy).toBe(false);
    // A sample between the two thresholds starts the clearing again.
    const bumpy = [...series(20_000, 50_000, 5_000, 1), [55_000, 5] as [number, number], ...series(60_000, 110_000, 5_000, 1)];
    expect(run(bumpy, LIVE, heavy).state.heavy).toBe(true);
  });

  test('a new page is judged from scratch, a reload of the same path is not', () => {
    const heavy = run(series(8_000, 18_000, 5_000, 20)).state;
    expect(stepVerdict(heavy, 20, 19_000, { ...LIVE, urlKey: 'http://localhost:4600/other' }).heavy).toBe(false);
    expect(stepVerdict(heavy, 20, 19_000, LIVE).heavy).toBe(true);
  });

  test('the old shell double read (32 zeros, 7 spikes, never three in a row) never yields heavy', () => {
    // The series the critic replicated on 15/09 with two reads ~106 us apart.
    const spikes = new Set([3, 4, 11, 17, 18, 29, 36]);
    const noisy: Array<[number, number | null]> = [];
    for (let i = 0; i < 40; i++) noisy.push([8_000 + i * 5_000, spikes.has(i) ? 61 + i * 10 : 0]);
    expect(run(noisy).heavyAt).toEqual([]);
  });
});

describe('attribution', () => {
  test('generations of one pane with distinct pids are summed', () => {
    const m = attributeSample([
      { label: 'browserpane-a', pid: 10, cpu_percent: 6 },
      { label: 'browserpane-~1~a', pid: 11, cpu_percent: 5 },
    ]);
    expect(m.get('a')).toBe(11);
  });

  test('a pid under two panes, or under a pane and the main UI, gives neither a sample', () => {
    const shared = attributeSample([
      { label: 'browserpane-a', pid: 10, cpu_percent: 20 },
      { label: 'browserpane-b', pid: 10, cpu_percent: 20 },
    ]);
    expect(shared.get('a')).toBeNull();
    expect(shared.get('b')).toBeNull();
    const withMain = attributeSample([
      { label: 'main', pid: 7, cpu_percent: 4 },
      { label: 'browserpane-a', pid: 7, cpu_percent: 4 },
    ]);
    expect(withMain.get('a')).toBeNull();
  });
});
