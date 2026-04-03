## ADDED Requirements

### Requirement: Electron-first production startup
The production deployment SHALL launch Electron as the primary application surface, with the Bun server running as a companion process.

#### Scenario: Production script starts server then launches Electron
- **WHEN** the production startup script executes
- **THEN** it starts the Bun server process in the background
- **AND** waits for the server to be reachable on port 3333
- **AND** launches Electron after the server is confirmed ready

#### Scenario: Server health check with timeout
- **WHEN** the startup script waits for the server
- **AND** the server does not respond within 30 seconds
- **THEN** the script logs an error and exits with a non-zero code
- **AND** Electron is NOT launched

#### Scenario: Electron loads from production server
- **WHEN** Electron starts without `DEV_URL` environment variable
- **THEN** Electron loads the main window from `http://localhost:3333`
- **AND** all application features are functional (sidebar, chat, layout)

### Requirement: Production LaunchAgent configuration
The macOS LaunchAgent SHALL be configured to run the Electron-first production startup.

#### Scenario: LaunchAgent starts on user login
- **WHEN** the user logs into macOS
- **THEN** the LaunchAgent starts the production startup script
- **AND** Electron appears as a running desktop application

#### Scenario: LaunchAgent restarts on crash
- **WHEN** the Electron process or server crashes
- **THEN** the LaunchAgent restarts the startup script (KeepAlive)
- **AND** the server health check runs again before Electron launches

### Requirement: Production Electron packaging
The Electron app SHALL be buildable as a standalone macOS `.app` bundle for production use.

#### Scenario: electron-builder produces production app
- **WHEN** `npm run build` is executed in `electron-app/`
- **THEN** a `.app` bundle is produced in `electron-app/dist/`
- **AND** the bundle includes `main.js` and `preload.js`
- **AND** the app connects to `localhost:3333` when launched

#### Scenario: Packaged app works without DEV_URL
- **WHEN** the packaged `.app` is launched without any environment variables
- **THEN** it defaults to connecting to `http://localhost:3333`
- **AND** all IPC handlers, system tray, and CDP ports function correctly
