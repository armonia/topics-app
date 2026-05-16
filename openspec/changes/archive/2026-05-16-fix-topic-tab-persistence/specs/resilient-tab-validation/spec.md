## ADDED Requirements

### Requirement: Panel validation preserves unresolved topic tabs
The validation filter SHALL NOT drop panel IDs that match a UUID pattern but are not yet present in the `topics` map. These IDs SHALL be preserved in `openPanels` until a subsequent validation pass can definitively resolve them (topic found → keep, topic confirmed deleted/archived → remove).

#### Scenario: Topic tab survives HMR reload
- **WHEN** a topic tab (plain UUID) is open and Vite HMR triggers a full component remount
- **THEN** the tab MUST still be present in `openPanels` after the validation effect runs

#### Scenario: Topic tab survives full page reload
- **WHEN** a topic tab is open and the page is fully reloaded
- **THEN** the tab MUST be restored from persistence and survive validation

#### Scenario: Archived topic tab is still cleaned up
- **WHEN** a topic tab references an archived topic (found in `topics` with `archived: true`)
- **THEN** the tab SHALL be removed from `openPanels` as before

#### Scenario: Project-linked topic still converts to project pane
- **WHEN** a topic tab references a topic with `projectPath` set
- **THEN** the tab SHALL be removed and replaced with the corresponding project pane (existing behavior unchanged)

### Requirement: Validation gates on full sync completion
The panel validation effect SHALL NOT execute until both conditions are met: (1) `topicsLoading` is false, and (2) the initial server panels fetch has completed (`serverSyncedRef.current` is true).

#### Scenario: Validation skipped during initial load
- **WHEN** topics are loaded from cache but server panels fetch has not completed
- **THEN** the validation effect MUST NOT run and no tabs SHALL be filtered

#### Scenario: Validation runs after full sync
- **WHEN** both topics are loaded from server AND server panels fetch completes
- **THEN** the validation effect SHALL run and filter panels normally

### Requirement: Centralized pane ID classification
A helper function `isKnownPanePrefix(id)` SHALL exist in `paneConfig.ts` that returns true for all structurally-identified pane types (project, browser, terminal, utility, draft, chat, session-viewer, process-log).

#### Scenario: Known prefix identified
- **WHEN** `isKnownPanePrefix("project:foo")` is called
- **THEN** it SHALL return true

#### Scenario: UUID not matched as known prefix
- **WHEN** `isKnownPanePrefix("550e8400-e29b-41d4-a716-446655440000")` is called
- **THEN** it SHALL return false
