## ADDED Requirements

### Requirement: Auto-reload on client asset changes
The Electron main process SHALL watch the `/public/` directory for file changes and automatically reload all application windows when client assets are rebuilt.

#### Scenario: Main window reloads after client rebuild
- **WHEN** the Vite build completes and writes new assets to `/public/`
- **THEN** the Electron main window reloads within 2 seconds
- **AND** the reloaded page displays the updated client code

#### Scenario: Detached topic windows reload alongside main window
- **WHEN** client assets change in `/public/`
- **AND** one or more detached topic windows are open
- **THEN** all detached topic windows reload simultaneously with the main window
- **AND** each detached window preserves its topic context (URL with topic ID)

#### Scenario: Debounce prevents multiple rapid reloads
- **WHEN** Vite writes multiple files to `/public/` in quick succession (within 500ms)
- **THEN** only one reload is triggered after the writes settle
- **AND** no partial-state reload occurs mid-build

#### Scenario: Browser tab views are not reloaded
- **WHEN** client assets change in `/public/`
- **AND** browser tab BrowserViews are open pointing to external URLs
- **THEN** the BrowserViews SHALL NOT be reloaded
- **AND** only application windows (main + detached) are refreshed

### Requirement: File watcher lifecycle management
The file watcher for `/public/` SHALL be created when the app is ready and cleaned up when the app quits.

#### Scenario: Watcher starts on app ready
- **WHEN** the Electron app emits the `ready` event
- **THEN** a file watcher is registered on the `/public/` directory
- **AND** the watcher is active and listening for changes

#### Scenario: Watcher stops on app quit
- **WHEN** the Electron app is quitting
- **THEN** the file watcher is closed and cleaned up
- **AND** no further reload events are triggered
