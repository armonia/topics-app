## Purpose

Add a Claude Code CLI provider to Topics, enabling topics to use Claude Code as their AI backend instead of direct Anthropic SDK or OpenClaw Gateway. This gives topics access to Claude Code's native tool ecosystem (Read, Edit, Write, Bash, Grep, Glob, Agent, MCP servers), permission model, and conversation resume.

## Background

- Topics has a clean `AIProvider` interface (`server/providers/types.ts`) with two implementations: `ClaudeProvider` (Anthropic SDK) and `OpenClawProvider` (gateway WebSocket)
- The Jarvis router already spawns Claude Code CLI processes with persistent process pools, NDJSON streaming, and session management (`router/src/services/claude.ts`)
- Claude Code CLI supports `--input-format stream-json --output-format stream-json` for bidirectional NDJSON over stdin/stdout
- Topics frontend already renders tool calls (tool_start, tool_update, tool_result stream events) via `MessageBubble` and `MessageContent` components

## Requirements

### Requirement: CCPROV-01 -- Provider Lifecycle

The system SHALL manage Claude Code CLI processes with automatic lifecycle management per topic session.

#### Scenario: Provider initializes and reports ready

- **GIVEN** CLAUDE_CODE_ENABLED=true is set in environment
- **WHEN** initProviders() runs at server startup
- **THEN** a "claude-code" provider is registered in the provider registry
- **AND** the provider reports connected=true
- **AND** the provider capabilities include "streaming", "tools", "sessions", and "abort"

#### Scenario: Process spawns on first message to a topic

- **GIVEN** the claude-code provider is registered and no process exists for session key "topic-abc"
- **WHEN** sendChat is called with sessionKey "topic-abc"
- **THEN** a new Claude Code CLI process spawns with --input-format stream-json --output-format stream-json
- **AND** the process cwd is set to the topic's project path (or a default workspace)
- **AND** the process uses --permission-mode bypassPermissions
- **AND** the process uses --setting-sources user,project,local

#### Scenario: Process reuse on subsequent messages

- **GIVEN** a Claude Code process is alive for session key "topic-abc"
- **WHEN** sendChat is called again with sessionKey "topic-abc"
- **THEN** the existing process is reused (no new spawn)
- **AND** the message is written to the process stdin as NDJSON

#### Scenario: Inactivity timeout kills idle process

- **GIVEN** a Claude Code process is alive for session key "topic-abc"
- **WHEN** no messages are sent for 15 minutes
- **THEN** the process is killed with SIGTERM
- **AND** the process is removed from the pool
- **AND** a subsequent sendChat spawns a fresh process

#### Scenario: Max lifetime kills long-running process

- **GIVEN** a Claude Code process has been alive for 2 hours
- **WHEN** the lifetime timer fires
- **THEN** the process is killed regardless of activity
- **AND** a subsequent sendChat spawns a fresh process

#### Scenario: Provider stop kills all processes

- **GIVEN** multiple Claude Code processes are alive
- **WHEN** provider.stop() is called (server shutdown)
- **THEN** all processes are killed with SIGTERM then SIGKILL after 3s
- **AND** the process pool is cleared

### Requirement: CCPROV-02 -- Streaming Chat

The system SHALL stream Claude Code responses back through the StreamHandler callback interface.

#### Scenario: Text response streams as text deltas

- **GIVEN** a Claude Code process is running for session "topic-abc"
- **WHEN** the user sends a text message
- **THEN** text content from assistant NDJSON events fires onTextDelta callbacks
- **AND** the cumulative fullText is tracked correctly
- **AND** onDone fires when the result event arrives

#### Scenario: Tool use events map to tool callbacks

- **GIVEN** Claude Code executes a tool (e.g., Read, Bash, Edit)
- **WHEN** an assistant NDJSON event contains a tool_use content block
- **THEN** onToolStart fires with the tool name, id, and arguments
- **AND** onToolResult fires when the tool_result event arrives

#### Scenario: Error propagates to handler

- **GIVEN** the Claude Code process encounters an error
- **WHEN** the process exits with non-zero code or stderr indicates failure
- **THEN** onError fires with a descriptive error message

#### Scenario: Messages are serialized per session

- **GIVEN** two messages are sent rapidly to the same session
- **WHEN** both sendChat calls are in flight
- **THEN** the second message waits for the first to complete before being sent to stdin
- **AND** responses are never interleaved

### Requirement: CCPROV-03 -- Non-Streaming Completion

The system SHALL support non-streaming completions for utility calls (auto-naming, digests).

#### Scenario: Complete returns text result

- **GIVEN** the claude-code provider is registered
- **WHEN** complete() is called with a messages array
- **THEN** a fresh Claude Code CLI process spawns with --output-format json (not stream-json)
- **AND** the prompt is written to stdin and stdin is closed
- **AND** the result text is extracted from the JSON output
- **AND** the process exits after completion

### Requirement: CCPROV-04 -- Abort

The system SHALL support aborting in-progress streams.

#### Scenario: Abort kills the pending message but not the process

- **GIVEN** a streaming response is in progress for session "topic-abc"
- **WHEN** abort() is called for that session
- **THEN** SIGINT is sent to the process to cancel the current turn
- **AND** onAborted fires on the stream handler
- **AND** the process remains alive for future messages

### Requirement: CCPROV-05 -- Configuration

The system SHALL be configurable via environment variables and per-topic settings.

#### Scenario: Environment-based configuration

- **GIVEN** CLAUDE_CODE_ENABLED=true is set
- **WHEN** initProviders() runs
- **THEN** the provider initializes with defaults:
  - model: claude-sonnet-4-6 (or CLAUDE_CODE_MODEL env override)
  - permission mode: bypassPermissions
  - default workspace: user home directory

#### Scenario: Per-topic workspace override

- **GIVEN** a topic has a projectPath configured
- **WHEN** sendChat is called for that topic
- **THEN** the Claude Code process spawns with cwd set to projectPath

### Requirement: CCPROV-06 -- Process Resilience

The system SHALL handle process crashes and rate limits gracefully.

#### Scenario: Process crash triggers respawn on next message

- **GIVEN** a Claude Code process crashes unexpectedly
- **WHEN** the next sendChat is called for that session
- **THEN** the dead process is cleaned up
- **AND** a new process spawns automatically
- **AND** the message is sent to the new process

#### Scenario: Rate limit detected from stderr

- **GIVEN** a Claude Code process writes rate limit errors to stderr
- **WHEN** the rate limit pattern is detected
- **THEN** the pending message rejects with a rate limit error after 10s grace period
- **AND** the caller can retry or fall back

#### Scenario: Message timeout after 30 minutes

- **GIVEN** a message has been pending for 30 minutes with no result
- **WHEN** the timeout fires
- **THEN** the pending promise rejects with a timeout error
- **AND** the process is NOT killed (it may still be working)
