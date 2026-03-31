## 1. Reveal in Finder — Server

- [x] 1.1 Add `POST /api/files/reveal` endpoint in `server/routes/files.ts` — validate path is within project dir, run `open -R <path>` via `Bun.spawn`, return `{ ok: true }`

## 2. Reveal in Finder — Client

- [x] 2.1 Add `filesApi.reveal(path)` method in `client/src/lib/api.ts`
- [x] 2.2 Add "Show in Finder" option to the context menu in `FileExplorer.tsx` — place it after "Copy Relative Path", call `filesApi.reveal()` on click, works for both files and directories

## 3. Fix Root-Level File/Folder Creation

- [x] 3.1 In `FileExplorer.tsx` compact rendering path (~line 1084): add InlineInput before `files.map()` when `newItemParent === projectPath`
- [x] 3.2 In `FileExplorer.tsx` non-compact rendering path (~line 1110): add InlineInput before `files.map()` when `newItemParent === projectPath`

## 4. Verify

- [x] 4.1 Manual test: right-click a file → "Show in Finder" → Finder opens with file selected
- [x] 4.2 Manual test: click header "New File" button → inline input appears at tree root → type name → file created
- [x] 4.3 Manual test: click header "New Folder" button → inline input appears at tree root → type name → folder created
