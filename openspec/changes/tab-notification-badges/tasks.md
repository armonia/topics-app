# Tasks: Tab Notification Badges

## Phase 1: Core Infrastructure

- [ ] Create `useTabNotifications.ts` — topic-centric badge state using existing `unreadData` for chat + `extraCounts` Map for non-chat
- [ ] Create `TabNotificationContext` provider
- [ ] Wire provider into App.tsx, pass `unreadData` from useWebSocket

## Phase 2: PaneTabBar Badge Rendering

- [ ] Add `tabNotifications` prop to PaneTabBarProps (Map<string, number>)
- [ ] Render badge pill between spinner/title and close button
- [ ] Cap display at "99+"
- [ ] Auto-clear on tab activation: chat → send focus WS, non-chat → clearPane()
- [ ] Verify coexistence with streaming spinner (TAB-BADGE-05)
- [ ] Suppress badge on active tab (TAB-BADGE-07)

## Phase 3: Notification Sources

- [ ] Chat messages: derive from existing `unreadData[topicId].unreadCount` (no new accumulation)
- [ ] Agent completion: emit `notifyPane` on `agents:sessions` status change
- [ ] Approval requests: emit `notifyPane` on `approval:created`
- [ ] Terminal errors: emit `notifyPane` on stderr/exit-code detection (stretch)

## Phase 4: Multi-Pane & Multi-Window Sync

- [ ] Same topic in multiple panes: badge reads from topicId, auto-synced (TAB-BADGE-12)
- [ ] Electron IPC: broadcast `focus:topic` to all windows on topic activation (TAB-BADGE-13)
- [ ] Window refocus: clear only active tab's badge on visibilitychange (TAB-BADGE-16)
- [ ] WS reconnection: unreadData restored via `unread:init` from server (TAB-BADGE-15)

## Phase 5: Sidebar Notification Reorder

- [ ] Pass `lastNotifiedAt` timestamps to buildSidebarItems
- [ ] Enhance existing unread sort: among unread topics, sort by lastNotifiedAt DESC
- [ ] Return to normal sort position when notification clears
- [ ] Add smooth CSS transition on reorder (TAB-BADGE-11)

## Phase 6: Wire to Parent Components

- [ ] Pass `tabNotifications` from StandaloneChatGroup → PaneTabBar
- [ ] Pass `tabNotifications` from ProjectWindow/GroupLayout → PaneTabBar
- [ ] Verify badge across all pane group types (standalone, project, solo)
