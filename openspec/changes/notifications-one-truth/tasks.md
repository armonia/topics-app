# Tasks: notifications-one-truth

- [x] Porta unica del «visto» lato server (`server/subject-seen.ts`): chat aperta, righe cliccate, pannello aperto = segna tutto
- [x] `POST /api/topics/:id/read` e `POST /api/notifications/seen` (ids, upTo, bersaglio topic) passano dalla porta; le righe si spengono anche a non-letto già zero
- [x] Il «segna tutto» azzera ogni chat con non-letti, con o senza riga, tranne quelle con una notifica più nuova della lista letta
- [x] `notification:seen` porta `subjects` / `allExcept`; ogni finestra spegne i segni in memoria (terminale finito, chat done) e i pallini delle sole righe nominate
- [x] Numero globale e campanella contano soggetti (`rollupGlobalAttention`, `paneAttentionTotal`, `countUnseenNotifications`)
- [x] Test unit: `server/subject-seen.test.ts`, `client/src/lib/notify/seenFrame.test.ts`, `attentionTotal.test.ts`, `attention.test.ts`, `notification-log.test.ts`, `topic-read-seen-propagation.test.ts`
- [x] E2E WebKit con video: `tests/e2e/notifications-one-truth.spec.ts`, rosso sul comportamento di origin/main e verde dopo
