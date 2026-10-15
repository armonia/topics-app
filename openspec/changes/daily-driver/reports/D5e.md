# D5e · sbirciata dalla board

## Barra

Prima: la barra non è stata eseguita prima del primo edit, quindi manca una misura di baseline.

Dopo: `bun test shared/task-session-peek.test.ts` → 3 pass, 0 fail, exit 0; `bun run typecheck` → exit 0; `bun run typecheck:e2e` → exit 0; `bun run lint` → exit 0; `./scripts/qa-gate.sh --veloce` → exit 0. La mutazione in copia che seleziona il primo messaggio fa fallire il test, exit 1 atteso.

## Fatto

- `GET /api/all-boards/tasks/:taskId/peek` legge al massimo gli ultimi tre messaggi dell'agent e restituisce stato, durata, tool attivo, righe e usage già disponibile. `shared/task-session-peek.test.ts` prova anche una card senza sessione: 3 pass, exit 0.
- Il riquadro in `SessionPeek.tsx` si carica al passaggio, al fuoco o al tocco prolungato; interroga ogni 1,2 s solo mentre è aperto. `Card.tsx` conserva il gesto di drag e non apre la sessione.
- Aggiunto KANBAN-96 in `openspec/specs/kanban/spec.md` con scenario di aggiornamento e scenario senza sessione. La spec e2e con CLI finto è scritta e `bun run typecheck:e2e` esce 0.
- Il primo `qa-gate` era exit 1 perché il test nuovo non dichiarava `@covers`; aggiunta l’annotazione, rilancio verde, exit 0.

## Trovato e non fatto

- La spec Playwright con video non è stata eseguita sul Mac: il brief locale riserva le e2e alla CI. Nessun commit o push è consentito in questa consegna; serve la CI dopo il push del proprietario per ottenere il video richiesto.
- La barra prima degli edit non è stata raccolta; nessun dato precedente riproducibile senza ricreare una copia completa del checkout.

## Rifiutato

- Quattro warning ESLint in `App.tsx`, `useProjectBrowserPanes.ts`, `useRemoteBrowser.ts` e `useSpeech.ts` non sono errori della traccia; i file non sono stati toccati e lint/gate escono 0.

## Giro 2

### Barra

Prima del giro 2: `bun test shared/task-session-peek.test.ts` → 3 pass, 0 fail; `bun run typecheck`, `bun run typecheck:e2e` e `bun run lint` → exit 0.

Dopo: `bun test shared/task-session-peek.test.ts server/routes/tasks.session-peek.test.ts` → 5 pass, 0 fail; `bun run typecheck` → exit 0 (server baseline 0); `bun run typecheck:e2e` → exit 0; `bun run lint` → exit 0.

### Fatto

- Il long-press con sessione apre il menu contestuale esistente e la sbirciata è il primo elemento; il menu mantiene «Ferma». Aggiornata `board-card-stop.spec.ts` per verificare entrambi.
- Il mouse apre il portale dopo 400 ms, chiude all’uscita e non interroga la rotta prima dell’apertura. La posizione resta fuori dalla card, sotto o sopra quando sotto non entra; il fuoco da tastiera apre subito ed Esc chiude. La e2e copre ritardo, richieste, posizione e tastiera.
- La rotta usa `ActiveStream.content` e `startedAt` quando il turno è attivo; altrimenti legge una sola riga, l’ultimo messaggio assistant non vuoto. Aggiunto il test di rotta: il testo live prevale sul DB e segue la crescita.
- Mutazioni verificate e ripristinate: scegliere il primo messaggio → test rosso, exit 1; ignorare `activeStreams` nella rotta → test rosso, exit 1. Le copie temporanee sono state rimosse.

### Trovato e non fatto

- Esecuzione e video Playwright non disponibili sul Mac per regola del brief. `board-session-peek.spec.ts` e il caso touch aggiornato in `board-card-stop.spec.ts` sono tipizzati; manca il run CI «Clip di consegna» per la prova video.

### Rifiutato

- I quattro warning ESLint già presenti in file non toccati restano warning; `bun run lint` esce 0.
