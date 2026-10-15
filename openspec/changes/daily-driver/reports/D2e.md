# D2e — budget dei nodi DOM

## Barra

- **Prima delle correzioni:** `bun run typecheck` exit 2 (TS2554 nella nuova spec); `bun run lint` exit 0; `./scripts/qa-gate.sh --veloce` exit 1, 4 cancelli rossi (`check:identifier-language`, `check:untraced-tests`, `check:spec-coverage`, `typecheck`).
- **Dopo:** `bun run typecheck` exit 0; `bun run typecheck:e2e` exit 0; `bun run lint` exit 0; `./scripts/qa-gate.sh --veloce` exit 0, 0 cancelli rossi.
- **Spec DOM:** non eseguita sul Mac per il divieto in `playwright.config.ts`; conteggi e allegati restano da acquisire in CI.

## Fatto

- `tests/e2e/dom-node-budget.spec.ts` aggiunge i due scenari richiesti: transcript da 2.000 messaggi e transcript con board. Conta anche gli elementi negli shadow root aperti, attende cronologia completa, fondo raggiunto e animazioni ferme; allega i dieci sottoalberi più grandi e applica il tetto di 5.000 nodi.
- Il seed del transcript è condiviso con `bench-streaming.spec.ts` in `tests/e2e/helpers/seed-transcript.ts`; il benchmark mantiene la stessa forma e gli stessi dati.
- La board usa la distribuzione indicata del 15/10/2026: 1.155 backlog, 21 todo, 1 review e 26 done. Il codice renderizza per intero backlog e todo; `columnSlice` mostra 25 review/done alla prima pagina.
- Tier `@nightly`: la preparazione seriale di oltre 3.000 righe supera il budget breve della PR.

## Trovato e non fatto

- Mancano il risultato CI della spec e i conteggi DOM effettivi. Senza quei numeri non si può decidere se virtualizzare board/sessioni; la barra della traccia resta aperta fino alla run CI.
- Mutazione preparata, non eseguita: in una copia sostituire il rendering `<Virtuoso data={filteredMessages}>` in `client/src/components/Chat/MessageList.tsx:2211` con il rendering di tutti i messaggi. Deve far fallire lo scenario 1.

## Rifiutato

- I quattro warning ESLint sono in `App.tsx`, `useProjectBrowserPanes.ts`, `useRemoteBrowser.ts` e `useSpeech.ts`, non introdotti da questa traccia; `lint` esce 0.
- Nessun dato è stato letto dal DB vivo; la spec usa solo la distribuzione fornita nel perimetro.
