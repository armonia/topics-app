## 1. Mark All Read on Project Folders

- [x] 1.1 Add "Mark all as read" to project folder context menu in TopicTree.tsx — only show when project has child topics with unreads
- [x] 1.2 Implement handler: iterate child topics with unreadCount > 0, call `POST /api/topics/:id/read` for each
- [x] 1.3 Verify aggregated badge on project folder clears after mark-all-read

## 2. Unread Badge Visibility in Project Tree

- [x] 2.1 Verify that TopicItem renders unread badge for child topics inside expanded project folders (check `isFocused` condition doesn't suppress them incorrectly)
- [x] 2.2 If badges are hidden due to project-level aggregation logic, fix to show both individual and aggregated badges

## 3. Mark-as-Read in ProjectWindow

- [x] 3.1 Check if ProjectWindow's chat panes already trigger markRead on focus (they may share ChatPanel component)
- [x] 3.2 If not, add markRead call when a chat tab gains focus inside ProjectWindow — same pattern as ChatPanel.tsx effect

## 4. E2E Tests — Unread Clearing

- [x] 4.1 Write E2E test: send message to unfocused topic, verify unread badge appears in sidebar
- [x] 4.2 Write E2E test: click on topic with unreads, verify badge clears
- [x] 4.3 Write E2E test: right-click project folder with unreads, use "Mark all as read", verify all badges clear

## 5. E2E Tests — Chat Scroll

- [x] 5.1 Write E2E test: send message while at bottom, verify auto-scroll to new content
- [x] 5.2 Write E2E test: scroll up, send message, verify NO auto-scroll and scroll-to-bottom button appears
- [x] 5.3 Write E2E test: click scroll-to-bottom button, verify scrolls to latest message and button disappears
- [x] 5.4 Write E2E test: streaming response keeps scroll at bottom while content grows
