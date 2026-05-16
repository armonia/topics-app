# Tab Notification Badges

## What

A unified, generic notification system for pane tabs. Any pane type (chat, browser, terminal, agents, etc.) can accumulate notification badges that display as counts on the tab in PaneTabBar. The system integrates existing indicators (streaming spinner, unread counts, agent session status) without duplicating them — it adds a new, complementary badge layer for events that currently have no tab-level visibility.

## Why

Currently, important events get lost when the user isn't looking at the right pane:

- **Agent/Claude sessions finish** → push notification fires (if enabled), but there's no in-app tab badge. The user has to check the agents pane or notice the streaming spinner stopped.
- **Terminal errors** → no visual indicator on the terminal tab at all.
- **Approval requests** → push notification only, no tab badge on the agents/chat pane.
- **New messages in non-active chat tabs** → unread count exists in sidebar but NOT on the tab itself when multiple chats are open in a group.

The existing indicators are purpose-specific and scattered. This feature adds a generic notification badge that works across all pane types, with a simple hook API for any component to emit notifications.

## Scope

### In scope
- `useTabNotifications` hook — manages notification state per pane ID
- Badge rendering in PaneTabBar — numeric count badge on tabs
- Notification sources: agent session completion, terminal errors, approval requests, chat messages in non-active tabs
- Badge clears when tab is activated (focused)
- Coexistence with existing streaming spinner, context ring, project status

### Out of scope
- Notification center/drawer (future)
- Sound/audio notifications
- Notification preferences/settings UI
- Modifying existing push notification system
- Toast/snackbar in-app notifications
