# Sidebar Redesign — Technical Design

## Architecture

### Unified Item Model

Create a `SidebarItem` type that normalizes all resource types:

```typescript
type SidebarItemType = 'project' | 'chat' | 'terminal' | 'browser';

interface SidebarItem {
  id: string;
  type: SidebarItemType;
  name: string;
  icon: string;
  lastActivity: number;        // timestamp ms
  unreadCount: number;
  archived: boolean;
  projectPath?: string;        // for project items
  children?: SidebarItem[];    // for project accordion (active resources)
  // Original data reference
  data: Topic | TerminalSession | BrowserContext | ProjectInfo;
}
```

### Data Flow

1. **Collect** all resources from existing state (topics, terminalSessions, browserContexts, workspaceProjects)
2. **Normalize** into `SidebarItem[]` via `buildSidebarItems()` — memoized with `useMemo`
3. **Sort** by `lastActivity` descending, with unread items boosted
4. **Group** projects: items with `projectPath` become children of their project's accordion
5. **Filter** archived items unless toggle is ON
6. **Render** based on view mode (flat timeline or grouped by type)

### State Changes to `useSidebarState`

```typescript
// New fields
viewMode: 'timeline' | 'grouped';     // default: 'timeline'
showArchived: boolean;                  // default: false

// Remove (no longer needed with unified list)
showProjects: boolean;    // → removed
showChats: boolean;       // → removed  
showTerminals: boolean;   // → removed
browserExpanded: boolean; // → removed
```

### TopicTree.tsx Refactor

Current: 4 hardcoded sections with dividers
New: single `<SidebarList>` that renders `SidebarItem[]`

- **Timeline mode**: flat `map()` over sorted items, projects render as `<Accordion>`
- **Grouped mode**: `groupBy(item.type)` then render each group with a section header

### Activity Tracking

Last activity timestamps come from:
- **Chat**: `topic.updatedAt` or last message timestamp
- **Terminal**: `terminalSession.lastActivity` (may need to add this field, or use WebSocket heartbeat)
- **Browser**: `browserContext.lastActivity` (already exists from polling)
- **Project**: `max(children.lastActivity)` — project's recency = its most recent child

### Search

Reuse existing `searchQuery` logic but apply to `SidebarItem.name`. For projects, match against children too (existing `matchesSearchWithDescendants` pattern).

## Components

```
Sidebar/
  TopicTree.tsx          → refactored: unified list renderer
  SidebarItem.tsx        → new: renders one SidebarItem (replaces TopicItem for non-chat)
  TopicItem.tsx          → kept: renders chat items (within project accordion or standalone)
  SidebarControls.tsx    → new: search bar + view toggle + archive toggle
  ProjectAccordion.tsx   → new: expandable project with children
```

## Migration

- `useSidebarState` gains new fields, old section toggles deprecated
- LocalStorage migration: read old state, map to new defaults
- No server/DB changes needed
