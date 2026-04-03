## Why

Unread notifications get stuck and are hard to clear. The mark-as-read logic only fires when a `ChatPanel` gains focus (`isFocused=true`), so if a user is on a project view seeing an aggregated 56-unread badge, there's no way to clear it without clicking into each individual topic. Project folders in the sidebar show summed unreads, but individual child topics may not be visible (collapsed tree), and there's no "mark all read" action on project folders.

Additionally, chat scroll behavior has edge cases: the scroll-to-bottom button, auto-scroll on streaming, and scroll anchoring need verification and hardening via E2E tests to prevent regressions.

## What Changes

- **Mark all read on project folders**: Right-click context menu on project folders in the sidebar gains a "Mark all as read" action that clears unreads for all child topics.
- **Unread badge visibility in expanded project tree**: Ensure individual topic unread badges are visible when a project folder is expanded, not only as an aggregated sum on the folder row.
- **Auto-mark-as-read when opening project view**: When a ProjectWindow opens with a topic's chat visible, mark that topic as read (same as ChatPanel focus behavior).
- **E2E tests for scroll behavior**: Write Playwright tests covering auto-scroll on new messages, no-auto-scroll when reading history, scroll-to-bottom button appearance and click, and streaming scroll anchoring.

## Capabilities

### New Capabilities

### Modified Capabilities
- `topics`: Add "Mark all as read" context menu action on project folders, ensure unread badges visible on child topics in expanded tree.
- `chat`: Verify and harden auto-scroll, scroll-to-bottom button, and streaming scroll anchoring via E2E tests.

## Impact

- **client/src/components/Sidebar/TopicTree.tsx**: Add context menu item for project folder mark-all-read, verify unread badge rendering for child topics.
- **client/src/components/Layout/ProjectWindow.tsx**: Add mark-as-read when project's active chat pane gains focus.
- **client/src/lib/api.ts**: May need a bulk mark-read endpoint or reuse existing per-topic calls.
- **tests/e2e/**: New scroll and unread E2E test files.
