/**
 * Durability of the project-channel sync (`topics-project-panes-*`).
 *
 * Regression contract for the "revive → repoint lost → PTY orphaned, tab lost"
 * bug: a project's tab-identity PUT (which repoints a terminal pane to a live
 * session id after a revive/reopen) MUST reach the server even if the window
 * dies or the server restarts inside the 500 ms debounce. The old code fired a
 * single un-retried, un-flushed PUT, so a write racing the 16:23 server restart
 * was lost and the channel kept pointing at the dead terminal id.
 *
 * These lock:
 *   - a PUT that fails (server down) is RETAINED as un-acked, not swallowed;
 *   - a teardown flush (pagehide) beacons every not-yet-durable value out;
 *   - a WS reconnect retries the un-acked set;
 *   - a successful PUT clears the un-acked entry (no perpetual re-send).
 *
 * @covers TAB-SYNC-01, LAYOUT-02
 */
import { TIME_SLACK_ENV, parseForcedSlack } from "../../../../../shared/test-time-slack";
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";

type StorageArea = Record<string, string>;
function installFakeWindow(): void {
  const store: StorageArea = Object.create(null);
  const storageApi = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: storageApi,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = storageApi;
  (globalThis as unknown as { document: unknown }).document = { visibilityState: "visible" };
}

// The fake window/localStorage/document is partial: left behind at the end of
// the file it flips the `typeof window === 'undefined'` guards of later files in
// the same sharded process (e.g. useMobile -> getComputedStyle). Restore bun's
// baseline (no DOM globals).
function uninstallFakeWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  delete (globalThis as unknown as { document?: unknown }).document;
}

installFakeWindow();
afterAll(uninstallFakeWindow);

const mod = await import("./projectLayoutSync");
const {
  saveProjectLayout,
  projectPanesLocalKey,
  __getUnackedProjectSyncKeys,
  __flushAllProjectSyncForTests,
  __resetProjectSyncForTests,
} = mod as typeof import("./projectLayoutSync") & {
  __getUnackedProjectSyncKeys: () => string[];
  __flushAllProjectSyncForTests: () => void;
  __resetProjectSyncForTests: () => void;
};

const PROJECT = "/work/demoapp";
const KEY = projectPanesLocalKey(PROJECT);

interface FetchCall { url: string; body: string; keepalive: boolean }
interface BeaconCall { url: string; body: string }
let fetchCalls: FetchCall[];
let beaconCalls: BeaconCall[];
let fetchOk: boolean;

// The REAL globals, captured ONCE at module load. Capturing inside
// installFetch poisoned the whole bun-test process: a test that installed
// twice (down → up) re-captured the FIRST STUB as "original", afterEach then
// restored the stub, and every later test file in the suite saw a fake fetch
// answering { server_seq: N } (broke browser-native-delegate.socket.test.ts).
const REAL_FETCH: unknown = (globalThis as unknown as { fetch?: unknown }).fetch;
const REAL_NAVIGATOR: unknown = (globalThis as unknown as { navigator?: unknown }).navigator;

function installFetch(ok: boolean): void {
  fetchOk = ok;
  fetchCalls = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    url: string,
    init?: { body?: string; keepalive?: boolean },
  ): Promise<Response> => {
    fetchCalls.push({ url: String(url), body: init?.body ?? "", keepalive: !!init?.keepalive });
    if (!fetchOk) throw new Error("network down");
    return {
      ok: true,
      json: async () => ({ server_seq: fetchCalls.length }),
    } as unknown as Response;
  };
}

function installBeacon(): void {
  beaconCalls = [];
  (globalThis as unknown as { navigator: unknown }).navigator = {
    sendBeacon: (url: string, blob: { text?: () => Promise<string> } & Blob) => {
      // bun's Blob has .text(); we only need the url + a best-effort body marker.
      beaconCalls.push({ url: String(url), body: "beacon" });
      void blob;
      return true;
    },
  };
}

const layout = (paneId: string) => ({
  nonChatPanes: [{ id: paneId, type: "terminal" }],
  openChatTopicIds: [],
});

// The sync is debounced 500 ms; wait past it. The margin is wider than the
// naive "debounce plus a bit" because under a busy fleet (many agents'
// test:unit shards sharing the machine) the event loop can lag the clock
// by seconds, not milliseconds, and a too-tight wait flakes.
const settle = () => new Promise((r) => setTimeout(r, 2500));

/**
 * WAITING FOR THE CONDITION BEATS WAITING FOR THE CLOCK.
 *
 * These tests used to sleep a fixed 2.5 s (and 9 s for the retry chain) and
 * then assert. On a busy fleet the timers themselves lag, so the sleep was
 * both too long on a quiet machine and too short on a loaded one: the three
 * tests that wait for the retry chain went red under load with nothing wrong
 * (card 289391a3, two rounds in a row). Polling the state the test is
 * actually about ends the moment it is true, and only spends the budget when
 * it never becomes true, which is the red we do want.
 */
async function waitFor(
  ready: () => boolean,
  what: string,
  budgetMs: number = BUDGET_MS,
): Promise<void> {
  const deadline = Date.now() + budgetMs * 0.8;
  while (!ready() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  // A WAIT THAT GIVES UP QUIETLY LIES TWICE.
  //
  // This used to return whether or not the condition held, and the test went
  // on regardless. Under load that meant a retry chain still in flight when
  // the test asserted: the failure surfaced later, as a count that was 2
  // instead of 1, or in the NEXT test, where the straggler landed in its
  // fetchCalls. Both reds named the wrong thing. Say it here, where the
  // waiting actually ran out.
  if (!ready()) throw new Error(`waited ${budgetMs * 0.8} ms for ${what} and it never came`);
}

/**
 * The retry chain is FOUR fetch calls: the first PUT plus `MAX_RETRIES` (3 in
 * projectLayoutSync.ts). The un-acked key is NOT the signal that the chain gave
 * up: `flushSync` puts the key in the set BEFORE the first PUT, so waiting for
 * the key returns after one attempt out of four, and a test asserting there is
 * blind to a value dropped once the retries run out. The end of the chain is
 * the fourth call; the extra tick lets the last attempt's rejection settle, so
 * the give-up branch has run before anyone looks.
 *
 * Every failing-server test waits here, all of them: a test that leaves early
 * leaves its chain alive, and the stragglers land in the NEXT test's
 * `fetchCalls`, where they make `>= 4` true too soon.
 */
const PUT_ATTEMPTS = 4; // MAX_RETRIES + 1 in projectLayoutSync.ts

async function waitForRetryChainExhausted(): Promise<void> {
  await waitFor(() => fetchCalls.length >= PUT_ATTEMPTS, `the ${PUT_ATTEMPTS} PUTs of the retry chain`);
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * THE SLEEP WAS WIDENED AND THE TEST'S OWN CAP WAS NOT.
 *
 * Two `settle()` calls are 5 s of deliberate waiting, and bun's default
 * per-test timeout is 5 s: the two tests that wait twice were failing at
 * 5002 ms with nothing wrong. The comment above already knew the machine can
 * lag by seconds under a fleet — it just never gave the test room to.
 *
 * The base is written for a quiet machine and multiplied by the factor the
 * runner hands down (`TOPICS_TEST_TIME_SLACK`, measured once per round: see
 * `shared/test-time-slack.ts`). Widening a cap costs nothing when the test
 * passes — it is only ever paid on the way to a red.
 *
 * Raised from 15 s on 2026-09-14: the waits here poll, so on a quiet machine
 * they end in about a second and the number below is never reached. It is
 * reached on a machine running a dozen shards at once, and there the old cap
 * ran out mid retry chain (card 1e078aee, two tests red on a diff that
 * touched no client file at all).
 */
const BUDGET_MS = Math.round(45_000 * (parseForcedSlack(process.env[TIME_SLACK_ENV]) ?? 1));

beforeEach(() => {
  __resetProjectSyncForTests();
  installBeacon();
});

afterEach(() => {
  __resetProjectSyncForTests();
  if (REAL_FETCH === undefined) delete (globalThis as unknown as { fetch?: unknown }).fetch;
  else (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH;
  if (REAL_NAVIGATOR === undefined) delete (globalThis as unknown as { navigator?: unknown }).navigator;
  else (globalThis as unknown as { navigator: unknown }).navigator = REAL_NAVIGATOR;
});

describe("project channel PUT durability", () => {
  test("a successful debounced PUT lands and leaves nothing un-acked", async () => {
    installFetch(true);
    saveProjectLayout(KEY, PROJECT, layout("terminal:fe2a97aa"));
    await waitFor(() => fetchCalls.length >= 1, "the first PUT");
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    expect(fetchCalls.some((c) => c.url.includes(encodeURIComponent(KEY)))).toBe(true);
    expect(__getUnackedProjectSyncKeys()).not.toContain(KEY);
  }, BUDGET_MS);

  test("a failing PUT (server down) is RETAINED as un-acked, not swallowed", async () => {
    installFetch(false);
    saveProjectLayout(KEY, PROJECT, layout("terminal:fe2a97aa"));
    await waitForRetryChainExhausted();
    // Retries exhausted → value kept for a later teardown/reconnect flush.
    expect(__getUnackedProjectSyncKeys()).toContain(KEY);
  }, BUDGET_MS);

  test("teardown flush beacons the un-acked repoint out synchronously", async () => {
    installFetch(false);
    saveProjectLayout(KEY, PROJECT, layout("terminal:fe2a97aa"));
    await waitForRetryChainExhausted();
    expect(__getUnackedProjectSyncKeys()).toContain(KEY);
    // pagehide-equivalent: everything not durable must beacon out NOW.
    __flushAllProjectSyncForTests();
    expect(beaconCalls.length).toBeGreaterThanOrEqual(1);
    expect(beaconCalls.some((c) => c.url.includes(encodeURIComponent(KEY)))).toBe(true);
    // The beacon carries the client id fallback so the server can dedupe echoes.
    expect(beaconCalls.some((c) => c.url.includes("cid="))).toBe(true);
  }, BUDGET_MS);

  test("teardown flush drains a value still sitting in the debounce buffer (never hit its timer)", () => {
    installFetch(true);
    // Queue but DON'T settle — the 500 ms timer hasn't fired yet.
    saveProjectLayout(KEY, PROJECT, layout("terminal:fe2a97aa"));
    // Window dies right now.
    __flushAllProjectSyncForTests();
    expect(beaconCalls.some((c) => c.url.includes(encodeURIComponent(KEY)))).toBe(true);
  });

  test("a later successful PUT clears the un-acked entry (no perpetual re-send)", async () => {
    installFetch(false);
    saveProjectLayout(KEY, PROJECT, layout("terminal:fe2a97aa"));
    await waitForRetryChainExhausted();
    expect(__getUnackedProjectSyncKeys()).toContain(KEY);
    // Server comes back; a new save with a DIFFERENT value succeeds.
    installFetch(true);
    saveProjectLayout(KEY, PROJECT, layout("terminal:a6d64304"));
    await waitFor(() => !__getUnackedProjectSyncKeys().includes(KEY), "the ack that clears the un-acked key");
    expect(__getUnackedProjectSyncKeys()).not.toContain(KEY);
    // The NEW value is what cleared it: a late attempt carrying the old one
    // would clear the key just the same and prove nothing about this save.
    expect(fetchCalls.some((c) => c.body.includes("a6d64304"))).toBe(true);
  }, BUDGET_MS);

  /**
   * Regression for the flaky-terminal-panes card: the teardown beacon used to
   * be an UNCONDITIONAL overwrite (no compare-and-swap), so a dying tab's
   * pagehide write could land after a fresher truth was already on the row
   * (a test harness's reset, a peer device) and resurrect stale panes. It now
   * carries `?base=` — same guard `syncServer.ts` already has for
   * pane-store-v2 — so the server can 409 a late write instead of applying it.
   */
  // The retry chain backs off up to base*2^2 ~ 800ms (+/-20%) on its last hop,
  // so these two tests wait it fully OUT before swapping mocks, or a straggler
  // retry from the FIRST failing write lands on the SECOND mock and pollutes
  // its call count. The key enters the un-acked set already in `flushSync`,
  // before the first PUT, so it says nothing about the chain: its end is the
  // fourth call to fetch (`waitForRetryChainExhausted`).

  test("teardown flush carries a compare-and-swap base=, like syncServer.ts's channel", async () => {
    installFetch(false); // stays un-acked, so flushAllPending has something to beacon
    saveProjectLayout(KEY, PROJECT, layout("terminal:fe2a97aa"));
    await waitForRetryChainExhausted();
    expect(__getUnackedProjectSyncKeys()).toContain(KEY);
    __flushAllProjectSyncForTests();
    expect(beaconCalls.some((c) => c.url.includes(encodeURIComponent(KEY)) && c.url.includes("base="))).toBe(
      true,
    );
  }, BUDGET_MS);

  test("a 409 (row moved on) on the teardown keepalive fallback is TERMINAL, no retry storm", async () => {
    // No sendBeacon on this pass — forces the keepalive-fetch fallback path,
    // which is the one that can observe the 409 status.
    (globalThis as unknown as { navigator: unknown }).navigator = {};
    installFetch(false);
    saveProjectLayout(KEY, PROJECT, layout("terminal:fe2a97aa"));
    await waitForRetryChainExhausted();
    expect(__getUnackedProjectSyncKeys()).toContain(KEY);

    fetchCalls = [];
    (globalThis as unknown as { fetch: unknown }).fetch = async (
      url: string,
      init?: { body?: string; keepalive?: boolean },
    ): Promise<Response> => {
      fetchCalls.push({ url: String(url), body: init?.body ?? "", keepalive: !!init?.keepalive });
      return { ok: false, status: 409, json: async () => ({}) } as unknown as Response;
    };
    __flushAllProjectSyncForTests();
    // THE LAST SLEEP IN A FILE THAT HAD ALREADY GIVEN UP SLEEPING.
    //
    // The comment on `settle` above says it: waiting for the condition beats
    // waiting for the clock. This call site kept the fixed 2.5 s anyway, and
    // on a shard that takes eighteen minutes the lagging timer had not even
    // issued the ONE keepalive fetch by the time the sleep ran out, so the
    // count was 0 and the red named a retry storm that never happened.
    //
    // Wait for the attempt to BE there, then sleep to see whether a second
    // one follows. The assertion that matters is unchanged, and it still
    // fails if the product retries: the straggler lands in that window.
    await waitFor(() => fetchCalls.length >= 1, "the single post-409 keepalive PUT");
    await settle();
    // Exactly one attempt: re-sending a write the server already refused as
    // stale — because the row moved on — can only fail again or, worse, win
    // by luck and overwrite state fresher than what this dying tab held.
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]?.url).toContain("base=");
  }, BUDGET_MS);
});
