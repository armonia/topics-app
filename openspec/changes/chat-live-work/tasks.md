# Tasks: chat-live-work

Lo stato di una traccia lo danno git e i test, non le caselle.

1. **Server: output rediretto.** `run_command` riconosce la redirezione dello stdout verso un file
   e lo segue nel log del comando, con lo stesso tetto (1 MB, poi 500 KB) e la ripresa dopo il
   riavvio di CMDRUN-03. Descrizione dello strumento aggiornata. Barra: unit test sul
   riconoscimento e sul seguito; scenario 2.
2. **Sorgente «al lavoro».** Per una sessione: i sotto-agenti vivi (nativi dalla tabella `subagents`
   e da `/api/sessions/:key/agents`, CLI dal roster dei terminali) più i comandi in corso
   (`/api/processes?topicId=`), ciascuno con l'ultima riga. Barra: unit test sul selettore.
3. **Client: la striscia.** `SubAgentsStrip` mostra le righe vive con l'anteprima e il clic; una
   riga finita esce dopo 60 s. Barra: test del componente; scenari 1 e 3. Dipende da 2.
4. **Client: pannello vuoto.** `ProcessLogPane` dice cosa aspetta e da quando, e se il comando
   scrive in un file che non si può seguire. Barra: `ProcessLogPane.test.tsx`.
5. **E2E, video e mutazioni.** `tests/e2e/chat-live-work.spec.ts`. Dipende da 1-4.
6. **Dal vivo.** `bun run build:client`, poi la chat Prince of Persia: Muse e il server delle clip
   nella striscia, il log di Muse si apre pieno. Chiude anche il task 11 di `subagent-nativi`.
7. **Una riga sola per comando.** La riga di un comando nella striscia ha **Ferma** (la route dello
   Stop dei processi) e, se la sua fine sveglia la chat, lo dice (`wakes` da `/live-work`). Sotto
   il trascritto la riga dei server (`RunningServiceRows`) sparisce e la riga del lavoro in
   background non nomina più i comandi: li nominavano due volte (07/10, Muse e il server delle clip
   sulla chat Prince of Persia). Barra: test del componente, scenari 1 e 3 estesi, BGVIS-07/08
   riscritti sulla striscia (`chat-command-visible`, `chat-running-server`).
