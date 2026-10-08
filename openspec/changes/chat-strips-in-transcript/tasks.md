# Tasks: chat-strips-in-transcript

Lo stato di una traccia lo danno git e i test, non le caselle.

1. **La card di un comando.** `liveWorkCard.ts` trova la tool call che ha lanciato una riga
   (processId nella risposta; comando e ora di avvio sulla storia). Barra: `liveWorkCard.test.ts`.
2. **Aprire una tool call da fuori.** `revealToolCall` (fuoco della ricerca marcato `reveal`, salto
   al messaggio se la riga non è disegnata); la riga si porta in vista da sé (`ToolCallRow`); la
   card di `run_command`/`run_script` mostra il log dal vivo (`LiveShellTail`,
   `useLaunchedProcess`). Barra: `SubAgentsStrip.test.tsx`, scenario 2. Dipende da 1.
3. **Le strisce in fondo al trascritto.** Footer di Virtuoso stabile con le strisce di `ChatPane`
   (fuori dal blocco del composer, salvo chat vuota); scroll-padding dello scroller; i toggle
   delle strisce tengono la vista (`useDisclosureToggle`). Barra: scenario 1, `chat-changed-files`,
   `chat-accordion-no-shift` (le strisce: solo il caso in fondo).
4. **E2E, video e mutazione.** `tests/e2e/chat-strips-in-transcript.spec.ts`, spec aggiornate di
   proposito (`chat-command-visible`, `chat-running-server`, `chat-changed-files`,
   `chat-accordion-no-shift`).
   Dipende da 1-3.
5. **Spec.** `openspec/specs/chat/spec.md`: SUBSTRIP-02, CHAT-END-01; CHAT-FOLD-01, TODO-01,
   CHAT-CHANGES-01, CHGSET-03 e BGVIS-07 riscritti dove dicevano «sopra il composer».
6. **Dal vivo.** `bun run build:client`, poi la chat Prince of Persia in sola lettura (WebKit
   headless): le strisce in fondo, la riga di Muse apre la sua card.
