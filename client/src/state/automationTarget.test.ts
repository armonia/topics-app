/**
 * A link to one automation survives the view mounting twice for one gesture,
 * and is gone once the view shows the row.
 * @covers HUBBR-07
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openAutomation, peekAutomationTarget, settleAutomationTarget } from './automationTarget';

describe('HUBBR-07: opening Automazioni on one automation', () => {
  // The announcement needs a window to dispatch on; a bare event target is enough here.
  const g = globalThis as { window?: unknown };
  const before = g.window;
  beforeAll(() => { if (!before) g.window = new EventTarget(); });
  afterAll(() => { if (!before) delete g.window; });

  test('two mounts read the same key; showing the row settles it; it expires', () => {
    const at = 1_000_000;
    openAutomation('workflow:audit', at);
    expect(peekAutomationTarget(at + 100)).toBe('workflow:audit');
    // The second mount of the same gesture still finds it.
    expect(peekAutomationTarget(at + 200)).toBe('workflow:audit');
    // Another key does not settle this request.
    settleAutomationTarget('cron:x');
    expect(peekAutomationTarget(at + 300)).toBe('workflow:audit');
    settleAutomationTarget('workflow:audit');
    expect(peekAutomationTarget(at + 400)).toBeNull();
    openAutomation('cron:x', at);
    expect(peekAutomationTarget(at + 16_000)).toBeNull();
  });
});
