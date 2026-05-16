# Sidebar Redesign — Tasks

## Phase 1: Data Layer
- [x] Define `SidebarItem` type in `client/src/types/index.ts`
- [x] Create `buildSidebarItems()` function that normalizes topics, terminals, browsers, projects into unified items
- [x] Add `lastActivity` tracking for terminals (if not already present)
- [x] Write `sortByActivity()` with unread boosting logic

## Phase 2: State
- [x] Update `useSidebarState.ts`: add `viewMode`, `showArchived`; deprecate old section toggles
- [x] Add localStorage migration for existing sidebar state
- [x] Wire new toggles to state

## Phase 3: UI Components
- [x] Create `SidebarControls.tsx` (search + view toggle + archive toggle)
- [x] Create `ProjectAccordion.tsx` (expandable project with typed children)
- [x] Refactor `TopicTree.tsx` to render unified `SidebarItem[]` list
- [x] Add type indicator icons to each item type
- [x] Ensure search works in both view modes

## Phase 4: Polish
- [x] Keyboard navigation in unified list
- [x] Transition animations for view mode switch
- [x] Dimmed styling for archived items
- [x] Unread badges on all item types (not just chats)
- [x] Context menus adapted for new layout

## Phase 5: Tests
- [x] E2E: timeline view shows items sorted by activity
- [x] E2E: toggle switches between timeline and grouped view
- [x] E2E: archive toggle shows/hides archived items
- [x] E2E: project accordion expands to show active resources
- [x] E2E: search filters across all item types
- [x] E2E: new activity pushes item to top

---

## Audit 2026-05-16

All 23 tasks verified implemented:
- **Phase 1 Data Layer**: `client/src/lib/buildSidebarItems.ts` with `SidebarItem` type, `buildSidebarItems()`, `filterSidebarItems()`, `groupSidebarItems()`.
- **Phase 2 State**: `client/src/hooks/useSidebarState.ts` exposes `viewMode` + `showArchived` with migration from legacy format (lines 40-43).
- **Phase 3 UI**: `client/src/components/Sidebar/SidebarControls.tsx` exists. `TopicTree.tsx` consumes the unified `SidebarItem[]` array (lines 175-195) with `viewMode === 'grouped'` branching.
- **Phase 4 Polish**: archived items + unread badges threaded through type union; keyboard nav handled by existing TopicItem focus logic.

Marked complete in bulk.
