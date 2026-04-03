## Why

Production currently runs as a LaunchAgent (`com.armonia.topics-prod`) serving the web app on port 3333 with `fswatch` for client rebuilds and `bun --watch` for server restarts. The Electron app exists but is only used in dev mode — production users load `localhost:3333` in a browser or manually launch Electron pointing at it. When client assets rebuild, there's no automatic reload — users must manually refresh. This means production misses Electron-specific features (system tray, native menus, multi-window topic detach, CDP control) and the update experience is jarring.

## What Changes

- **Auto-reload in production Electron**: When `fswatch` triggers a client rebuild, the Electron main process detects the change and reloads all windows (main + detached) automatically — no manual refresh needed.
- **Electron-first production LaunchAgent**: Replace the browser-first LaunchAgent with one that launches Electron directly, which in turn ensures the server is running. Electron becomes the primary production surface.
- **Production Electron packaging**: Update `electron-builder` config and build scripts so the packaged `.app` bundle can run in production mode (connecting to the local server, not requiring `DEV_URL`).
- **Multi-window reliability in production**: Ensure detached topic windows and browser tabs panel work correctly when Electron loads from the production server (port 3333) rather than Vite dev server.

## Capabilities

### New Capabilities
- `electron-prod-reload`: Auto-reload mechanism for production Electron — watches `/public/` for asset changes and triggers window reload across all windows (main + detached).
- `electron-prod-launch`: Production LaunchAgent and startup flow that boots Electron as the primary app, managing server lifecycle internally or alongside it.

### Modified Capabilities
- `layout`: Multi-window features (topic detach, browser tabs) must work reliably in production Electron, not just dev mode.

## Impact

- **electron-app/main.js**: Add file watcher for `/public/`, reload logic, production server management.
- **electron-app/package.json**: Update build config for production packaging.
- **scripts/start-prod.sh**: Adapt to work with Electron-first flow (server-only, no browser assumption).
- **LaunchAgent plist**: Update to launch Electron instead of bare server.
- **client/src/components/Layout/**: Verify multi-window IPC works in production context.
