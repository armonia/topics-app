# Topics App — E2E Test Suite

**32 tests, full coverage** across all major features.

## Running

```bash
# Run all tests (~3.5 minutes)
cd /Users/user/.openclaw/workspace
bash topics-app/tests/e2e/run-all.sh

# Run a single test
node skills/e2e-video-test/scripts/e2e-test.mjs \
  --url "https://localhost:3333" \
  --script "./topics-app/tests/e2e/<test>.mjs" \
  --output ./topics-app/uploads/test-recordings/
```

## Test Suite

### Core Chat (9 tests)
| Test | What it covers |
|------|-------------|
| `chat-flow-test` | Send message → receive streaming response |
| `chat-history-test` | Open topic → historical messages load |
| `chat-abort-test` | Send long message → stop mid-stream |
| `chat-input-features-test` | Toolbar: attach, voice, tools, plan, send |
| `chat-multiline-test` | Shift+Enter creates new lines |
| `message-rendering-test` | Markdown renders: bold, code, lists, links |
| `scroll-behavior-test` | Scroll-to-bottom button works |
| `plan-mode-test` | Plan mode toggle on/off |
| `pinned-messages-test` | Right-click message → context menu |

### Sidebar & Navigation (6 tests)
| Test | What it covers |
|------|-------------|
| `sidebar-navigation-test` | Click topics → panel switches correctly |
| `sidebar-projects-test` | Expand/collapse project folders |
| `topic-search-test` | Search filters topics, clear restores |
| `topic-create-test` | + dropdown → New Chat creates topic |
| `topic-archive-test` | Right-click → Archive removes from list |
| `topic-settings-test` | Right-click → context menu with options |

### Panels & Views (11 tests)
| Test | What it covers |
|------|-------------|
| `activity-feed-test` | Activity → Live/Digest tabs |
| `agents-panel-test` | Agents panel shows content |
| `board-view-test` | Kanban board renders |
| `multi-pane-test` | Add Pane creates split view |
| `dashboard-test` | Digest tab shows usage stats |
| `terminal-test` | New Terminal opens xterm |
| `browser-panel-test` | Browser section shows instances |
| `remote-access-test` | Remote Access panel opens |
| `file-explorer-test` | Project files browsable |
| `command-palette-test` | Cmd+K opens searchable palette |
| `scripts-runner-test` | Scripts API returns project scripts |

### System & Infrastructure (6 tests)
| Test | What it covers |
|------|-------------|
| `websocket-connection-test` | WS connects → "Online" status |
| `status-bar-test` | Status: latency, memory, fps |
| `keyboard-shortcuts-test` | Cmd+K, Cmd+B work |
| `mobile-responsive-test` | 375px viewport → layout adapts |
| `api-endpoints-test` | 7 API endpoints respond correctly |
| `error-recovery-test` | Invalid routes/API → graceful handling |

## Writing New Tests

```javascript
export default async function runTest({ page, expect }) {
  await page.goto("https://localhost:3333", { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  // Use role-based selectors (ARIA-first)
  await page.getByRole('treeitem', { name: /Topic Name/ }).click();
  await page.getByRole('textbox', { name: /Message input/ }).fill("test");
  await page.getByRole('button', { name: /Send/ }).click();

  // Assert
  const content = await page.locator('[role="main"]').textContent();
  expect(content).toContain("expected text");
}
```

### Key Selectors
- Main area: `[role="main"]` (not `main` tag)
- Sidebar items: `getByRole('treeitem', { name: /.../ })`
- Chat input: `getByRole('textbox', { name: /Message input/ })`
- Buttons: `getByRole('button', { name: /.../ })`
- Messages: `div.message-appear`, `div.message-content`

## Output
Each test produces in `uploads/test-recordings/`:
- `{timestamp}-recording.webm` — video
- `{timestamp}-result.json` — pass/fail + timing
- `{timestamp}-FAILURE.png` — screenshot on failure
