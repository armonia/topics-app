# Topics Electron App

Standalone Electron app with integrated browser panel controllable via CDP.

## Features

- **Split view**: Topics chat on left, browser panel on right
- **Multiple browser tabs**: Create, close, switch between tabs
- **CDP remote debugging**: OpenClaw can control the browser via CDP on port 19222
- **Tray icon**: App runs in menu bar
- **IPC API**: Topics web app can control browser via `window.electronAPI`

## Running

```bash
# Install dependencies (first time)
npm install

# Start the app
npm start

# Or for development
npm run dev
```

## OpenClaw Integration

The browser profile "topics" is already configured in OpenClaw:

```json
{
  "browser": {
    "profiles": {
      "topics": {
        "cdpUrl": "http://127.0.0.1:19222"
      }
    },
    "defaultProfile": "topics"
  }
}
```

### Using from OpenClaw

```bash
# List browser tabs
openclaw browser --profile=topics tabs

# Take a snapshot
openclaw browser --profile=topics snapshot

# Navigate
openclaw browser --profile=topics open https://example.com
```

### Using from Chat

Since "topics" is the default profile, you can just ask:
- "Open google.com in the browser"
- "Take a screenshot of the browser"
- "Navigate to github.com"

## IPC API (from Topics web app)

The following APIs are available via `window.electronAPI`:

### Tab Management
- `browser.createTab(url?)` - Create a new tab
- `browser.closeTab(id?)` - Close a tab (or active tab)
- `browser.listTabs()` - List all tabs
- `browser.activateTab(id)` - Switch to a tab

### Panel Control
- `browser.show()` - Show browser panel
- `browser.hide()` - Hide browser panel
- `browser.toggle()` - Toggle panel visibility
- `browser.isVisible()` - Check if panel is visible
- `browser.setWidth(ratio)` - Set panel width (0.2-0.8)

### Navigation
- `browser.navigate(url)` - Navigate active tab
- `browser.back()` - Go back
- `browser.forward()` - Go forward
- `browser.reload()` - Reload page
- `browser.getUrl()` - Get current URL
- `browser.getTitle()` - Get page title
- `browser.canGoBack()` - Check if can go back
- `browser.canGoForward()` - Check if can go forward

### Advanced
- `browser.executeJs(code)` - Execute JavaScript in page
- `browser.screenshot(tabId?)` - Take screenshot (returns base64 PNG)

### Events
- `onBrowserEvent(callback)` - Listen for browser events
- `removeBrowserEventListener()` - Remove event listener

Events include:
- `tab-navigated` - Tab URL changed
- `tab-title-updated` - Tab title changed

## CDP Endpoints

When the app is running, the following CDP endpoints are available:

- `GET http://127.0.0.1:19222/json/list` - List all targets
- `GET http://127.0.0.1:19222/json/version` - Version info

Each target has a `webSocketDebuggerUrl` for direct CDP control.

## Building

```bash
npm run build
```

This creates a `.dmg` file in the `dist/` folder.

## Testing CDP

```bash
node test-cdp.mjs
```

This script tests the CDP connection and lists available targets.
