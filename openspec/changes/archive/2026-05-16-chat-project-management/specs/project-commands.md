# Spec: Chat Project Commands

## AC-1: Create a new project from chat

**GIVEN** a topic with no project bound
**WHEN** the user types `/project create my-new-app`
**THEN** a directory `~/.openclaw/workspace/my-new-app/` is created with a `CLAUDE.md` file
**AND** the topic's `projectPath` is set to that directory
**AND** the chat shows "Created project **my-new-app** at `/Users/.../.openclaw/workspace/my-new-app` and bound to this topic."
**AND** the sidebar reflects the project binding (project icon or indicator)

## AC-2: Create project — name already exists

**GIVEN** a directory `~/.openclaw/workspace/existing-project/` already exists
**WHEN** the user types `/project create existing-project`
**THEN** the chat shows an error: "Project **existing-project** already exists at `<path>`. Use `/project open existing-project` to bind it."
**AND** no directory is created or modified

## AC-3: Open an existing project by name

**GIVEN** `~/.openclaw/workspace/topics-app/` exists (has project markers)
**WHEN** the user types `/project open topics-app`
**THEN** the topic's `projectPath` is set to `~/.openclaw/workspace/topics-app/`
**AND** the chat shows "Opened project **topics-app** — bound to this topic."

## AC-4: Open an existing project by full path

**GIVEN** `/Users/user/code/my-project/` exists
**WHEN** the user types `/project open /Users/user/code/my-project`
**THEN** the topic's `projectPath` is set to that path
**AND** the chat shows confirmation

## AC-5: Open project — path not found

**GIVEN** no directory at `/nonexistent/path`
**WHEN** the user types `/project open /nonexistent/path`
**THEN** the chat shows an error: "Directory not found: `/nonexistent/path`"
**AND** topic's `projectPath` is unchanged

## AC-6: Show current project and list available

**GIVEN** the current topic has `projectPath` set to `~/.openclaw/workspace/my-app/`
**AND** the workspace contains projects: `my-app`, `other-project`
**WHEN** the user types `/project`
**THEN** the chat shows the current project and a list of available workspace projects

## AC-7: Slash command autocomplete

**GIVEN** the user is typing in the chat input
**WHEN** they type `/pro`
**THEN** the autocomplete menu shows `/project — Create or open a project`
