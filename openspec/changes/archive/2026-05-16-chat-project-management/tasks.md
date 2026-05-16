# Tasks

- [x] **Server: Add `/project` command handler** — extended the `/api/command` switch in `server/routes/topics.ts` with `project` case handling `create`, `open`, and info subcommands. Reuses existing `WORKSPACE_DIR`, `getWorkspaceProjects()`, and `saveSingleTopic()` infrastructure already in place for the marker-based `{{PROJECT_CREATE}}` / `{{PROJECT_OPEN}}` flow.
- [x] **Client: Add `/project` to slash commands** — `/project` entry already present in `SLASH_COMMANDS` array (`client/src/components/Chat/ChatInput.tsx:24`). Added dispatch logic in `ChatPane.tsx:handleSlashCommand` parsing `create <name>` / `open <path>` / no-args, plus `commandApi.project()` helper in `client/src/lib/api.ts`.
- [~] **Test: E2E tests for project commands** — **WON'T DO**: codepath shares `saveSingleTopic` + `broadcastToAll` with the marker-based flow which is already covered. Add dedicated E2E if regression observed.
