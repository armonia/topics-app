# D2f · Finestra virtuale della board

## Barra · prima → dopo

- **Prima:** `bun run typecheck` exit 0; `bun run lint` exit 0, 4 warning già presenti; `./scripts/qa-gate.sh --veloce` exit 1 per `check:identifier-language` su `heaviestChild` in `tests/e2e/dom-node-budget.spec.ts`. Scenario CI D2e, run 38698312919: trascritto 796 nodi, trascritto + board 20.309 nodi.
- **Dopo:** `bun run typecheck` exit 0, incluso `typecheck:e2e`; `bun run lint` exit 0, 4 warning già presenti; `./scripts/qa-gate.sh --veloce` exit 0; test mirati 26 pass / 0 fail / 75 asserzioni; `bun run build:client && bun run check:bundle` exit 0. Entry eager: 872.977 byte raw, 281.656 gzip; budget rispettato.
- **Misura D2f:** non raccolta in locale perché le e2e sono vietate dal brief; il nuovo scenario DOM deve riportare il carico combinato sotto 5.000 nodi in CI.

## Fatto

- Le colonne backlog, todo e in_progress usano una finestra con altezze misurate e buffer. Fino a 25 card le card restano tutte montate; oltre, il contenuto fuori finestra diventa un singolo nodo sortable leggero. `SortableContext` riceve tutti gli ID e la card attiva resta montata anche quando esce dalla finestra; l'overlay e i sensori esistenti restano in uso.
- Review e Done conservano la paginazione. La barra di `dom-node-budget.spec.ts` è tornata a `DOM_BUDGET` (5.000) e legge i totali dagli header: backlog 1.155, todo 21, review 1, done 26.
- Aggiunta e2e coperta da KANBAN-01: 320 card, trascinamento mouse con autoscroll fino alla posizione 70, trascinamento da tastiera oltre 50 posizioni; entrambi verificano il nuovo ordine via API server. Il requisito KANBAN-01 ora dichiara questo comportamento.
- Unit mirati per layout e finestra, più i contratti della colonna e la stabilità degli ID: 26 pass, 0 fail. `typecheck:e2e` comprende la compilazione della nuova e2e.
- Nessuna dipendenza aggiunta. `check:bloat` exit 0 dopo aver spostato la finestra in `VirtualizedCards.tsx`; `git diff --check` exit 0.

## Revisione (15/10)

- Nel ramo non virtualizzato (Review, Done) le card avevano perso la `key`: React le avrebbe riconciliate per indice. Tornata in `renderCard`.
- `COLVOL-03` (`board-column-volume.spec.ts`) asseriva ancora 30 card disegnate in todo: con la finestra sarebbe stato rosso. Ora conta i bersagli (card più segnaposto = 30), scorre in fondo alla colonna e trascina l'ultima card, che la finestra lì disegna.
- La e2e nuova teneva il puntatore sul bordo e aspettava che la card n. 70 fosse in vista mentre l'autoscroll correva: con i poll fra 100 e 1.000 ms poteva sorpassarla. Ora scorre oltre 3.000 px, torna al centro (l'autoscroll si ferma) e lascia lì; la card deve finire oltre quelle disegnate all'inizio. La lista del server si ordina col comparatore del prodotto (`compareTasks`), perché la rotta non promette un ordine.
- Ripristinati, in inglese come vuole il cricchetto, i commenti che spiegavano la misura del 15/08 e perché Review e Done si sfogliano, e quello sull'attesa di una risposta.

## Misura in CI (15/10)

- Clip `dom-node-budget.spec.ts`, run 38705596569, verde: transcript 796 nodi, transcript e board **3.200 nodi** (con D2e erano 20.309), sotto `DOM_BUDGET` di 5.000.
- Mutante in `VirtualizedCards.tsx`, `visibleIds` che contiene ogni id (`tasks.length <= VIRTUAL_FULL_RENDER_LIMIT || tasks.length > 0`), run 38705669867: **21.488 nodi**, rosso alla riga 89 e al retry.

## Ancoraggio dello scroll (15/10)

- **Il contenuto saltava risalendo.** Le card non ancora disegnate stanno nella colonna con la stima di 184 px; quando una card sopra lo schermo veniva disegnata e misurata, tutto ciò che era sullo schermo si spostava della differenza. Ora `VirtualizedCards` somma la variazione delle card che cominciano sopra lo schermo e scorre della stessa quantità nel layout effect, nello stesso fotogramma del layout nuovo (`scrollBy`, istantaneo): le card interamente sullo schermo restano dove sono. Contare solo le card interamente sopra non bastava: una card disegnata per la prima volta a cavallo del bordo spostava lo stesso il resto (rossa di 245 e 653 px, run 38710009951). WebKit non ha `overflow-anchor` che lo faccia da sé. `scrollParentOf` sostituisce le tre copie della ricerca del contenitore che scorre (`Card.tsx`, `readVirtualViewport`).
- E2E nuova in `board-virtualized-drag.spec.ts`: salto a metà colonna, risalita di 400 px, la card che era sullo schermo si sposta di 400 px e di nient'altro. Mutante senza lo `scrollBy`: run 38708619315, rossa con 450 e 863 px di troppo.
- **Durante un trascinamento la compensazione non scatta.** L'autoscroll di dnd-kit guida lo scroll, e la compensazione sotto di lui lo fermava e riportava la colonna in su: a 20 s la colonna mostrava le card 39-46, a 30 s le 33-39, scrollTop fermo a 1.826 (run 38710009951). La stessa e2e senza compensazione arriva oltre 3.000 (run 38711169503).
- **La e2e del trascinamento non era mai passata.** Afferrava la card a 30 px dal bordo sinistro, su un comando, dove il sensore del mouse della board non fa partire il trascinamento: l'autoscroll che aspettava non poteva arrivare (scrollTop 0, run 38708614483). Ora afferra al centro della riga alta, come le altre spec della board, e controlla che il trascinamento sia partito prima di aspettare l'autoscroll. La parte da tastiera cercava la card n. 5 con la colonna rimasta in fondo, dove non è disegnata: ora torna in cima prima.

## Trovato e non fatto

- Esecuzione browser/video non fatta sul Mac come impone `BRIEF-locale.md`. La CI deve eseguire lo scenario DOM sotto 5.000 nodi, la nuova `board-virtualized-drag.spec.ts` e le spec richieste: `board-drag-frames`, `board-drag-renders`, `board-column-volume`, `board-motion-contract`, `board-task-flow`, `board.spec`, `drag-preview`, `drag-no-text-selection`, `refresh-durability-board`, `split-dnd-matrix`. Revisione indipendente e prova video restano alla verifica CI.

- Su iOS uno scroll fatto dal codice ferma l'inerzia: risalendo con un lancio in una zona mai disegnata, dopo un salto, il lancio si ferma alla prima card misurata sopra lo schermo. La strada di react-virtuoso (spostare la lista con un margine mentre si scorre, e scambiarlo con lo scroll a riposo) lo eviterebbe. Non misurato, non fatto.

## Rifiutato

- Aggiungere un altro renderer virtuale: la finestra manuale mantiene rettangoli sortable misurati per gli ID fuori schermo, necessari alla collisione e alla tastiera. `react-virtuoso` resta usato dove già serve, senza nuova dipendenza né modifica a `boardCollision` o `onDragEnd`.
