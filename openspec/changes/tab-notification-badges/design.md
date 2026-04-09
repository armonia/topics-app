# Design: Tab Notification Badges

## Key Design Decision: Topic-Centric, Not Pane-Centric

Badge state is keyed by **topicId**, not paneId. This is critical because:
- Same topic can be open in multiple panes (standalone + project + detached window)
- Same topic can be open across Electron windows
- Existing `unreadData` is already topic-centric

The hook resolves topicId → all pane IDs at render time.

## Architecture

### Source of Truth: Existing `unreadData`

For chat messages, we do NOT create a parallel counter. We reuse the existing `unreadData[topicId].unreadCount` from `useWebSocket`. This is already maintained by the server and survives WS reconnection.

For non-chat notifications (agent completion, approvals, terminal errors), we add a lightweight overlay counter that augments unreadData.

### New Hook: `useTabNotifications`

**File:** `client/src/hooks/useTabNotifications.ts`

```typescript
interface TabNotificationsState {
  // Non-chat notification counts (agents, approvals, terminal errors)
  // Chat notifications come from existing unreadData
  extraCounts: Map<string, number>;     // paneId → count (for non-topic panes like agents, terminal)
  lastNotifiedAt: Map<string, number>;  // topicId → timestamp (for sidebar sort)
}

interface UseTabNotificationsReturn {
  // Get badge count for a pane (combines unreadData + extra counts)
  getBadgeCount: (paneId: string, topicId?: string) => number;
  // Notify non-chat pane (agents, terminal)
  notifyPane: (paneId: string) => void;
  // Clear non-chat pane badge
  clearPane: (paneId: string) => void;
  // Track notification timestamps for sidebar ordering
  lastNotifiedAt: Map<string, number>;
}
```

- Chat badges: reads directly from `unreadData[topicId].unreadCount`
- Non-chat badges: maintains own `extraCounts` Map
- Sidebar sorting: maintains `lastNotifiedAt` timestamps per topicId
- Exposed via React context

### Context Provider: `TabNotificationProvider`

Wraps the app at top level in App.tsx. Receives `unreadData` from useWebSocket and merges with extra counts.

### Integration Points

#### 1. Chat Messages (TAB-BADGE-01, 07, 12, 14)
**Source:** Existing `unreadData` from useWebSocket — NO new code needed for accumulation.
**Tab badge:** `getBadgeCount(paneId, topicId)` returns `unreadData[topicId]?.unreadCount || 0` when pane is inactive.
**Multi-pane sync (TAB-BADGE-12):** Since source is topic-centric, all panes for same topicId automatically show same count.
**Clear:** Already handled by existing `{type: "focus", topicId}` WS message to server, which resets `unreadCount`.

#### 2. Agent Session Completion (TAB-BADGE-03)
**Where:** WS handler for `agents:sessions` in App.tsx
**How:** When session transitions to 'completed'/'error', call `notifyPane(agentsPaneId)`.

#### 3. Approval Requests (TAB-BADGE-04)
**Where:** WS handler for `approval:created`
**How:** `notifyPane(agentsPaneId)`.

#### 4. Terminal Errors (TAB-BADGE-06)
**Where:** Terminal component data handler
**How:** `notifyPane(terminalPaneId)`. Badge shows "!" for error type.

#### 5. Badge Clear (TAB-BADGE-02)
**Where:** `PaneTabBar.tsx` `onActivate` handler
**How:** For chat panes: send `{type: "focus", topicId}` (already exists). For non-chat: call `clearPane(paneId)`.

### Cross-Window Sync (TAB-BADGE-13)

**Mechanism:** Electron IPC for focus state broadcast.

1. When a window focuses a topic, it sends `focus:topic` via Electron IPC
2. Main process broadcasts to ALL other windows
3. Each window's WS connection sends `{type: "focus", topicId}` to server
4. Server resets `unreadCount` for that topic
5. Next `unread:updated` WS broadcast clears badges in all windows

**Fallback for browser (non-Electron):** Single window, no sync needed.

### PaneTabBar Changes

**New prop:** `tabNotifications?: Map<string, number>`

**Rendering (between title and close button):**
```tsx
{badgeCount > 0 && (
  <span className="ml-1 px-1.5 min-w-[18px] h-[18px] text-[10px] font-medium 
    bg-primary text-white rounded-full flex items-center justify-center flex-shrink-0">
    {badgeCount > 99 ? '99+' : badgeCount}
  </span>
)}
```

Position: after streaming spinner (if present), before close button.

### Data Flow

```
Chat message flow (reuses existing):
  WS message:new → server updates unreadCount → WS unread:updated → 
  useWebSocket updates unreadData → PaneTabBar reads via getBadgeCount → badge visible
  
  Tab click → existing focus WS message → server clears unread → badge gone

Non-chat flow (new):
  WS agents:sessions/approval:created → notifyPane(id) → 
  extraCounts Map update → PaneTabBar re-render → badge visible
  
  Tab click → clearPane(id) → extraCounts reset → badge gone
```

### Sidebar Topic Reorder (TAB-BADGE-10, 11)

**Where:** `buildSidebarItems.ts` / `TopicTree.tsx`

**Current behavior:** buildSidebarItems already sorts unread topics first (line 278: `bHasUnread - aHasUnread`). This means TAB-BADGE-10 is **partially already implemented** for chat messages.

**Enhancement needed:**
1. Pass `lastNotifiedAt` map to buildSidebarItems
2. Among unread topics, sort by `lastNotifiedAt` DESC (most recent notification first)
3. When notification clears, topic falls back to normal `lastActivity` sort

**Animation (TAB-BADGE-11):** Use CSS `transition: transform` on sidebar items, or leverage existing sidebar DOM update patterns.

### Window Refocus (TAB-BADGE-16)

**Where:** `App.tsx` visibilitychange handler

When app window regains focus:
1. Check which pane is currently active
2. Send `{type: "focus", topicId}` for that pane's topic only
3. Other tabs retain their badges

### What We DON'T Touch

- Streaming spinner — stays as-is, independent
- Context ring — stays as-is, independent  
- Project status indicators — stays as-is, independent
- Push notifications — stays as-is (server-side), independent
- Browser Notification API calls — stays as-is
- Browser/Board panes — no badge (not message-like content)

### What We Leverage (Not Duplicate)

- `unreadData` from useWebSocket — THE source of truth for chat badges
- `{type: "focus", topicId}` WS message — existing clear mechanism
- `buildSidebarItems` unread sort — already partially implements sidebar reorder
- Sidebar unread badge — stays, tab badge is complementary (same data)

### Performance

- Chat badges: zero new state — reads existing unreadData
- Non-chat badges: Map<string, number> updates are O(1)
- PaneTabBar re-renders only on notification change (via context selector or memo)
- No polling — purely event-driven via existing WS infrastructure
- Cross-window sync: one IPC message per focus change (negligible)
