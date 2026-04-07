# Sidebar Redesign — Tasks

## Phase 1: Data Layer
- [ ] Define `SidebarItem` type in `client/src/types/index.ts`
- [ ] Create `buildSidebarItems()` function that normalizes topics, terminals, browsers, projects into unified items
- [ ] Add `lastActivity` tracking for terminals (if not already present)
- [ ] Write `sortByActivity()` with unread boosting logic

## Phase 2: State
- [ ] Update `useSidebarState.ts`: add `viewMode`, `showArchived`; deprecate old section toggles
- [ ] Add localStorage migration for existing sidebar state
- [ ] Wire new toggles to state

## Phase 3: UI Components
- [ ] Create `SidebarControls.tsx` (search + view toggle + archive toggle)
- [ ] Create `ProjectAccordion.tsx` (expandable project with typed children)
- [ ] Refactor `TopicTree.tsx` to render unified `SidebarItem[]` list
- [ ] Add type indicator icons to each item type
- [ ] Ensure search works in both view modes

## Phase 4: Polish
- [ ] Keyboard navigation in unified list
- [ ] Transition animations for view mode switch
- [ ] Dimmed styling for archived items
- [ ] Unread badges on all item types (not just chats)
- [ ] Context menus adapted for new layout

## Phase 5: Tests
- [ ] E2E: timeline view shows items sorted by activity
- [ ] E2E: toggle switches between timeline and grouped view
- [ ] E2E: archive toggle shows/hides archived items
- [ ] E2E: project accordion expands to show active resources
- [ ] E2E: search filters across all item types
- [ ] E2E: new activity pushes item to top
