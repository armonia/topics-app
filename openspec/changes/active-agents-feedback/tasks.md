# Tasks: active-agents-feedback

Prima i test rossi, poi il codice. Ogni test qui sotto è ROSSO sull'albero di oggi.

## 1. Server (BGVIS-04)
- [x] 1.1 `server/providers/background-probes.test.ts` (nuovo): provider finto
      registrato con `registerProvider` (`server/providers/index.ts:265`), due
      task di cui uno senza `description` → `backgroundStatusRows` porta `tasks`
      e `lastSignalAt`. Rosso: oggi la riga ha solo `topicId`, `sessionKey`, `state`.
- [x] 1.2 Sonda nuova in `ClaudeCodeProvider` accanto a `backgroundState`
      (`claude-code.ts:2786`) che legge `pp.background.tasks` e `lastSignalAt`;
      tipo `BackgroundProbe` e `StreamingStatusRow` estesi
      (`background-probes.ts:12,89`). Route `topics.ts:1160` invariata.

## 2. Stato client (BGVIS-02, BGVIS-03)
- [x] 2.1 `client/src/state/activeAgentRows.test.ts`: caso nuovo, chat in
      background → riga in `background`, non in `working`; archiviata → niente.
- [x] 2.2 `signals.ts`: lavoro in background per topic, scritto dallo stesso
      poll di `useSignalsSync.ts:110-139`, svuotato da `dropBackgroundWork`.
      Hook `useTopicBackgroundWork(topicId)` e `useProjectBackgroundWork(path)`.
      `hydratedStreamTopics` e `liveStreamTopics` non si toccano.
- [x] 2.3 `activeAgentRowsFrom` + gruppo `background`; conteggio
      `working + background` da una sola funzione, letta da
      `IdentityBlock.tsx:189` e dalla coda della riga.

## 3. UI (BGVIS-01, BGVIS-03, BGVIS-04)
- [x] 3.1 `StreamingIndicator.tsx`: stato `background` di `OrbitLoader`/
      `LoaderSlot`, precedenza waiting > working > background in
      `TopicStreamingSpinner` e `ProjectStreamingSpinner`; animazione lenta in
      `index.css` con ramo reduced-motion.
- [x] 3.2 `TopicItem.tsx:511`: il glifo compare anche senza `isStreaming`.
- [x] 3.3 `AgentLines.tsx`: gruppo «In background».
- [x] 3.4 `Chat/BackgroundWorkLine.tsx` (nuovo), montato in `ChatPane.tsx:1848`.
- [x] 3.5 Chiavi in `i18n-it.ts`/`i18n-en.ts` (statusBar) e
      `i18n-chat-it.ts`/`i18n-chat-en.ts` (riga in chat).

## 4. Prova
- [x] 4.1 E2E: nuovo `test.describe` in `tests/e2e/chat-streaming-indicator.spec.ts`
      (video già acceso), `page.route('**/api/topics/streaming')` con una riga
      `background` e 2 task: riga di sidebar con
      `[data-loader-state="background"]`, `[data-testid="background-work-line"]`
      con i 2 nomi, invio non accodato. Contro :13334, mai :3333.
      Scritte (anche `project-folder-loader.spec.ts` per progetto chiuso e tab,
      `profile-menu.spec.ts` per il gruppo e il numero), non girate qui: le fa la CI.
- [x] 4.2 `bun run typecheck` + i test dei moduli toccati; la suite intera la fa la CI.
