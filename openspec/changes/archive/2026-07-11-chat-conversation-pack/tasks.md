# Tasks — chat-conversation-pack

> STATO: **implementata e verificata** (2026-07-11). tsc client+server verdi;
> unit 1952/1952 (incl. 5 nuovi integration branch-ops + 3 search); e2e
> chat.spec 20/20 (+1 env-skip) con 2 test nuovi (delete two-click con reload,
> export .md + presenza regenerate).

- [x] Server: `createBranchPartialMessage` alloca next branch index + attiva
  (utils.ts) — prerequisito di regenerate, no-op per il path edit.
- [x] Server: `POST /api/messages/:id/regenerate` (edit.ts) con
  `truncateAfterAnchor` in streamEditResponse; 400 su messaggi user, 404 su
  id ignoti, 409 se già in streaming.
- [x] Server: `DELETE /api/messages/:id` (branches.ts) — CTE ricorsiva,
  renumber denso, riparazione active_branches, thread riparato in risposta.
- [x] Server: `searchTranscripts` interroga la tabella `messages` (utils.ts).
- [x] Client: `chatApi.regenerateMessage`/`deleteMessage`; `useChat` con
  `runBranchStream` condiviso; threading prop lungo App → PanelGrid →
  StandaloneChatGroup/ProjectWindow → ChatPanel → ChatPane → MessageList →
  MessageBubble.
- [x] Client: toolbar — Regenerate (assistant, gated su streaming) + Delete
  (two-click confirm, 3s disarm); "Export conversation" nel menu ⋯ del
  composer (markdown del thread attivo).
- [x] Test: tests/integration/message-branch-ops.test.ts (5),
  tests/integration/search-messages.test.ts (3), chat.spec "Conversation
  pack" (2 e2e).
