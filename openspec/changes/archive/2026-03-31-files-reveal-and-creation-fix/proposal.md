## Why

The Files panel has two usability gaps: (1) there's no way to reveal a file/folder in macOS Finder from the context menu — users must copy the path and navigate manually, and (2) the "New File" / "New Folder" buttons in the panel header and sidebar toolbar are broken — clicking them does nothing because the root project path is never rendered as a TreeNode, so the inline input never appears.

## What Changes

- Add a **"Show in Finder"** option to the file/folder right-click context menu that reveals the item in macOS Finder
- Add a server endpoint `POST /api/files/reveal` that executes `open -R <path>` on macOS
- Add a `filesApi.reveal(path)` client API method
- **Fix root-level file/folder creation** — render the InlineInput at the tree root when `newItemParent === projectPath`, since no TreeNode exists for the root directory itself

## Capabilities

### New Capabilities

_(none — this extends the existing `files` capability)_

### Modified Capabilities

- `files`: Adding "Show in Finder" context menu action and fixing root-level file/folder creation from header buttons

## Impact

- **Server**: New route in `server/routes/files.ts` — `POST /api/files/reveal`
- **Client API**: New method in `client/src/lib/api.ts` — `filesApi.reveal()`
- **FileExplorer component**: Context menu gets new item; tree rendering adds root-level InlineInput
- **No breaking changes** — purely additive + bug fix
