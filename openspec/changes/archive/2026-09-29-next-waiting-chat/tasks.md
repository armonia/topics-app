# Tasks: next-waiting-chat

Prima del codice: `grep -qx 'status: approved' openspec/changes/next-waiting-chat/.openspec.yaml`.

## 1. Test rossi sul tree di oggi

- [x] 1.1 `client/src/lib/waitingQueue.test.ts` (bun:test, header `@covers CHAT-WAIT-03`):
      gli scenari puri di CHAT-WAIT-03 su `waitingQueue` (ordine con Fissati,
      figlio di progetto promosso, chat fissata dentro un progetto contata una
      volta, turno finito escluso, terminale incluso) e su `nextWaiting`
      (successiva, giro, fuoco fuori coda, dopo una risposta, `null`). Item costruiti come in
      `client/src/lib/sidebarStateGroups.test.ts`. Rosso oggi: il modulo non esiste.
- [x] 1.2 `client/src/lib/sidebarStateGroups.test.ts`: una chat solo in
      `awaitingInputTopics` e anche in uno stream aperto finisce in `awaiting`
      passando da `sidebarStateSignals` (CHROME-07); aggiungi `CHROME-07` al
      suo `@covers`. Rosso oggi: la funzione non esiste e la vista passa solo
      `awaitingFeedbackTopics`.
- [x] 1.3 `shared/shortcuts.test.ts`: il registro ha `[MOD, 'J']` nel gruppo
      «Chat» con `native.chars` `['j']`, e `renderRustModule()` contiene `"j"`.
- [x] 1.4 `desktop-tauri/src-tauri/src/chords.rs:162-170`: `'j'` nella lista di
      `app_chords_from_the_registry_are_forwarded`. `cargo test --lib` sul PC
      (`tools/pc-offload.md`), non sul Mac. (Qui non girato: lo esegue il job
      Rust di `ci.yml`; la stessa lista generata è provata da `shared/shortcuts.test.ts`.)
- [x] 1.5 `tests/e2e/chat-next-waiting.spec.ts` (nuovo) su `:13334`, uno
      scenario per test con `test.info().annotations.push({ type: "spec", description: "CHAT-WAIT-0N" })`:
      «due chat in attesa e una al lavoro» e «in app, nessun'altra chat ti
      aspetta» (CHAT-WAIT-03, il secondo con
      `page.getByTestId("toast").filter({ hasText: … })` e la tab a fuoco
      invariata) e i due scenari di CHAT-WAIT-04 con viewport da telefono.
      Semina senza finti interni: A con `session:state` `awaiting-approval` via
      `interceptWebSocket`, come `tests/e2e/tab-state-view.spec.ts:130`; B e C con
      `POST /api/test/streams/partial` (`server/routes/e2e.ts:457`), e per B in
      più `seedMessage` (`tests/e2e/helpers/seed-messages.ts:66`) con l'ultima
      riga assistente che porta `mcp__topics__ask_user_question` in
      `waiting_for_input`. Vista per stato da `localStorage['topics-sidebar-state']`
      come `tab-state-view.spec.ts:120-126`; l'ordine atteso si legge dai
      `[data-row-name="chat"]` di `sidebar-state-section-awaiting`. Pulizia con
      `deleteTopic` in `finally`, come `tests/e2e/ripresa-capped-live.spec.ts:88-92`.
- [x] 1.6 `tests/e2e/tab-state-view.spec.ts`: scenario «una domanda dentro l'app
      sta in Attende te» (CHROME-07), con la stessa semina di B.

## 2. Coda e passo (CHAT-WAIT-03)

- [x] 2.1 `client/src/lib/buildSidebarItems.ts`: `sidebarStateSignals(...)` pura,
      con l'unione `awaitingFeedbackTopics ∪ awaitingInputTopics` per le chat.
- [x] 2.2 `client/src/lib/waitingQueue.ts`: `waitingQueue` e `nextWaiting` (design §2-3).
- [x] 2.3 `client/src/state/waitingQueue.ts`: store zustand `{ queue, last }` e
      la costante `NEXT_WAITING_EVENT = 'topics:next-waiting'`.

## 3. Sidebar (CHAT-WAIT-03, CHROME-07)

- [x] 3.1 `TopicTree.tsx:788-799`: la vista per stato passa da
      `sidebarStateSignals`; l'unione nel `useMemo`, non nel selettore.
- [x] 3.2 `TopicTree.tsx`: `waitingQueue` da `allItems` e dai Fissati, scritta
      nello store solo quando cambia; `handleTerminalRowClick`
      (`clearTerminalFinished` + `onTerminalClick`, estratto da `:2376` e
      passato alla riga); ascolto di `NEXT_WAITING_EVENT` che chiama
      `handleChatRowClick` o `handleTerminalRowClick` e aggiorna `last`; avviso con
      `useToast` quando `nextWaiting` dà `null`. Chiavi i18n in `i18n-it.ts` e
      `i18n-en.ts`.

## 4. Tasto (CHAT-WAIT-03)

- [x] 4.1 `shared/shortcuts.ts`: la voce `Mod+J` con la descrizione
      `'Next chat waiting for you'` (il registro è in inglese), poi
      `bun run gen:shortcuts`.
- [x] 4.2 `client/src/hooks/useKeyboardShortcuts.ts`, accanto a ⌘E: il ramo di
      design §4, con il commento del perché niente guardia sul campo di testo e
      del perché si cede sul ramo ctrl.

## 5. Telefono (CHAT-WAIT-04)

- [x] 5.1 `MobileChromeBar.tsx`: casella «In attesa» prima del Profilo, testid
      `mobile-chrome-waiting`, `disabled` a zero; `BottoneFila` riceve
      `disabled` e a zero spegne glifo e testo ma tiene la campitura (design §6,
      MOBILE-CHROME-06); aggiorna il commento di testa («quattro porte») con la
      ragione della quinta.
- [x] 5.2 `App.tsx:1964`: `waitingCount` dallo store e `onNextWaiting` che
      annuncia l'evento.
- [x] 5.3 `tests/e2e/mobile-chrome-bar.spec.ts`, l'elenco completo in design §6:
      i quattro `toBe(4)` (`:230`, `:263`, `:308`, `:466`) passano a cinque; la
      destrutturazione di `:264` diventa primo, ultimo e centrali come
      `:563-565`; titoli e commenti che dicono quattro.

## 6. Verifica

- [x] 6.1 Verdi: i bun:test del §1 e dei moduli toccati, `bun run typecheck`,
      `bun run lint`, `bun run check:spec-coverage`, `bun run check:emdash`.
- [x] 6.2 E2E del §1 sulla CI; prova video con
      `E2E_VIDEO=1 npx playwright test tests/e2e/chat-next-waiting.spec.ts`
      (il `.webm` delle tre pressioni e della porta sul telefono).
