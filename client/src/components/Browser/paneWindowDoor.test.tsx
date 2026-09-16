/**
 * @covers LINK-TAB-02
 *
 * A CHAT PANE HOSTED IN A PROJECT WINDOW DOES NOT TAKE THE FIRST LINK.
 *
 * `openLink` asks the door registry BEFORE it dispatches `browser:open-tab`,
 * so a door open here is a door the project layout never gets to answer: the
 * link becomes a sheet of the topic's window instead of a browser pane beside
 * the chat, which is the behaviour `LINK-TAB-02` keeps for project windows.
 *
 * The rule is a hook and the hook is mounted, rather than the boolean being
 * re-stated here: what is asserted is the question the product really asks
 * (`topicWindowTakesLink`), through the registry the product really writes to.
 * The scenario in `tests/e2e/topic-browser-window.spec.ts` (TOPIC-BROWSER-04d)
 * measures the same rule on the layout itself.
 */
import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../../test/reactHarness';
import { usePaneWindowDoor, type TopicBrowserPresence } from './topicBrowserWindowLazy';
import { topicWindowTakesLink } from '../../lib/topicWindowDoor';

const TOPIC = 'topic-in-a-project';

const NO_WINDOW: TopicBrowserPresence = { mode: 'hidden', expandedWidth: null, sheets: 0, promoted: 0 };
/** Hidden is not absent: the X keeps the sheets, and a window with sheets is a
 *  window. This is the shape `hasTopicBrowserWindow` says exists. */
const PARKED_WINDOW: TopicBrowserPresence = { mode: 'hidden', expandedWidth: null, sheets: 1, promoted: 0 };

function probe(presence: () => TopicBrowserPresence) {
  return function Probe() {
    usePaneWindowDoor(TOPIC, presence());
    return null;
  };
}

const takesLink = (): boolean =>
  topicWindowTakesLink({ url: 'https://example.test/from-the-chat', contextId: 'ctx-fresh', topicId: TOPIC });

describe('la porta di una chat-pane', () => {
  it('resta chiusa finche\' la finestra non esiste: il primo link e\' del layout che ospita la chat', () => {
    const presence = NO_WINDOW;
    const harness = mount(createElement(probe(() => presence)));
    try {
      expect(takesLink()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  it('si apre quando la finestra c\'e\' gia\', che e\' la regola che il progetto aveva sempre avuto', () => {
    let presence = PARKED_WINDOW;
    const harness = mount(createElement(probe(() => presence)));
    try {
      expect(takesLink()).toBe(true);
      // And it closes again with the window: the rule follows the presence, it
      // is not decided once at mount.
      presence = NO_WINDOW;
      harness.rerender();
      expect(takesLink()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  it('smontata la chat, la porta non resta aperta dietro di lei', () => {
    let presence = PARKED_WINDOW;
    const harness = mount(createElement(probe(() => presence)));
    expect(takesLink()).toBe(true);
    harness.unmount();
    expect(takesLink()).toBe(false);
  });
});
