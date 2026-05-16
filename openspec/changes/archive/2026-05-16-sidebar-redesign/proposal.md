# Sidebar Redesign: Unified Activity Timeline

## What
Rethink the sidebar from 4 fixed sections (Projects, Chats, Terminals, Browser) into a **single flat timeline** ordered by most recent activity. Projects appear inline as accordion items alongside chats, terminals, and browsers — all sorted together by last update/notification.

A toggle button next to the search bar switches between:
- **Timeline view** (default): flat list, sorted by recency, projects as expandable accordions
- **Grouped view**: items grouped by type (Projects, Chat, Terminals, Browser), each group sorted by recency

A second toggle controls archived item visibility.

## Why
The current 4-section layout with fixed dividers forces the user to mentally map where things are by type. In practice, you care about **what's active right now** — the sidebar should surface that naturally, like a phone's recent apps.

## Scope
- **TopicTree.tsx**: complete rewrite of rendering logic
- **useSidebarState.ts**: new state for view mode, archived toggle
- **TopicItem.tsx**: adapt for unified list (show type indicator)
- **SidebarStatusBar.tsx**: may simplify since items self-sort by activity
- Server: no schema changes needed — all data already exists

## Out of scope
- Renaming "Topic" to "Chat" in the data model (cosmetic, separate change)
- Drag-to-reorder (timeline is auto-sorted by activity)
- Changes to the pane/tab system
