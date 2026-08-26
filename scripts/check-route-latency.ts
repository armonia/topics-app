#!/usr/bin/env bun
/**
 * check-route-latency.ts: RATCHET on the latency of the hot routes.
 *
 * The same trade as `scripts/check-bundle-size.ts`, on a different quantity:
 * that one puts a floor under the bundle's bytes, this one under the
 * milliseconds of the four routes the app calls non-stop. Until now there was no
 * gate at all on latency: a query that turns N+1, a `readFileSync` inside a
 * loop, a table that grows without an index - nobody says a word about any of
 * them until a user does.
 *
 * THE FOUR ROUTES. They are the ones paid on every load and on every chat
 * opening, not the ones that look important:
 *
 *   topics             GET /api/topics, the complete topic tree. The first call
 *                      of every startup, and the one that grows with use.
 *   topic_messages     GET /api/topics/:id/messages?limit=200, the conversation
 *                      of one session. It reads, filters and slices ALL of that
 *                      session's messages to hand back 200: the route where a
 *                      regression is really felt, because the cost grows with
 *                      the length of the chat.
 *   all_boards_tasks   GET /api/all-boards/tasks, the task feed of every board.
 *                      The board calls it again on every event.
 *   dispatch_capacity  GET /api/system/dispatch-capacity: almost zero work
 *                      (reads cores, RAM and load). That is exactly what it is
 *                      for: it measures the PIPE, meaning what a request costs
 *                      before it reaches the handler. If this one gets worse,
 *                      something upstream got worse that the other three all pay
 *                      for.
 *
 * HOW IT MEASURES, and why this way.
 *
 * · ISOLATED server, not the production one on 3333. It starts it itself with
 *   `scripts/start-test-server.sh`, on a port derived from the checkout path and
 *   with a DB of its own, thrown away at the end. Measuring 3333 would mean
 *   measuring how many agents happen to be running at that moment.
 *
 * · FIXED corpus, seeded from scratch. The latency of `/api/topics` depends on
 *   how many topics there are: a baseline taken on an empty DB and compared with
 *   a full DB means nothing. The corpus is declared below, it is written into
 *   the baseline, and the gate REFUSES to compare when the two do not match.
 *
 * · MEDIAN, not mean. A slow round always happens (GC, another process waking
 *   up, the scheduler). On the mean that round moves the number, on the median
 *   it does not: HALF the calls have to be slow before it budges.
 *
 * · TWO passes, and the gate polices itself. The same calls are made twice, in
 *   two separate groups. If the two medians of the same route do not resemble
 *   each other, this machine at this moment is not a measuring environment: it
 *   exits 2 (NOT COMPARABLE) instead of 1 (regression). It is the same choice
 *   `check-bundle-size` makes when it finds two overlapping builds in `public/`:
 *   saying "this measurement means nothing" instead of accusing the last commit.
 *   A gate that shouts at random gets turned off.
 *
 * · Calls go round robin, not 30 in a row on the same route: that way a passing
 *   slowdown of the machine spreads over all four instead of pinning one alone.
 *
 * · Double threshold: percentage AND absolute floor. A half-millisecond route
 *   that goes to eight tenths grew by 60% and nothing happened. `floor_ms`
 *   absorbs the jitter that no percentage can tell apart from the signal. This
 *   gate is built to catch the jump (the query turning N+1, the file read inside
 *   a loop: 5x, 50x), not a half-millisecond drift. Anyone who wants that one
 *   too has to hand the bench an idle machine first, and this is not one.
 *
 * · Every response is LOOKED AT, not merely timed: 200 and the expected shape. A
 *   404 is blazing fast, and a bench that times 404s stays green forever while
 *   the route no longer exists.
 *
 * · The bench measures THE SERVER IT STARTED ITSELF, and proves it: `waitForPort`
 *   on its own is happy if ANYBODY answers, so a server left alive by a previous
 *   run would get timed in its place, against the baseline of different code. Two
 *   witnesses: EADDRINUSE in the child's log, and the process group of whoever
 *   is listening on the port.
 *
 * · `--selftest` proves the gate can go red, inside the SAME process just
 *   measured: it arms a fault hot, measures again, and demands the red.
 *
 * Usage:
 *   bun run check:route-latency
 *   bun run check:route-latency -- --update-baseline     record the new numbers
 *   bun run check:route-latency -- --samples=25          more samples, less noise
 *   bun run check:route-latency -- --selftest            prove it can go red
 *   TOPICS_ROTTE_FAULT_MS=40 bun run check:route-latency    fault armed from the env
 *
 * Exits:  0 = within budget · 1 = regression · 2 = not measurable
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { resolveBaselinePaths } from "./route-latency-baseline-pick";
import { connect } from "node:net";
import { cpus, loadavg } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// The PURE part: no network, no processes. This is what
// scripts/check-route-latency.test.ts exercises, including the case where it
// has to say red.
// ─────────────────────────────────────────────────────────────────────────────

export const ROUTE_KEYS = [
  "topics",
  "topic_messages",
  "all_boards_tasks",
  "dispatch_capacity",
] as const;
export type RouteKey = (typeof ROUTE_KEYS)[number];

/**
 * The route that acts as a RULER for the machine, not for the product.
 *
 * `dispatch_capacity` reads cores, RAM and load and nothing else: its number is
 * the cost of a request BEFORE it reaches the handler. When this one is out of
 * scale, every other figure of the same run carries that inside it, and there is
 * no way of telling a slow machine from an upstream regression. See the check at
 * the bottom of `main()`.
 */
export const CALIBRATION_KEY: RouteKey = "dispatch_capacity";

/**
 * Is the pipe out of scale? If it is, this run is not measuring the product.
 *
 * Pure and kept apart because this is the decision that has to be proven BOTH
 * ways: that it fires when the ruler has broken, and that it does NOT fire when
 * the ruler is fine, so a route getting worse on its own keeps coming out red.
 * Proving it from the real bench would take a machine that goes slow on command.
 *
 * Returns `null` when measuring is possible, otherwise the measured number and
 * its cap, which is what writing the message takes.
 */
export function calibrationOutOfScale(
  measured: Record<RouteKey, number>,
  baseline: Baseline,
): { measuredMs: number; capMs: number; baselineMs: number } | null {
  const baselineMs = baseline.routes[CALIBRATION_KEY].median_ms;
  const capMs = budgetMs(baselineMs, baseline.tolerance_pct, baseline.floor_ms);
  const measuredMs = measured[CALIBRATION_KEY];
  if (measuredMs > capMs) return { measuredMs, capMs, baselineMs };
  /**
   * ...and the ruler is also read as a RATIO, not only against its own cap.
   *
   * The cap is `baseline +60%` OR `+1.5 ms`, whichever is more generous. On a
   * small baseline the absolute floor wins, and in ratio it is enormous: a
   * baseline of 0.18 ms with a cap of 1.68 is 9.3 times itself, against the 3.0
   * of a route at 0.75. The most permissive ruler of the run is the judge.
   *
   * 2026-08-15, first run on CI (before that the job stopped at `check:deadcode`,
   * `bash -e`): the runner did `dispatch_capacity` at 0.87 ms = 4.8x without
   * tripping the calibration (0.87 < 1.68), while `all_boards_tasks` at 4.1x,
   * LESS than the machine had stretched, came out red. 2.5x and not 1.6x: below
   * that, a slightly slower machine still has to give a red.
   *
   * It does NOT fix the bottom of the problem: the baseline comes from an M2 Max
   * and the runner is a shared VM, so on CI it will exit 2 nearly every time.
   * That is honest, it is not protection: for protection you need a baseline
   * recorded ON the runner and chosen per machine, the way the memory probe does
   * with its `memory-<platform>-<date>.json`.
   */
  const RAPPORTO_MAX = 2.5;
  const rapporto = baselineMs > 0 ? measuredMs / baselineMs : 0;
  if (rapporto > RAPPORTO_MAX) {
    return { measuredMs, capMs: baselineMs * RAPPORTO_MAX, baselineMs };
  }
  return null;
}

export interface Corpus {
  topics: number;
  messages: number;
  tasks: number;
  /**
   * Characters of description per task. PART OF THE CONTRACT, like the counts:
   * the feed slices `description` in SQL (`PREVIEW_SQL_CHARS`), so a corpus whose
   * descriptions are shorter than the slice cannot see that slice change at all.
   * It was 156 until 2026-08-21, below both the old cut (240) and the new one
   * (800), and the constant moved between them without the bench noticing.
   */
  description_chars: number;
}

export interface Baseline {
  tolerance_pct: number;
  floor_ms: number;
  noise_guard_pct: number;
  samples: number;
  corpus: Corpus;
  routes: Record<RouteKey, {
    median_ms: number;
    /** The GAP between the two passes when the baseline was written: it is the
     *  real noise of that route on this machine, and its floor comes out of it
     *  (see `floorFor`). Absent on older baselines: those fall back on the
     *  general floor. */
    noise_ms?: number;
  }>;
}

/**
 * The median. On an even number of samples it takes the LOWER of the two middle
 * ones instead of averaging them: the samples here are milliseconds from a
 * distribution whose tail is entirely on the right (nothing is faster than the
 * minimum, everything can be slower), and the mean of the two middle ones gets
 * pulled up by that tail exactly as the mean of all of them would.
 */
export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error("mediana di zero campioni");
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
}

/**
 * The cap for one route: the percentage OR the floor, whichever grants more.
 * Without the floor a half-millisecond route would fail on scheduler jitter;
 * without the percentage a 200 ms route could double without anyone noticing.
 *
 * THE FLOOR IS PER-ROUTE AND THE NOISE DICTATES IT, not a constant. With 1.5 ms
 * the same for everyone - the first version - the arithmetic ran like this:
 * `/api/topics` sits at 0.36 ms, so the cap came out at 1.86 and the route could
 * get 5.17 times worse and stay green; `dispatch_capacity` at 0.18 ms reached
 * 9.33 times. An absolute floor over sub-millisecond routes is NOT a wide
 * threshold: it is a threshold that cannot fire.
 *
 * The real noise is something this bench already measures, and it is the gap
 * between the two passes: `noise_ms` in the baseline carries it route by route.
 * The floor is twice that gap, with a minimum of 0.05 ms because a perfectly
 * stable route must not end up with a cap of zero. On `/api/topics` (measured
 * gap 0.01 ms) the cap drops from 1.86 to 0.58: from 5.17x to 1.6x.
 */
export function budgetMs(baseMs: number, tolerancePct: number, floorMs: number): number {
  return Math.max(baseMs * (1 + tolerancePct / 100), baseMs + Math.max(0.05, floorMs));
}

/** The floor of ONE route: twice the noise its own measurement showed. */
export function floorFor(baseline: Baseline, key: RouteKey): number {
  const noise = baseline.routes[key]?.noise_ms;
  return Math.max(0.05, typeof noise === "number" && Number.isFinite(noise) ? noise * 2 : baseline.floor_ms);
}

/** Rounds to 2 decimals: below a hundredth of a ms there is no signal. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Do the two passes resemble each other? If not, the machine is moving underneath
 * the measurement, and neither of the two numbers is comparable with a baseline
 * taken yesterday. Same double threshold as the budget, for the same reason.
 */
export function unstableRoutes(
  passA: Record<RouteKey, number>,
  passB: Record<RouteKey, number>,
  guardPct: number,
  floorMs: number,
): string[] {
  const out: string[] = [];
  for (const key of ROUTE_KEYS) {
    const a = passA[key];
    const b = passB[key];
    if (a === undefined || b === undefined) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi > budgetMs(lo, guardPct, floorMs)) {
      out.push(`${key}: passata 1 ${round2(a)} ms, passata 2 ${round2(b)} ms`);
    }
  }
  return out;
}

/**
 * Is the measured corpus the baseline's one? If not, the comparison is between
 * two different things and has to be stopped before saying anything at all: it
 * is the easiest way to write into a baseline a number taken on an empty
 * database.
 */
export function corpusMismatch(measured: Corpus, base: Corpus): string | null {
  const diffs = (Object.keys(base) as Array<keyof Corpus>)
    .filter((k) => measured[k] !== base[k])
    .map((k) => `${k}: misurato ${measured[k]}, baseline ${base[k]}`);
  return diffs.length ? diffs.join("; ") : null;
}

/** The routes that got worse beyond budget. Empty = green. */
export function regressions(
  measured: Record<RouteKey, number>,
  baseline: Baseline,
): string[] {
  const out: string[] = [];
  for (const key of ROUTE_KEYS) {
    const got = measured[key];
    const base = baseline.routes[key]?.median_ms;
    // FAIL CLOSED. This used to read `if (base === undefined) continue`, so
    // renaming a key, setting it to null or QUOTING the number ("0.36") was
    // enough for that route to stop being judged and for the gate to exit 0. A
    // baseline that cannot be read is not "no regression": it is a disarmed
    // gate, and that has to be said out loud.
    if (typeof base !== "number" || !Number.isFinite(base)) {
      out.push(`${key}: la baseline non porta un numero leggibile (${JSON.stringify(base)}): il cancello non puo' giudicare questa rotta`);
      continue;
    }
    if (got === undefined) {
      out.push(`${key}: non misurata in questo giro, e la baseline la dichiara: o si misura o si toglie dalla baseline`);
      continue;
    }
    const cap = budgetMs(base, baseline.tolerance_pct, floorFor(baseline, key));
    if (got > cap) {
      out.push(
        `${key}: ${round2(got)} ms > ${round2(cap)} ms ` +
          `(baseline ${round2(base)} ms +${baseline.tolerance_pct}% o +${round2(floorFor(baseline, key))} ms di rumore)`,
      );
    }
  }
  return out;
}

/**
 * The bench's port, derived from the checkout path.
 *
 * Not a fixed number: two worktrees launching the bench together would kill each
 * other's server, and that is a fault the E2E suite has already paid for (the
 * reason at length lives in tests/e2e/helpers/worktree-port.ts). The 15200-15299
 * band sits clear of 13334 and of the shards' 13500-13899 window, of their
 * tunnels (+1000), and of production's 3333.
 */
export const ROUTE_BENCH_PORT_BASE = 15200;
export const ROUTE_BENCH_PORT_SPAN = 100;

export function benchPortFor(checkoutRoot: string): number {
  let h = 0x811c9dc5;
  const key = checkoutRoot.replace(/\/+$/, "");
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ROUTE_BENCH_PORT_BASE + ((h >>> 0) % ROUTE_BENCH_PORT_SPAN);
}

// ─────────────────────────────────────────────────────────────────────────────
// The real bench.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dir, "..");

// Which baseline is read and which is written: `route-latency-baseline-pick.ts`.
const { envKey: ENV_KEY, read: BASELINE_PATH, write: BASELINE_WRITE_PATH } =
  resolveBaselinePaths(REPO_ROOT, existsSync);

/**
 * How much material sits in the database while measuring. Changing it INVALIDATES
 * the baseline (the gate notices on its own and says so): it gets changed
 * together with the number, in the same commit.
 *
 * The numbers are big ON PURPOSE. The first calibration used 24 topics, 300
 * messages and 40 tasks: all four routes answered between 0.18 and 0.64 ms,
 * meaning inside the machine's noise. With a baseline down there, the absolute
 * floor (`floor_ms`) on its own grants nearly ten times the measured value, and
 * a route can get badly worse while staying green. A gate calibrated on a toy
 * database is not a gate: it is a measurement of what `fetch` costs. It takes
 * real-user quantities, where the HANDLER's cost outweighs the pipe's.
 */
const CORPUS: Corpus = { topics: 150, messages: 3000, tasks: 150, description_chars: 1200 };

/** Timed calls per route and per pass. */
const DEFAULT_SAMPLES = 25;
/** Rounds thrown away before timing: the first call pays for the cold cache. */
const WARMUP = 5;

/**
 * How much load per core is tolerated while RECORDING a baseline.
 *
 * 0.5 is not a matter of taste: it is half the cores busy, meaning the point past
 * which the median on this Mac started climbing by an order of magnitude
 * (measured: 0.75 -> 9.87 ms on `all_boards_tasks` with load 5.32 over 12 cores).
 * On the JUDGEMENT it does not apply: there a high load produces a red, and one
 * red too many gets looked at, whereas an inflated baseline never gets looked at
 * again.
 */
const MAX_LOAD_PER_CORE = 0.5;

/**
 * Is the machine too loaded to RECORD a baseline? Pure, so the case can be
 * exercised without actually loading a Mac down: it is the only way to see this
 * guard go red inside a test.
 */
export function machineTooLoaded(load1: number, cores: number): boolean {
  const perCore = load1 / Math.max(1, cores);
  return Number.isFinite(perCore) && perCore > MAX_LOAD_PER_CORE;
}

interface Probe {
  key: RouteKey;
  path: string;
  /** Rejects a response that is not the expected one: a 404 is blazing fast. */
  ok: (body: any) => boolean;
}

function log(msg: string): void {
  console.log(msg);
}

function die(msg: string, code: 1 | 2): never {
  console.error(msg);
  process.exit(code);
}

/**
 * Who is listening on this port, by process group. It proves the server being measured is the
 * one just started: `waitForPort` alone is happy if ANYBODY answers, so a server left alive by a
 * previous run — or any unrelated service that happened to grab the port — gets timed in its
 * place, against a baseline recorded for different code. The failure is silent and looks exactly
 * like a regression.
 *
 * Returns null when it could not be established (no `lsof`): the bench then says so out loud
 * instead of pretending it checked.
 */
function listenerPgids(port: number): number[] | null {
  const lsof = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (lsof.error || lsof.status !== 0 || !lsof.stdout.trim()) return null;
  const pids = lsof.stdout.trim().split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (pids.length === 0) return null;
  const out: number[] = [];
  for (const pid of pids) {
    const ps = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
    if (ps.error || ps.status !== 0) return null;
    const pgid = Number(ps.stdout.trim());
    if (!Number.isInteger(pgid)) return null;
    out.push(pgid);
  }
  return out;
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const open = await new Promise<boolean>((res) => {
      const socket = connect({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        res(true);
      });
      socket.on("error", () => res(false));
      socket.setTimeout(1000, () => {
        socket.destroy();
        res(false);
      });
    });
    if (open) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function api(base: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** Runs the work in groups: seeding 300 messages one at a time costs more than the bench. */
async function inBatches<T>(items: T[], size: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map((it, j) => fn(it, i + j)));
  }
}

async function seed(base: string): Promise<{ topicId: string }> {
  // BEFORE creating any task: the auto-dispatch switch is GLOBAL (the '*' row of
  // board_settings, reachable from any board). Without this the bench would
  // create 40 tasks that the server tries to dispatch as real agents: the "load"
  // being measured would be its own.
  await api(base, "/api/boards/bench-route-latency/settings", {
    method: "PATCH",
    body: JSON.stringify({ autoDispatch: false, maxAgents: 1 }),
  });

  const topicIds: string[] = [];
  await inBatches(
    Array.from({ length: CORPUS.topics }, (_, i) => i),
    8,
    async (i) => {
      const t = await api(base, "/api/topics", {
        method: "POST",
        body: JSON.stringify({ name: `Route bench ${String(i).padStart(3, "0")}` }),
      });
      topicIds.push(t.id);
    },
  );

  // The topic being measured is the FIRST one created, not a random one: the
  // median of `topic_messages` depends on how many messages the session has, and
  // it has to be the same number from one run to the next.
  const first = await api(base, "/api/topics");
  const sorted = Object.values(first.topics as Record<string, any>).sort((a: any, b: any) =>
    String(a.name).localeCompare(String(b.name)),
  );
  const target = sorted[0] as any;

  await inBatches(
    Array.from({ length: CORPUS.messages }, (_, i) => i),
    16,
    async (i) =>
      void (await api(base, "/api/test/seed-message", {
        method: "POST",
        body: JSON.stringify({
          sessionKey: target.sessionKey,
          role: i % 2 === 0 ? "user" : "assistant",
          // Realistic content: the route serialises whatever it finds, and
          // measuring it over three-letter strings would measure something else.
          content: `Messaggio ${i} del banco. `.repeat(12),
          sortOrder: i,
        }),
      })),
  );

  await inBatches(
    Array.from({ length: CORPUS.tasks }, (_, i) => i),
    8,
    async (i) =>
      void (await api(base, "/api/boards/bench-route-latency/tasks", {
        method: "POST",
        body: JSON.stringify({
          text: `Task del banco numero ${i}`,
          // Long enough to exceed the SQL slice (`PREVIEW_SQL_CHARS`, 800), so a
          // change to that cut moves this number instead of hiding in it. Until
          // 2026-08-21 these were ~156 chars and the bench was blind to it.
          description: `Descrizione del task ${i}. `.repeat(
            Math.ceil(CORPUS.description_chars / 27),
          ),
        }),
      })),
  );

  return { topicId: target.id };
}

/** Counts what is actually there, so a measurement on an empty DB is never certified. */
async function measuredCorpus(base: string, topicId: string): Promise<Corpus> {
  const topics = await api(base, "/api/topics");
  const msgs = await api(base, `/api/topics/${topicId}/messages?limit=200`);
  const tasks = await api(base, "/api/all-boards/tasks");
  return {
    topics: Object.keys(topics.topics ?? {}).length,
    messages: Number(msgs.total ?? 0),
    tasks: (tasks.tasks ?? []).length,
    // Declared, not measured: the feed returns `description_preview`, already
    // sliced, so the real length is not visible from here. This is what the
    // seeder wrote, and the seeder is the only thing that knows it.
    description_chars: CORPUS.description_chars,
  };
}

/**
 * One pass: `samples` calls per route, round robin across the routes, with the
 * first `WARMUP` rounds thrown away. Returns the median per route.
 */
async function runPass(base: string, probes: Probe[], samples: number): Promise<Record<RouteKey, number>> {
  const acc = new Map<RouteKey, number[]>(probes.map((p) => [p.key, []]));

  for (let round = 0; round < samples + WARMUP; round++) {
    for (const probe of probes) {
      const t0 = performance.now();
      const res = await fetch(`${base}${probe.path}`);
      const text = await res.text(); // the body must be DRAINED, or half a response gets timed
      const dt = performance.now() - t0;

      if (res.status !== 200) die(`✗ ${probe.path} ha risposto ${res.status}: la rotta non e' misurabile.`, 2);
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        die(`✗ ${probe.path} non ha risposto JSON: la rotta non e' misurabile.`, 2);
      }
      if (!probe.ok(body)) {
        die(
          `✗ ${probe.path} ha risposto 200 ma con la forma sbagliata.\n` +
            `  Una risposta vuota o d'errore e' VELOCE: cronometrarla darebbe verde a vuoto.`,
          2,
        );
      }

      if (round >= WARMUP) acc.get(probe.key)!.push(dt);
    }
  }

  const out = {} as Record<RouteKey, number>;
  for (const [key, xs] of acc) out[key] = median(xs);
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const update = args.includes("--update-baseline");
  // `--selftest`: proves this gate CAN go red. See the bottom of main().
  const selftest = args.includes("--selftest");
  if (update && selftest) die("✗ --update-baseline e --selftest non stanno insieme: uno scrive la baseline, l'altro la usa per giudicare.", 2);
  const samples = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1]) || DEFAULT_SAMPLES;
  const portArg = Number(args.find((a) => a.startsWith("--port="))?.split("=")[1]);
  // THE `TOPICS_ROTTE_*` KEEP THEIR OLD NAME, and that is a choice.
  // `TOPICS_ROTTE_FAULT_MS` and `TOPICS_ROTTE_FAULT_PATH` are not read by this
  // file: they are read by `server/lib/route-fault.ts`, meaning the server under
  // measurement. They are a contract between two processes, and renaming them
  // halfway means a synthetic fault that arms here and does not arm there. All
  // three go together, in the same edit that touches `server/lib/route-fault.ts`.
  const port = portArg || Number(process.env.TOPICS_ROTTE_PORT) || benchPortFor(REPO_ROOT);

  // No bench will ever touch the real server: 3333 is its port, and its latency
  // depends on how many agents happen to be running at that moment.
  if (port === 3333) die("✗ La 3333 e' il server di produzione. Il banco misura solo un server suo.", 2);

  const faultMs = Number(process.env.TOPICS_ROTTE_FAULT_MS);
  const faulted = Number.isFinite(faultMs) && faultMs > 0;
  if (faulted) {
    const target = process.env.TOPICS_ROTTE_FAULT_PATH || "/api/topics";
    log(
      `⚠ GUASTO SINTETICO ARMATO: +${faultMs} ms su ${target} (TOPICS_ROTTE_FAULT_MS).\n` +
        `  Questa run serve a PROVARE che il cancello sa diventare rosso, non a misurare niente.`,
    );
    // A baseline is never recorded from a rigged measurement: it would be the
    // quickest way of blinding the gate forever.
    if (update) die("✗ --update-baseline e' rifiutato mentre il guasto e' armato.", 2);
  }

  if (!existsSync(BASELINE_PATH) && !update) {
    die(`✗ Manca ${BASELINE_PATH}. Registralo con: bun run check:route-latency -- --update-baseline`, 2);
  }

  const dataDir = `/tmp/topics-route-latency-bench-${port}`;
  rmSync(dataDir, { recursive: true, force: true }); // fresh DB: the corpus has to be ours alone

  log(`Banco rotte · porta ${port} · DATA_DIR ${dataDir} · ${samples} campioni x 2 passate`);

  const child = spawn("bash", [resolve(REPO_ROOT, "scripts/start-test-server.sh")], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      BUN_PORT: String(port),
      DATA_DIR: dataDir,
      TOPICS_HOME: `${dataDir}/.topics-home`,
      OPENCLAW_DIR: `${dataDir}/.openclaw`,
      // Dedicated sockets: without them the bench server would derive them from
      // the cwd, which it shares with the development one, and its reconcile
      // would see development's live PTYs as orphans and kill them.
      TOPICS_PTY_SOCKET: `/tmp/topics-pty-bridge-route-latency-${port}.sock`,
      TOPICS_AI_BRIDGE_SOCKET: `/tmp/topics-ai-bridge-route-latency-${port}.sock`,
      NO_TLS: "1",
      TOPICS_E2E: "1",
    },
  });
  let serverLog = "";
  child.stdout?.on("data", (d: Buffer) => { serverLog += d.toString(); });
  child.stderr?.on("data", (d: Buffer) => { serverLog += d.toString(); });

  // One single cleanup, hooked onto `exit` as well: `die()` leaves through
  // `process.exit`, which does NOT run the `finally` blocks. Without this hook a
  // bench that stops halfway would leave a live server on that port, and the next
  // run would find the port taken by itself.
  let cleaned = false;
  const stop = () => {
    if (cleaned) return;
    cleaned = true;
    try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* already dead */ }
    rmSync(dataDir, { recursive: true, force: true });
  };
  process.on("exit", stop);
  process.on("SIGINT", () => { stop(); process.exit(130); });

  let exitCode = 0;
  try {
    if (!(await waitForPort(port, 40_000))) {
      die(`✗ Il server del banco non si e' aperto sulla ${port} in 40s.\n${serverLog.slice(-1500)}`, 2);
    }

    // Is the thing answering actually OUR child? Two witnesses, neither costs anything.
    if (/EADDRINUSE/i.test(serverLog)) {
      die(`✗ Il server del banco ha detto EADDRINUSE sulla ${port}: sta rispondendo un altro processo.`, 2);
    }
    const pgids = listenerPgids(port);
    if (pgids === null) {
      log(`⚠ Non ho potuto leggere chi ascolta sulla ${port} (lsof assente): resta un testimone in meno.`);
    } else {
      const mine = child.pid ?? -1;
      const foreign = pgids.filter((g) => g !== mine);
      if (foreign.length > 0) {
        die(
          `✗ Sulla ${port} ascolta un processo che non e' del banco (gruppo ${foreign.join(", ")}, il mio e' ${mine}).\n` +
            `  Misurarlo vorrebbe dire confrontare la baseline di questo codice con un altro server.`,
          2,
        );
      }
    }

    const base = `http://127.0.0.1:${port}`;
    const { topicId } = await seed(base);

    const corpus = await measuredCorpus(base, topicId);
    log(`corpus         ${corpus.topics} topic · ${corpus.messages} messaggi · ${corpus.tasks} task`);
    const seedGap = corpusMismatch(corpus, CORPUS);
    if (seedGap) die(`✗ La semina non e' andata a buon fine (${seedGap}). Misura non valida.`, 2);

    const probes: Probe[] = [
      { key: "topics", path: "/api/topics", ok: (b) => Object.keys(b?.topics ?? {}).length === CORPUS.topics },
      {
        key: "topic_messages",
        path: `/api/topics/${topicId}/messages?limit=200`,
        ok: (b) => Array.isArray(b?.messages) && b.messages.length === 200 && b.total === CORPUS.messages,
      },
      { key: "all_boards_tasks", path: "/api/all-boards/tasks", ok: (b) => (b?.tasks ?? []).length === CORPUS.tasks },
      { key: "dispatch_capacity", path: "/api/system/dispatch-capacity", ok: (b) => typeof b?.recommended === "number" },
    ];

    const passA = await runPass(base, probes, samples);
    const passB = await runPass(base, probes, samples);
    // Between the two passes the WORST one is kept: if a route is slow in even
    // one of them, it is slow. That way the bench gains nothing from repeating
    // itself until the answer suits it.
    const measured = {} as Record<RouteKey, number>;
    for (const key of ROUTE_KEYS) measured[key] = Math.max(passA[key]!, passB[key]!);

    if (update) {
      const prev = existsSync(BASELINE_WRITE_PATH) ? JSON.parse(readFileSync(BASELINE_WRITE_PATH, "utf8")) : {};
      // RECORDING goes through the stability check too. A baseline taken on a
      // machine that was shaking is an inflated number that no regression will
      // ever manage to exceed afterwards: the gate would stay green forever
      // without anyone noticing.
      const shaky = unstableRoutes(passA, passB, prev.noise_guard_pct ?? 60, prev.floor_ms ?? 1.5);
      if (shaky.length > 0) {
        die(
          `✗ Non registro una baseline da una misura instabile:\n  - ${shaky.join("\n  - ")}\n\n` +
            `  Un numero gonfiato qui rende il cancello cieco. Rilancia a macchina ferma.`,
          2,
        );
      }
      // A BASELINE IS NOT RECORDED FROM A LOADED MACHINE, and this is a fault
      // that was reproduced rather than feared: with `load average` at 5.32 on
      // this Mac the bench wrote `all_boards_tasks` at 9.87 ms where on an idle
      // machine it sits at 0.75 - thirteen times over. The two passes agreed, so
      // `unstableRoutes` stayed quiet: the A-against-B comparison sees the
      // jitter, not the UNIFORM load. A number like that does not widen the
      // threshold a little, it disarms it for good.
      const cores = Math.max(1, cpus().length);
      const load1 = loadavg()[0] ?? 0;
      if (machineTooLoaded(load1, cores)) {
        log(`\n✗ Non registro una baseline con la macchina sotto carico:`);
        log(`  load average ${round2(load1)} su ${cores} core = ${round2(load1 / cores)} per core (tetto ${MAX_LOAD_PER_CORE}).`);
        log(`\n  A macchina carica i numeri escono gonfiati e concordi, quindi nessuna`);
        log(`  guardia se ne accorge. Aspetta che si calmi e rilancia.`);
        process.exitCode = 2;
        return;
      }
      const next = {
        ...prev,
        /** Under what load this number was taken: without it, "0.75 ms" gives no
         *  way of knowing whether it is the route or the machine. */
        taken_under: { load1: round2(load1), cores },
        $schema: "route-latency-baseline-v1",
        updated: new Date().toISOString().slice(0, 10),
        samples,
        tolerance_pct: prev.tolerance_pct ?? 60,
        floor_ms: prev.floor_ms ?? 1.5,
        noise_guard_pct: prev.noise_guard_pct ?? 60,
        corpus: CORPUS,
        // Alongside the median, that route's NOISE is recorded, meaning the gap
        // between this run's two passes. It is the number its floor comes out
        // of: a stable route gets a tight cap, a jumpy one widens its own, and
        // neither of them depends on a constant picked by hand.
        routes: Object.fromEntries(ROUTE_KEYS.map((k) => [k, {
          median_ms: round2(measured[k]!),
          noise_ms: round2(Math.abs((passA[k] ?? 0) - (passB[k] ?? 0))),
        }])),
      };
      writeFileSync(BASELINE_WRITE_PATH, `${JSON.stringify(next, null, 2)}\n`);
      for (const key of ROUTE_KEYS) log(`${key.padEnd(18)} ${round2(measured[key]!)} ms`);
      log(`\n✓ Baseline registrata in ${BASELINE_WRITE_PATH} (ambiente: ${ENV_KEY}).`);
      return;
    }

    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    // Which baseline is being compared against: see `resolveBaselinePaths`.
    log(`baseline: ${basename(BASELINE_PATH)} (ambiente: ${ENV_KEY})`);

    const gap = corpusMismatch(CORPUS, baseline.corpus);
    if (gap) {
      die(
        `✗ Il corpus e' cambiato (${gap}): i numeri della baseline sono stati presi su un'altra\n` +
          `  quantita' di dati e non sono confrontabili. Rimisura con --update-baseline nello\n` +
          `  STESSO commit in cui hai cambiato il corpus.`,
        2,
      );
    }

    for (const key of ROUTE_KEYS) {
      const cap = budgetMs(baseline.routes[key]!.median_ms, baseline.tolerance_pct, baseline.floor_ms);
      log(
        `${key.padEnd(18)} ${String(round2(measured[key]!)).padStart(7)} ms   ` +
          `(passate ${round2(passA[key]!)} / ${round2(passB[key]!)} · baseline ${round2(baseline.routes[key]!.median_ms)} · tetto ${round2(cap)})`,
      );
    }

    const unstable = unstableRoutes(passA, passB, baseline.noise_guard_pct, baseline.floor_ms);
    if (unstable.length > 0) {
      console.error(
        `\n⚠ NON CONFRONTABILE: le due passate non si somigliano.\n  - ${unstable.join("\n  - ")}\n\n` +
          `Questa macchina si sta muovendo sotto la misura (agenti che girano, una build,\n` +
          `un'altra suite). Non e' una regressione e non viene chiamata tale: rilancia a\n` +
          `macchina ferma, o alza --samples.`,
      );
      exitCode = 2;
      return;
    }

    // ── THE PIPE IS THE RULER ────────────────────────────────────────────────
    //
    // `dispatch_capacity` is not a route like the others: it does almost nothing
    // (reads cores, RAM and load), so its number is the cost of a REQUEST before
    // it reaches the handler. The comment at the top of this file already says
    // it: "if this one gets worse, something upstream got worse that the other
    // three all pay for". Up to now, though, that number was merely printed.
    //
    // It is needed because the two-pass check does not see a UNIFORMLY slow
    // machine: if the load is there for the whole run, the two passes resemble
    // each other perfectly and agree on a number that is talking about the
    // laptop. Measured on 2026-08-14 on this machine, with Spotify, a video
    // decoder and two browsers on top of it: `all_boards_tasks` at 8 ms against a
    // baseline of 0.75, and the very same number on a tree PRIOR to every change
    // of that day (8.68 ms). It was not a regression, and the gate was calling it
    // one.
    //
    // When the pipe breaks through its own cap, no number from that run separates
    // "slow machine" from "upstream regression": they are the same curve. The
    // only honest answer is 2, meaning NOT MEASURABLE, which is the same choice
    // `check:scroll-fluidity` makes with its at-rest calibration. A single route
    // getting worse while the pipe is fine keeps exiting 1, and the synthetic
    // fault proves it (`TOPICS_ROTTE_FAULT_MS=40`).
    const pipe = calibrationOutOfScale(measured, baseline);
    if (pipe) {
      console.error(
        `\n⚠ NON MISURABILE: il tubo e' fuori scala.\n` +
          `  - ${CALIBRATION_KEY}: ${round2(pipe.measuredMs)} ms > ${round2(pipe.capMs)} ms ` +
          `(baseline ${round2(pipe.baselineMs)} ms)\n\n` +
          `Quella rotta non fa quasi niente: il suo numero e' il costo di una richiesta PRIMA\n` +
          `del gestore. Se e' fuori scala, ogni altra cifra di questa corsa la porta dentro, e\n` +
          `«macchina lenta» e «regressione a monte» diventano la stessa curva. Non si sceglie a\n` +
          `caso fra le due: si rimisura a macchina ferma. Se il tubo resta fuori scala anche li',\n` +
          `QUELLA e' la scoperta, e riguarda tutte e quattro le rotte insieme.`,
      );
      exitCode = 2;
      return;
    }

    const bad = regressions(measured, baseline);
    if (bad.length > 0) {
      console.error(
        `\n✗ Latenza fuori budget:\n  - ${bad.join("\n  - ")}\n\n` +
          `Le due passate sono d'accordo, quindi il numero e' vero. O si rimette a posto la\n` +
          `rotta, o, se il costo e' voluto, si alza la cifra in ${BASELINE_PATH}\n` +
          `nello STESSO commit, cosi' il diff dice cosa e' stato comprato.`,
      );
      exitCode = 1;
      return;
    }

    // ── THE SELF-TEST ────────────────────────────────────────────────────────
    //
    // A gate nobody has ever seen fail is not a gate. Here the proof is made inside the SAME
    // process just measured: a 40 ms fault is armed on the topic routes, the measurement is
    // taken again, and a red is demanded. If it stays green, the gate is blind - and it says so
    // instead of letting you believe otherwise.
    //
    // Arming through the environment would not do: it would force a restart, and then the
    // healthy measurement and the faulty one would come from two different processes, which
    // have different numbers anyway.
    if (selftest) {
      const arm = async (body: unknown) =>
        fetch(`${base}/api/test/route-fault`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const armed = await arm({ delayMs: 40, pathPrefix: "/api/topics" });
      if (!armed.ok) {
        die(`✗ Non ho potuto armare il guasto (${armed.status}): senza, l'autoprova non prova niente.`, 2);
      }
      log("\n▸ autoprova: guasto di 40 ms armato su /api/topics — mi aspetto un ROSSO.");
      const faultPassA = await runPass(base, probes, samples);
      const faultPassB = await runPass(base, probes, samples);
      const faultMeasured = {} as Record<RouteKey, number>;
      for (const key of ROUTE_KEYS) faultMeasured[key] = Math.max(faultPassA[key]!, faultPassB[key]!);
      await arm(null).catch(() => {});

      const red = regressions(faultMeasured, baseline);
      for (const key of ROUTE_KEYS) {
        log(`  ${key.padEnd(18)} ${String(round2(faultMeasured[key]!)).padStart(7)} ms (era ${round2(measured[key]!)})`);
      }
      if (red.length === 0) {
        console.error(
          `\n✗ AUTOPROVA FALLITA: con 40 ms di guasto su /api/topics il cancello e' rimasto VERDE.\n` +
            `  Vuol dire che i tetti sono cosi' larghi da non poter piu' vedere niente: una\n` +
            `  regressione vera passerebbe allo stesso modo. Il numero da guardare e'\n` +
            `  tolerance_pct in ${BASELINE_PATH}.`,
        );
        exitCode = 1;
        return;
      }
      log(`\n✓ Autoprova: il cancello e' diventato rosso su ${red.length} rotta/e. Sa mordere.`);
    }

    const won = ROUTE_KEYS.filter((k) => measured[k]! < baseline.routes[k]!.median_ms * 0.7);
    if (won.length > 0) {
      log(`\n✓ ${won.join(", ")}: oltre il 30% sotto la baseline. Abbassa il numero per bloccare il guadagno.`);
    }
    log("\n✓ Rotte dentro il budget.");
  } finally {
    stop();
    if (exitCode !== 0) process.exit(exitCode);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`✗ Il banco si e' rotto: ${err?.message ?? err}`);
    process.exit(2);
  });
}
