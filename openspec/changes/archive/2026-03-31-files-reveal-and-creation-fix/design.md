## Context

The Files panel (`FileExplorer.tsx`) provides a file tree with context menu, inline creation, and file operations. Two issues exist:

1. **No "Reveal in Finder"**: The context menu has Copy Path / Copy Relative Path but no OS-native file reveal. Users must manually navigate Finder.
2. **Broken root-level creation**: Header buttons call `handleHoverNewFile(projectPath)` which sets `newItemParent = projectPath`. But the tree renders `files.map(node => <TreeNode>)` — the root `projectPath` is never a TreeNode, so `showNewItemInput` (line 136: `isDir && isExpanded && newItemParent === node.path`) never matches, and the InlineInput never appears.

## Goals / Non-Goals

**Goals:**
- Add "Show in Finder" to the file/folder context menu
- Fix file/folder creation from the Files panel header buttons and sidebar toolbar buttons

**Non-Goals:**
- Cross-platform support (Linux `xdg-open`, Windows `explorer`) — macOS only for now
- Electron-specific IPC — use server HTTP endpoint so it works in browser too

## Decisions

### 1. Server endpoint for Reveal in Finder

Use `POST /api/files/reveal` with body `{ path: string }`. Server runs `open -R <absolutePath>` via `Bun.spawn`. This works whether the client is Electron or a browser.

**Alternative considered**: Electron `shell.showItemInFolder()` via IPC — rejected because it wouldn't work when accessing via browser, and the server already handles all file operations.

### 2. Root-level InlineInput rendering

Add InlineInput directly in the tree container (before `files.map(...)`) when `newItemParent === projectPath`. This mirrors what TreeNode does for subdirectories but at the root level where no TreeNode exists.

Both the `compact` and non-compact rendering paths need this fix (lines ~1084 and ~1110).

**Alternative considered**: Wrapping all files in a synthetic root TreeNode — rejected because it would change the tree structure and visual hierarchy.

## Risks / Trade-offs

- **macOS only**: `open -R` is macOS-specific. If the app needs Linux/Windows support later, the endpoint will need platform detection. → Acceptable since the app currently targets macOS (Electron + LaunchAgent).
- **Path traversal**: The reveal endpoint must validate that the path is within the project directory. → Mitigated by reusing the same path validation pattern as other file endpoints.
