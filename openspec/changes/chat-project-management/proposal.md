# Chat Project Management

## What
Add slash commands to create and open projects directly from chat:
- `/project create <name>` — scaffolds a new project directory in `~/.openclaw/workspace/` and binds it to the current topic
- `/project open <path-or-name>` — binds an existing project to the current topic (by name from workspace or full path)
- `/project` (no args) — shows the current topic's bound project, or lists available workspace projects

## Why
Currently, binding a project to a topic requires navigating to topic settings or relying on auto-detection from messages. Users should be able to manage project associations directly from the chat flow without context-switching to the UI — especially when creating a new workspace project from scratch.

## Scope
- Server: extend the existing `/` command handler in `topics.ts`
- Client: add `/project` to the slash command menu in `ChatInput.tsx`
- No new dependencies, no database schema changes
- Project creation = `mkdir` + optional `CLAUDE.md` stub — nothing more
