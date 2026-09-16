/**
 * BOTH SHELLS LET YOU TAKE THE WHEEL BACK, or neither may ship.
 *
 * THE DEFECT (review of the card that removed the darkening overlay). The
 * streaming pane lost the box with the button and gained two handles instead:
 * a transparent layer over the page that turns the first click into
 * `take_control`, and the tab's agent glyph, which is a button because the
 * panel publishes a `takeControl` command. The native shell got neither: its
 * page is a child webview that composites ABOVE the DOM, so no layer over it
 * can catch anything, and its command map did not publish `takeControl` - so
 * the tab drew a plain glyph. An agent could drive a native pane with no way
 * on screen to stop it, which is worse than the box that was removed.
 *
 * Why the assertion is on the SOURCE. The two command maps are built inside
 * two panel components that each open a real native webview or a real socket
 * on mount; there is no harness that mounts either, and writing one to observe
 * one key of one object would be a heavier fake than the thing it guards. The
 * wire underneath each command IS executed elsewhere: the native frame in
 * `nativeExecutorSocket.test.ts`, the streaming one in the e2e that clicks the
 * page (BROWSER-CHAT-04e). What can only be checked here is that each panel
 * hands the command to the tab at all.
 *
 * @covers BROWSER-CHAT-04
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PANEL = readFileSync(join(import.meta.dir, 'RemoteBrowserPanel.tsx'), 'utf8');

/** The body of the object literal passed to `useMemo` and assigned to `name`. */
function commandMap(name: string): string {
  const start = PANEL.indexOf(`const ${name} = useMemo(() => ({`);
  expect(start).toBeGreaterThan(-1);
  const end = PANEL.indexOf('}), [', start);
  expect(end).toBeGreaterThan(start);
  return PANEL.slice(start, end);
}

describe('the agent glyph is a button on BOTH shells', () => {
  for (const map of ['chromeCommands', 'sharedCommands']) {
    test(`${map} publishes takeControl while an agent is driving`, () => {
      const body = commandMap(map);
      expect(body).toContain('takeControl:');
      // Only while one is driving: a command that ends a state nobody is in
      // would be a dead row in the sheet and a button on a quiet tab.
      expect(body).toContain('browser.agentActive ? takeControlFromAgent : undefined');
    });
  }

  test('both shells announce the handover with the same short notice', () => {
    // Taking the wheel back ends a state that was invisible by design: without
    // the notice the click looks ignored. Two call sites, one per panel.
    const notices = PANEL.match(/toast\.info\(tr\('browser\.agent\.tookControl'\), 3000\)/g) ?? [];
    expect(notices).toHaveLength(2);
  });
});
