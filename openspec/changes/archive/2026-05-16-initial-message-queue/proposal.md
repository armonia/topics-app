# Initial Message Queue (Phase C)

## Why

Today the user creates a topic, the modal closes, the chat opens, and *only then* can the user start typing. For agent-bound topics the wait is worse: the worktree creation, branch checkout, and provider warm-up all happen before the prompt input is even responsive. The reference desktop client we studied solves this with an **Initial Message** that's queued at create time and automatically dispatched the moment the agent connects. The user types their first prompt *before* the spinner of dread.

This change adds the persistence side of that feature. The server stores a one-shot `initial_message` on the topic; the client consumes it on first session open and clears it. UI plumbing for the auto-dispatch behaviour is intentionally deferred (renderer-side change), but the data path lands here so callers can write to it from day one.

## What Changes

- **Migration 019** — `ALTER TABLE topics ADD COLUMN initial_message TEXT` (nullable, default NULL). Additive only.
- **`POST /api/topics`** — accepts an optional `initialMessage: string` field (≤ 8000 chars, control-char strip). Stored on the new column.
- **`PATCH /api/topics/:id`** — accepts `initialMessage` updates. Pass `null` to clear.
- **`GET /api/topics` / `:id`** — returns `initialMessage` when set; absent otherwise (existing rows are NULL).
- **Server type + helpers** — `Topic.initialMessage?: string | null` mirrors server-side; persistence runs through the existing `saveSingleTopic` path.
- **Client type** — `Topic.initialMessage?: string | null` and `CreateTopicRequest.initialMessage?: string` so consumers are statically discoverable.
- **NewTopicModal** — gains a small `Initial message` textarea below the worktree picker; persisted at create time.

## Capabilities

### Modified Capabilities

- `topics` — gains the optional one-shot `initialMessage` field plumbed through create/update/read.

## Impact

Server: 1 new migration + 1 column on `topics` + 5 lines per route handler.
Client: 1 column in `Topic` + a textarea + a submit-time field on `CreateTopicRequest`.
Tests: 1 integration case (round-trip via REST).

**Out of scope (deferred):**
- Auto-dispatch on first session open. The client read-and-clear handler is a follow-on. The data path landing here means we can ship the UX in Phase C+1 without another schema migration.
- Long-form attachments / structured initial-message content. This phase only handles plain text.

**Backward-compat:**
- Existing topics have `initial_message = NULL` and behave identically.
- The new column is invisible to legacy clients (REST returns it only when set).
