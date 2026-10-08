# Tasks: chat-strips-in-transcript

Lo stato di una traccia lo danno git e i test, non le caselle.

1. **Il log nella riga.** `SubAgentsStrip`: ogni riga comando è un accordion con sopra di sé la
   coda della card (`ProcessTail`, `LiveShellTail`, `useLaunchedProcess`), uno alla volta; una
   riga finita col log aperto resta finché non lo chiudi, Ferma lo chiude. La card di
   `run_command`/`run_script` mostra la stessa coda. Barra: `SubAgentsStrip.test.tsx`, scenario 2.
2. **Via il salto alla card.** Tolti `revealToolCall`, il fuoco `reveal`, il suo effetto in
   `ToolCallRow` e `findLaunchCard`; `liveWorkCard.ts` diventa `launchedProcess.ts`. Barra:
   `check:deadcode`, `launchedProcess.test.ts`, la mutazione dello scenario 2.
3. **Le strisce in fondo al trascritto.** Footer di Virtuoso stabile con le strisce di `ChatPane`
   (fuori dal blocco del composer, salvo chat vuota); la fascia di atterraggio sulla riga
   (`ToolCallRow`, scroll-margin); i toggle
   delle strisce tengono la vista (`useDisclosureToggle`). Barra: scenario 1, `chat-changed-files`,
   `chat-accordion-no-shift` (le strisce: solo il caso in fondo).
4. **E2E, video e mutazione.** `tests/e2e/chat-strips-in-transcript.spec.ts`, spec aggiornate di
   proposito (`chat-command-visible`, `chat-running-server`, `chat-live-work`,
   `chat-changed-files`, `chat-accordion-no-shift`).
   Dipende da 1-3.
5. **Spec.** `openspec/specs/chat/spec.md`: SUBSTRIP-02, CHAT-END-01; CHAT-FOLD-01, TODO-01,
   CHAT-CHANGES-01, CHGSET-03 e BGVIS-07 riscritti dove dicevano «sopra il composer».
6. **Dal vivo.** `bun run build:client`, poi la chat Prince of Persia in sola lettura (WebKit
   headless): le strisce in fondo, una riga comando apre il suo log.
