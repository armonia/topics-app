import { test } from '@playwright/test';

test.describe('@plan-30-04 browser tab open + agent integration (BROWSER-CHAT-04)', () => {
  test.beforeEach(async ({}, testInfo) => {
    testInfo.annotations.push({ type: 'spec', description: 'BROWSER-CHAT-04' });
    testInfo.annotations.push({ type: 'plan', description: '30-04' });
  });

  test.fixme('BROWSER-CHAT-04: + Browser menu opens new tab in topic', async () => {
    // Open topic -> click '+' on PaneTabBar -> click 'Browser' -> assert RemoteBrowserPanel
    // mounted with about:blank, connection indicator visible.
  });

  test.fixme('BROWSER-CHAT-04: /browser <url> slash command opens tab and navigates', async () => {
    // Type "/browser https://example.com" in chat input -> press Enter -> assert
    // browser pane opens, URL bar shows "https://example.com", screenshot non-empty.
  });

  test.fixme('BROWSER-CHAT-04: @browser slash command invokes agent with browser tools', async () => {
    // Type "@browser open github.com" -> assert provider.sendChat called with
    // options.tools includes 'browser_open'; agent_active overlay appears, then
    // disappears within 30s.
  });

  test.fixme('BROWSER-CHAT-04: Take control toggle releases agent lock', async () => {
    // Trigger agent_active=true via mock -> assert overlay visible -> click
    // 'Take control' -> assert WS sent {type:'take_control'} -> assert overlay
    // gone, agentActive=false.
  });

  test.fixme('BROWSER-CHAT-04: Cmd+Shift+E enters select-element mode', async () => {
    // Focus browser pane -> press Cmd+Shift+E (or Control+Shift+E on Linux) ->
    // hover element -> click -> assert chat input populated with
    // "Selected element: <tag>.<class> @ <path> (bbox: x,y,w,h)".
  });

  test.fixme('BROWSER-CHAT-04: localhost URLs render via iframe fallback', async () => {
    // Navigate to "http://localhost:3333" -> assert <iframe src> rendered (not <img>)
    // -> assert agent_act/observe REST returns { error: "...localhost iframe..." }.
  });
});
