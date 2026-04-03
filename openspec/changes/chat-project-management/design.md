# Design: Chat Project Management

## Architecture

Extend the existing command parser in `server/routes/topics.ts` (lines 1108-1191). The current pattern already handles `/pause`, `/resume`, `/agents`, `/assign` — we add `/project` with subcommands.

## Command Parsing

```
/project                    → show current project or list workspace projects
/project create <name>      → create new project + bind to current topic
/project open <name|path>   → bind existing project to current topic
```

### `/project create <name>`

1. Sanitize name (alphanumeric, hyphens, underscores)
2. Target dir: `~/.openclaw/workspace/<name>/`
3. If exists → error
4. `mkdirSync(targetDir, { recursive: true })`
5. Write a minimal `CLAUDE.md` with project name
6. Update topic's `projectPath` → save + broadcast `topic:updated`
7. Respond: "Created project **<name>** at `<path>` and bound to this topic."

### `/project open <name|path>`

1. If arg looks like an absolute path (`/` prefix or `~/`): resolve directly
2. Otherwise: look up by name in `getWorkspaceProjects()` results
3. Verify directory exists → error if not
4. Update topic's `projectPath` → save + broadcast `topic:updated`
5. Respond: "Opened project **<name>** — bound to this topic."

### `/project` (no args)

1. If topic has `projectPath` → show it
2. List workspace projects from `getWorkspaceProjects()`
3. Respond with formatted list

## Client Changes

Add `/project` to the commands array in `ChatInput.tsx` with description "Create or open a project".

## Files Changed

| File | Change |
|------|--------|
| `server/routes/topics.ts` | Add `project` branch in command handler (~40 lines) |
| `client/src/components/Chat/ChatInput.tsx` | Add `/project` to commands list |
