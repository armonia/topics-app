# Backlog sweep — palette jump-to-message, Tauri panic firewall, dead code

**Status: ARCHIVED (implemented as approved autonomous sweep, 2026-07-11)**

## Why

Three leftover items from the 2026-07-10/11 audits, plus one live crash
reported mid-sweep ("sta crashando ogni tanto topics").

## What changed

### 1. Palette ⌘K → jump to message (feat)
Clicking a message-search hit now scrolls the opened chat to the exact
message (centered) and flashes a highlight, instead of dumping the user at
the bottom of the thread.
- `searchTranscripts` returns `messageId` for SQLite hits (null for legacy
  JSONL — plain open as before).
- New `client/src/state/scrollToMessage.ts`: pending-target store
  (topicId → messageId, TTL 30s, post-fire grace 2s) + request event.
- `MessageList`: jump effect + retry paths (load-complete / request event /
  scroller ResizeObserver for hidden keep-alive panes). FOUR bottom-anchor
  mechanisms (needsScroll, loadHistory-complete, Virtuoso followOutput on
  0→N replace, appended-message DOM pin) each silently undid the jump —
  all now veto while a target is pending; the fired-grace keeps the target
  alive across the open-triggered reload so the post-load pass re-jumps.

### 2. Tauri SIGABRT panic firewall (fix)
Six identical crash reports (2026-07-10/11, through v2.1.18):
poisoned `window_id` mutex in tauri-runtime-wry + sync command panic
across wry's objc FFI boundary → abort. `no_abort()` catch_unwind firewall
on every dispatcher-touching sync command; global panic hook appends every
panic (any thread) to `~/Library/Logs/Topics-rust-panics.log` to identify
the actual poisoner on next occurrence.

### 3. deleteTopicById dead code (refactor)
Never had a call-site (topic model is archive-only). Removed function,
exclusive `deleteTopic` statement, AppContext field, stale imports.

### 4. E2E baseline follow-up (no code)
The stale suites from the 2026-07-04 baseline memory (layout-fixes,
pane-full-regression, pane-project-reopen) were already removed by the
PR #6 test consolidation. Verified live: layout-edge-cases + pane-undo =
20 passed / 8 flaky (retry-green) / 1 skipped / 0 failed. No real red.

## Verification
- unit: 1964/0 (incl. new scrollToMessage store tests)
- integration: search-messages asserts messageId
- e2e: CMD-16 real end-to-end jump; command-palette + chat-scroll 19/19
- cargo check clean; tsc client+server 0
