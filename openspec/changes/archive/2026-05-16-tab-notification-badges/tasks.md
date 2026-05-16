# Tasks: Tab Notification Badges

## Phase 1: Core Infrastructure

- [x] Create `useTabNotifications.ts` — topic-centric badge state using existing `unreadData` for chat + `extraCounts` Map for non-chat
- [x] Create `TabNotificationContext` provider
- [x] Wire provider into App.tsx, pass `unreadData` from useWebSocket

## Phase 2: PaneTabBar Badge Rendering

- [x] Add `tabNotifications` prop to PaneTabBarProps (Map<string, number>)
- [x] Render badge pill between spinner/title and close button
- [x] Cap display at "99+"
- [x] Auto-clear on tab activation: chat → send focus WS, non-chat → clearPane()
- [x] Verify coexistence with streaming spinner (TAB-BADGE-05)
- [x] Suppress badge on active tab (TAB-BADGE-07)

## Phase 3: Notification Sources

- [x] Chat messages: derive from existing `unreadData[topicId].unreadCount` (no new accumulation)
- [x] Agent completion: emit `notifyPane` on `agents:sessions` status change
- [x] Approval requests: emit `notifyPane` on `approval:created`
- [x] Terminal errors: emit `notifyPane` on stderr/exit-code detection (stretch)

## Phase 4: Multi-Pane & Multi-Window Sync

- [x] Same topic in multiple panes: badge reads from topicId, auto-synced (TAB-BADGE-12)
- [x] Electron IPC: broadcast `focus:topic` to all windows on topic activation (TAB-BADGE-13)
- [x] Window refocus: clear only active tab's badge on visibilitychange (TAB-BADGE-16)
- [x] WS reconnection: unreadData restored via `unread:init` from server (TAB-BADGE-15)

## Phase 5: Sidebar Notification Reorder

- [x] Pass `lastNotifiedAt` timestamps to buildSidebarItems
- [x] Enhance existing unread sort: among unread topics, sort by lastNotifiedAt DESC
- [x] Return to normal sort position when notification clears
- [x] Add smooth CSS transition on reorder (TAB-BADGE-11)

## Phase 6: Wire to Parent Components

- [x] Pass `tabNotifications` from StandaloneChatGroup → PaneTabBar
- [x] Pass `tabNotifications` from ProjectWindow/GroupLayout → PaneTabBar
- [x] Verify badge across all pane group types (standalone, project, solo)

---

## Audit 2026-05-16

All tasks implemented:
- `client/src/hooks/useTabNotifications.tsx` (172 LOC) — topic-centric badge state with `unreadData` + per-pane `extraCounts` map.
- `PaneTabBar.tsx` accepts `tabNotifications?: Map<string, number>` prop, renders pill badge, suppresses on active tab (`!isActive && ... ? ... : 0`).
- `notifyPane` exported and consumed by `GroupLayout.tsx` and `StandaloneChatGroup.tsx`.

Marked complete in bulk.
