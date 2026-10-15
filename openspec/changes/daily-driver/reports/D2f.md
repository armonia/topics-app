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

## Trovato e non fatto

- Esecuzione browser/video non fatta sul Mac come impone `BRIEF-locale.md`. La CI deve eseguire lo scenario DOM sotto 5.000 nodi, la nuova `board-virtualized-drag.spec.ts` e le spec richieste: `board-drag-frames`, `board-drag-renders`, `board-column-volume`, `board-motion-contract`, `board-task-flow`, `board.spec`, `drag-preview`, `drag-no-text-selection`, `refresh-durability-board`, `split-dnd-matrix`. Revisione indipendente e prova video restano alla verifica CI.
- Mutazione non eseguita in locale. Punto preciso: `client/src/components/Board/VirtualizedCards.tsx`, selezione `visibleIds`; mutarla affinché contenga ogni ID e monti ogni `Card` completa. L'e2e combinata deve allora superare 5.000 nodi e diventare rossa.

- Le altezze si misurano solo per le card disegnate (stima 184 px per le altre): risalendo dopo un salto con la barra di scorrimento, le card misurate sopra la finestra spostano quelle sotto, e il contenuto sotto gli occhi salta. Serve compensare `scrollTop` della differenza.

## Rifiutato

- Aggiungere un altro renderer virtuale: la finestra manuale mantiene rettangoli sortable misurati per gli ID fuori schermo, necessari alla collisione e alla tastiera. `react-virtuoso` resta usato dove già serve, senza nuova dipendenza né modifica a `boardCollision` o `onDragEnd`.
