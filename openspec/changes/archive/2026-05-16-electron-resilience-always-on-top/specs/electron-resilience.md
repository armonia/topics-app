# Electron Resilience & Always-on-Top

## AC-1: App restarts after crash
```
GIVEN the Topics Electron app is running
WHEN an uncaught exception or unhandled rejection occurs
THEN the app calls app.relaunch() and restarts automatically
AND the tray icon reappears within 3 seconds
```

## AC-2: LaunchAgent keeps app alive
```
GIVEN the Topics Electron LaunchAgent is loaded
WHEN the Electron process is killed (kill, force-quit, OOM)
THEN launchd restarts the process automatically via KeepAlive
AND the app is running again within 10 seconds
```

## AC-3: Always-on-top via tray menu
```
GIVEN the app is running with the tray visible
WHEN the user clicks "Always on Top" in the tray menu
THEN the main window is set to alwaysOnTop with 'floating' level
AND the tray menu checkbox reflects the current state
AND clicking again disables always-on-top
```

## AC-4: Always-on-top via keyboard shortcut
```
GIVEN the app is running
WHEN the user presses Cmd+Shift+T
THEN always-on-top is toggled on/off
AND the tray menu checkbox updates to match
```

## AC-5: Always-on-top state persists
```
GIVEN the user has enabled always-on-top
WHEN the app is restarted
THEN the window opens with always-on-top enabled
AND the tray menu checkbox shows checked
```

## AC-6: App hides to tray on close (existing — verify)
```
GIVEN the main window is visible
WHEN the user clicks the close button (⌘W or red button)
THEN the window hides instead of quitting
AND the tray icon remains
AND clicking the tray icon shows the window again
```
