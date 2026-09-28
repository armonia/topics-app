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
      `partial` escluse), il punto del ramo (salta le righe col marchio della
      macchina, `hasMachineMark`), `lastMainAssistant` (uuid e testo, salta le
      righe `isSidechain`, nessuna risposta = null, riga finale troncata
      ignorata), `cliForkBlocker` (le tre regole del design §2, e `null` sul
      caso pulito), e `forkModeFor` di `shared/chat-fork.ts` con la tabella
      dello scenario, `direct-x` compreso. `@covers CHAT-FORK-01, CHAT-FORK-02,
      CHAT-FORK-03`.
- [ ] 1.4 `server/providers/codex.test.ts`: `resolveCodexInvocation` coi tre
      esiti nuovi (thread del ramo vince, fork con madre ferma, fresco con
      madre cresciuta o assente), e fresco con `parent_ref` nullo anche a
      madre ferma e thread del ramo sparito (il fork consumato). Più
      l'azzeramento di `parent_ref` all'arrivo di `thread.started` su un turno
      `fork`, e non su un `resume`. `@covers CODEX-02`.
- [ ] 1.5 Spawn del ramo Claude Code, sul modello di
      `server/providers/claude-code-spawn-overrides.test.ts`: sessione uguale
      a `branch_ref` e transcript del ramo assente → argv col fork e senza
      prologo; presente → `--resume C`; sessione dimenticata con
      `resetSession` (il `/clear`), con `forgetBoundSessions` (il reap) o dal
      recupero → uuid nuovo, `--session-id`, niente `--fork-session`;
      rifiuto «No conversation found» e rifiuto «No message found with
      message.uuid of: U» sull'avvio col fork → recupero, non crash, e spawn
      dopo con `--session-id` e prologo. `@covers CHAT-FORK-02`.
- [ ] 1.6 Rotta, test d'integrazione `tests/integration/chat-fork-route.test.ts`
      contro un database sintetico: copia e originale intatto (confronto riga
      per riga prima e dopo), eredità, riga `partial` esclusa, 409
      `turn_in_progress`, 403 coordinatore, 409 `fork_unsupported`, 400
      `nothing_to_fork`, avviso di background in coda che non diventa il
      punto; per `claude-cli` riga in `claude_code_sessions` con
      `import_offset` nullo e `branch_ref` uguale solo con `parent_ref`
      valorizzato, e nessuna riga con la madre senza sessione, con Rigenera
      sul ramo attivo e con una riga `partial` in coda; `/clear` sul ramo che
      azzera `parent_ref`. `@covers CHAT-FORK-01, CHAT-FORK-02,
      CHAT-FORK-03`.
- [ ] 1.7 `tests/e2e/chat-fork-new-chat.spec.ts` (la barra della card) su
      `:13334`, uno scenario per test con
      `test.info().annotations.push({ type: "spec", description: "CHAT-FORK-0N" })`:
      i cinque scenari di CHAT-FORK-04 (l'avviso di background si semina con
      `blocks`) e i due di CHAT-FORK-05, più «un
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
      `copyThreadForFork`, il punto del ramo, `lastMainAssistant`,
      `cliForkBlocker`.
- [ ] 3.2 `server/routes/fork.ts`, montato accanto a `createEditRouter`
      (`server/routes/topics.ts:881`): controlli e transazione del design §1,
      con `parent_ref` nullo quando `cliForkBlocker` dà un motivo (nel log).
- [ ] 3.3 `Topic.forkedFrom` in `shared/types.ts` e nella proiezione dei topic
      (`server/utils.ts:565`).
- [ ] 3.4 `/clear` (`server/routes/topics.ts:2909-2926`): azzera `parent_ref`
      e `parent_at` del ramo in `chat_forks`, accanto a `clearActionFor`.

## 4. Claude Code (CHAT-FORK-02)

- [ ] 4.1 `buildClaudeArgs` con `forkFrom` (`args.ts:374`), commento col perché
      delle tre bandiere e le misure del 28/09.
- [ ] 4.2 Spawn (`claude-code.ts:2427-2512`): `readForkOrigin`, confronto
      con `branch_ref`, controllo sul transcript del ramo, `spawnMeta`.
- [ ] 4.3 Recupero sul solo avvio col fork: `markMissingSessionRecovery`
      (`:3318`) scatta anche su `/no message found with message\.uuid/i` e
      sul rifiuto delle due bandiere. Nessuna scrittura in `chat_forks`: la
      sessione dimenticata basta.
- [ ] 4.4 `CRITICAL_CLAUDE_FLAGS` (`cli-compat.ts:80`): `--fork-session` e
      `--resume-session-at`.

## 5. Codex (CODEX-02)

- [ ] 5.1 `buildCodexForkArgs` in `server/providers/codex/args.ts`.
- [ ] 5.2 `resolveCodexInvocation` col ramo e il confronto su `parent_at`;
      `parent_ref` azzerato al `thread.started` di un turno `fork`;
      `allowResumeFallback` anche sul fork, con l'azzeramento di `parent_ref`.

## 6. Client (CHAT-FORK-04, CHAT-FORK-05)

- [ ] 6.1 `topicsApi.fork` in `client/src/lib/api.ts`.
- [ ] 6.2 `MessageBubble.tsx`: bottone `msg-action-fork` con `GitBranch`, prop
      `onFork`; `MessageList.tsx` la passa solo dove `isLastAssistant` è vero
      e la riga non è `partial` né della macchina (design §9).
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
