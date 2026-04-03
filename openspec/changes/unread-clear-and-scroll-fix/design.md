## Context

The unread system tracks per-topic counts in an SQLite `unread` table. The server increments counts when messages arrive for unfocused topics and resets via `POST /api/topics/:id/read`. The client auto-marks-as-read in `ChatPanel.tsx` when `isFocused` becomes true, sending both an API call and a WebSocket `focus` event.

Project folders in the sidebar aggregate child topic unreads via `allChats.reduce(sum, unreadData[t.id]?.unreadCount)`. Individual topics show badges via `TopicItem.tsx` (hidden when focused). The user's issue: 56 unreads stuck on a project folder with no way to clear them from the project view.

Chat scroll uses React Virtuoso with `followOutput={'smooth'}`, `atBottomThreshold={50}`, a scroll-to-bottom FAB, and direct DOM `scrollTop = scrollHeight` during streaming. The system is mostly working but needs E2E test coverage for regression prevention.

## Goals / Non-Goals

**Goals:**
- "Mark all as read" context menu on project folders (clears all child topic unreads)
- Unread badges visible on individual topics within expanded project tree
- Auto-mark-as-read in ProjectWindow when a chat pane is active
- E2E tests for chat scroll: auto-scroll, no-scroll-when-up, scroll-to-bottom button, streaming anchoring

**Non-Goals:**
- Changing the scroll library or Virtuoso configuration
- Adding per-message read receipts
- Changing the visual design of unread badges

## Decisions

### D1: Mark all read via sequential per-topic POST calls

Reuse the existing `POST /api/topics/:id/read` endpoint for each child topic. No new bulk endpoint needed — the number of child topics per project is small (typically <20), and the calls are fast fire-and-forget.

**Why not a bulk endpoint?** Over-engineering for the use case. The UI can fire N parallel fetches and the server handles them fine.

### D2: Context menu on project folder row in TopicTree

The TopicTree already has context menus on topic items. Add a handler on project folder rows (`onProjectContextMenu`) that includes "Mark all as read" when the project has unreads. This follows the existing pattern in TopicItem's context menu.

### D3: ProjectWindow chat focus triggers mark-as-read

ProjectWindow already renders chat panes via `StandaloneChatGroup` or similar. When a chat tab within the project gains focus, it should call `markRead()` just like the top-level `ChatPanel` does. Check if this is already happening (via shared `ChatPanel` component) or needs explicit wiring.

### D4: E2E tests use real server, mock WebSocket for streaming edge cases

Scroll tests run against `localhost:3333` with real message history. For streaming-specific tests, use Playwright's `page.routeWebSocket()` to inject controlled streaming events.

## Risks / Trade-offs

- **[Sequential mark-read calls]** — For a project with 20 topics, that's 20 parallel POSTs. Acceptable latency (<100ms total). Server handles concurrent writes to SQLite fine with WAL mode.
- **[E2E scroll tests are inherently flaky]** — Use generous timeouts and `expect.poll()` for scroll position assertions. Test against real Virtuoso behavior, not mocked scroll positions.
