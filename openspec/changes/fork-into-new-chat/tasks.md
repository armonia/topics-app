# Tasks: fork-into-new-chat

Prima del codice: `grep -qx 'status: approved' openspec/changes/fork-into-new-chat/.openspec.yaml`.

## 1. Test rossi sul tree di oggi

- [ ] 1.1 `server/providers/claude/args.test.ts` (la barra della card): con
      `forkFrom: { sessionId: P, atUuid: U }` l'argv contiene, in fila,
      `--resume P --resume-session-at U --fork-session --session-id C`, e con
      `forkFrom` nullo non contiene né `--fork-session` né
      `--resume-session-at`. Aggiornare lo snapshot di CCLI-07 nello stesso
      giro. Header `@covers CHAT-FORK-02`. Rosso oggi: `forkFrom` non esiste e
      `--fork-session` compare 0 volte in `server/`.
- [ ] 1.2 `server/providers/codex/args.test.ts`: `buildCodexForkArgs` dà
      `exec fork T --json --skip-git-repo-check`, la sandbox via `-c` e `-`
      come ultimo argomento. `@covers CODEX-02`.
- [ ] 1.3 `server/lib/chat-fork.test.ts` (nuovo, puro): `copyThreadForFork`
      (id nuovi, catena rimappata, `branchIndex` 0, campi invariati, righe
      `partial` escluse), `lastMainAssistantUuid` (salta le righe
      `isSidechain`, nessuna risposta = null, riga finale troncata ignorata),
      e `forkModeFor` di `shared/chat-fork.ts` con la tabella dello scenario.
      `@covers CHAT-FORK-01, CHAT-FORK-03`.
- [ ] 1.4 `server/providers/codex.test.ts`: `resolveCodexInvocation` coi tre
      esiti nuovi (thread del ramo vince, fork con madre ferma, fresco con
      madre cresciuta o assente). `@covers CODEX-02`.
- [ ] 1.5 Spawn del ramo Claude Code, sul modello di
      `server/providers/claude-code-spawn-overrides.test.ts`: transcript del
      ramo assente → argv col fork e senza prologo; presente → `--resume C`;
      rifiuto «No conversation found» → `parent_ref` nullo e spawn dopo con
      `--session-id` e prologo. `@covers CHAT-FORK-02`.
- [ ] 1.6 Rotta, test d'integrazione `tests/integration/chat-fork-route.test.ts`
      contro un database sintetico: copia e originale intatto (confronto riga
      per riga prima e dopo), eredità, riga `partial` esclusa, 409
      `turn_in_progress`, 403 coordinatore, 409 `fork_unsupported`, 400
      `nothing_to_fork`, riga in `claude_code_sessions` con `import_offset`
      nullo. `@covers CHAT-FORK-01, CHAT-FORK-02, CHAT-FORK-03`.
- [ ] 1.7 `tests/e2e/chat-fork-new-chat.spec.ts` (la barra della card) su
      `:13334`, uno scenario per test con
      `test.info().annotations.push({ type: "spec", description: "CHAT-FORK-0N" })`:
      i quattro scenari di CHAT-FORK-04 e i due di CHAT-FORK-05, più «un
      fornitore senza strada» di CHAT-FORK-03. Storia seminata con
      `seedMessage` (`tests/e2e/helpers/seed-messages.ts:67`), come
      `tests/e2e/chat.spec.ts:879-882`; conteggi da `GET /api/history/:sk`.
      Lo stub `claude` del banco (`scripts/start-test-server.sh:94-161`) non
      guarda l'argv: qui si prova la chat, l'argv lo prova 1.1.

## 2. Dati

- [ ] 2.1 Backup di `data/topics.db` e `-wal` PRIMA di creare il file (il
      watcher di produzione applica le migration al database vivo).
- [ ] 2.2 `server/db/migrations/<YYYYMMDDHHMMSS>-chat-forks.sql` con la tabella
      del design §4, riga nel manifest `server/db/migrations-embedded.ts`, test
      che esegue il file su un database sintetico (forma di
      `tests/integration/migration-074-messages-timestamp-index.test.ts`).

## 3. Server (CHAT-FORK-01, CHAT-FORK-03, CHAT-FORK-05)

- [ ] 3.1 `shared/chat-fork.ts`: `forkModeFor`. `server/lib/chat-fork.ts`:
      `copyThreadForFork`, `lastMainAssistantUuid`.
- [ ] 3.2 `server/routes/fork.ts`, montato accanto a `createEditRouter`
      (`server/routes/topics.ts:881`): controlli e transazione del design §1.
- [ ] 3.3 `Topic.forkedFrom` in `shared/types.ts` e nella proiezione dei topic
      (`server/utils.ts:565`).

## 4. Claude Code (CHAT-FORK-02)

- [ ] 4.1 `buildClaudeArgs` con `forkFrom` (`args.ts:374`), commento col perché
      delle tre bandiere e le misure del 28/09.
- [ ] 4.2 Spawn (`claude-code.ts:2427-2512`): `readForkOrigin`, controllo sul
      transcript del ramo, `needsHistoryReplay` falso col fork, `spawnMeta`.
- [ ] 4.3 Recupero in `markMissingSessionRecovery` (`:3318`): azzera
      `parent_ref`, e riconosce il rifiuto delle due bandiere sul solo avvio
      col fork.
- [ ] 4.4 `CRITICAL_CLAUDE_FLAGS` (`cli-compat.ts:80`): `--fork-session` e
      `--resume-session-at`.

## 5. Codex (CODEX-02)

- [ ] 5.1 `buildCodexForkArgs` in `server/providers/codex/args.ts`.
- [ ] 5.2 `resolveCodexInvocation` col ramo e il confronto su `parent_at`;
      `allowResumeFallback` anche sul fork, con l'azzeramento di `parent_ref`.

## 6. Client (CHAT-FORK-04, CHAT-FORK-05)

- [ ] 6.1 `topicsApi.fork` in `client/src/lib/api.ts`.
- [ ] 6.2 `MessageBubble.tsx`: bottone `msg-action-fork` con `GitBranch`, prop
      `onFork`; `MessageList.tsx` la passa alla sola ultima riga finita.
- [ ] 6.3 `ChatPane.tsx`: `forkHere(prompt?)` (design §9), `onFork`, ramo `/fork`
      in `handleSlashCommand`; voce in `slashCommands.ts`.
- [ ] 6.4 `ForkOriginDivider.tsx` e il suo posto in `MessageList`.
- [ ] 6.5 i18n in `client/src/lib/i18n-it.ts` e `i18n-en.ts`:
      `chat.message.fork`, `chat.message.forkAria`,
      `chat.slash.fork.description`, `chat.fork.name`, `chat.fork.divider`,
      `chat.fork.busy`, `chat.fork.unsupported`.

## 7. Verifica

- [ ] 7.1 `bun test` dei file toccati, `bun run typecheck`,
      `bun run check:emdash`, `bun run check:ui-language`,
      `bun run check:spec-coverage`. La suite unit intera e l'E2E li fa la CI.
- [ ] 7.2 Prova sul filo con la CLI vera (lo stub non valida le bandiere),
      scenario «sul filo l'originale non cambia» di CHAT-FORK-02: una chat
      Claude Code su `haiku`, `shasum` del transcript della madre prima e dopo
      un turno nel ramo, e il ramo che risponde su un fatto detto solo nella
      madre. Versione della CLI nel commit.
- [ ] 7.3 Prova video: `E2E_VIDEO=1 npx playwright test tests/e2e/chat-fork-new-chat.spec.ts`,
      il `.webm` di «diramare dalla voce» e di «`/fork` con un testo».
