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

## Revisione (15/10)

- La spec misurava una pagina non ancora ferma: risaliva la cronologia senza aspettarla tutta. Ora risale con la rotella fino a `data-history="complete"` (nessun `chat-load-older` rimasto), torna in fondo con la rotella e aspetta che le animazioni finiscano. Lo scenario 2 mette la chat accanto alla board con «Dividi a destra», come farebbe una persona. Le cancellazioni del seed vanno a ondate di 20.
- Il rapporto dei dieci sottoalberi più pesanti elencava la catena degli antenati, ciascuno un nodo più piccolo del padre. Ora nomina i punti dove il peso si divide: nessun figlio tiene il 90%.
- **Numeri CI** (run 38698312919): scenario 1, 2.000 messaggi, **796 nodi**, sotto i 5.000. Scenario 2, chat e board, **20.309 nodi**: le colonne ordinate a mano (backlog, todo, in corso) disegnano ogni card, e il backlog ne ha 1.155.
- **Mutante** (run 38698161137): `increaseViewportBy` del transcript da 400 a 1.000.000 in `MessageList.tsx`, cioè tutti i messaggi montati: **41.077 nodi**, rosso. Lo scenario 1 morde.
- Lo scenario 2 ha un tetto a cricchetto, 21.000 nodi, finché quelle colonne non sono virtualizzate (passo 3 di D2); poi scende a 5.000. Non si possono sfogliare come Review e Done: una card non disegnata non è un bersaglio di dnd-kit, e il trascinamento si romperebbe in silenzio (`boardOrder.ts`).

## Trovato e non fatto

- Virtualizzare backlog, todo e in corso tenendo il trascinamento: è la traccia successiva di D2, con barra lo scenario 2 sotto i 5.000 nodi e le e2e della board verdi.
- L'elenco delle sessioni non ha ancora uno scenario.

## Rifiutato

- I quattro warning ESLint sono in `App.tsx`, `useProjectBrowserPanes.ts`, `useRemoteBrowser.ts` e `useSpeech.ts`, non introdotti da questa traccia; `lint` esce 0.
- Nessun dato è stato letto dal DB vivo; la spec usa solo la distribuzione fornita nel perimetro.
