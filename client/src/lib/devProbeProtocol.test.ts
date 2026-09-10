/**
 * How a dev probe learns it is armed — and, above all, what it does NOT do to
 * find out.
 *
 * The three probes used to open a `GET /api/ui-state/<flag>` each at App mount:
 * three unconditional round trips per window per boot, answering "no" nearly
 * always, spent in the exact instant the chat history wants one of the six
 * connections a browser gives per host. The answer rides on `ui-state:init`,
 * which the server pushes on every socket open.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { readProbeFlag, __resetArmingSnapshotForTests } from './devProbeProtocol';
import { dispatchFrame } from './wsFrameBus';

afterEach(() => { __resetArmingSnapshotForTests(); });

/** Fails the test if anything reaches the network. */
function forbidFetch(): () => void {
  const g = globalThis as Record<string, unknown>;
  const before = g.fetch;
  g.fetch = (url: unknown) => { throw new Error(`the arming read must not fetch: ${String(url)}`); };
  return () => { g.fetch = before; };
}

describe('readProbeFlag', () => {
  test('reads the flag off the ui-state:init frame, without a single request', async () => {
    const restore = forbidFetch();
    try {
      const armed = readProbeFlag('dev-layout-probe');
      const idle = readProbeFlag('dev-heap-probe');
      dispatchFrame({
        type: 'ui-state:init',
        data: { 'dev-layout-probe': { armed: true }, 'pane-store-v2': {} },
        meta: {},
      });
      expect(await armed).toBe(true);
      // A key the snapshot does not carry is not armed — the common case.
      expect(await idle).toBe(false);
    } finally {
      restore();
    }
  });

  test('one subscription for all three: the frame is read once, whoever asked', async () => {
    // The three probes ask separately (three `useEffect` in App). If each one
    // subscribed on its own, only the first would see a frame dispatched
    // before the others registered.
    const a = readProbeFlag('dev-layout-probe');
    dispatchFrame({ type: 'ui-state:init', data: { 'dev-storage-probe': { armed: true } } });
    const late = readProbeFlag('dev-storage-probe');
    expect(await a).toBe(false);
    expect(await late).toBe(true);
  });

  test('`armed: false` is a flag that exists and says no — the disarmed state', async () => {
    const p = readProbeFlag('dev-heap-probe');
    dispatchFrame({ type: 'ui-state:init', data: { 'dev-heap-probe': { armed: false } } });
    expect(await p).toBe(false);
  });

  test('a frame with no usable payload leaves every probe inert instead of throwing', async () => {
    const p = readProbeFlag('dev-heap-probe');
    dispatchFrame({ type: 'ui-state:init' });
    expect(await p).toBe(false);
  });
});
