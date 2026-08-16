# Tasks — sidebar-pinned-tiles

Convenzione: ogni fase chiude con `bun run typecheck:client` + `bun run build:client` verdi.
`[ ]` = da fare.

## Phase 0 — Fondamenta (nessuna UI; senza queste il resto poggia sul vuoto)
- [x] 0.0 **Chiave di pin unica per progetto** — `paneConfig.ts::pinKeyForPane` (:158-171)
  restituisce per i progetti la forma **grezza** (`project:` + `decodeURIComponent(path)`),
  non `pane.id`; esportare `normalizePinKey(key)`. Aggiornare il commento del blocco che
  oggi documenta la forma codificata. Unit test: le due forme collassano su una.
- [x] 0.1 **Migrazione al load** — in `useSidebarState`, `normalizePinKey` su ogni voce di
  `pinnedItems` + dedup (una volta, al caricamento). Test: uno stato con entrambe le forme
  carica un solo pin.
- [x] 0.2 `client/src/lib/pinnedLayout.ts` — modulo puro. `type PinnedRow = { keys: string[];
  widths: number[] }`. `reconcilePinnedLayout(pinnedItems, layout, { maxCols })`,
  `movePinnedTile(layout, key, { rowIdx, insertAt })`, `insertPinnedRow(layout, key, atRowIdx)`,
  `previewWidths(row, insertAt)`. **Riusare `components/Layout/gridWidths.ts`**
  (`appendColumnWidths`, `splitColumnWidths`, `equalizeWidths`, `normalizeWidths`) invece di
  riscrivere la matematica delle larghezze — ha già risolto il «trascinare mi resetta il layout».
  Costanti `PINNED_ROW_DEFAULT`, `PINNED_ROW_SOFT_MAX`, `PINNED_TILE_MIN`.
- [x] 0.3 `client/src/lib/pinnedLayout.test.ts` (`bun:test`) — chiavi non più fissate potate,
  fissati nuovi accodati, righe che si svuotano, layout assente, idempotenza di `reconcile`,
  `move` fra righe e dentro la stessa riga, larghezze che sommano a 1 dopo ogni operazione.
- [x] 0.4 `client/src/lib/iconTint.ts` — colore dominante da un'icona same-origin
  (canvas 1×1), memoizzato per path; **nessun fallback inventato**: niente icona ⇒
  `null` ⇒ tessera piatta (regola «no invented colors»). Colore di tipo da `PANE_CONFIG`
  per chat/terminali/browser. Scelta del colore del testo dalla luminanza del fondo
  **composito**. Nessuna persistenza su localStorage dello stato "nessuna icona"
  (regola già pagata su `ProjectFavicon`).
- [x] 0.5 `client/src/lib/iconTint.test.ts` — assenza di icona ⇒ `null`, soglia di
  luminanza per il testo, memoizzazione.
- [x] 0.6 `lib/dndTypes.ts` — `PINNED_TILE: 'application/x-pinned-tile'`.
- [x] 0.7 `hooks/useSidebarState.ts` — `pinnedLayout: PinnedRow[]` in `SidebarState`
  **e in `DEFAULT_STATE`** (senza il secondo, `sanitizeSidebarPayload` lo strippa a ogni
  GET, push WS e evento cross-tab: scritto e mai riletto, senza un solo errore).
  `togglePin` aggiorna `pinnedItems` **e** `pinnedLayout` nello stesso `setState`;
  `setPinnedLayout` esposto dal return.
- [x] 0.8 **CAS sul PUT** — `?base=<server_seq>` + retry sul 409 `stale_base`, sul modello di
  `state/pane/middleware/syncServer.ts:104,194`. Il server lo supporta già
  (`server/routes/ui-state.ts:283-328`): con un layout dentro, una scrittura persa non
  costa un pin ma l'intera disposizione.
- [x] 0.9 Estendere `useSidebarState.test.ts`: il campo sopravvive al round-trip, un payload
  vecchio senza campo carica senza errori, il 409 riapplica invece di sovrascrivere.

## Phase 1 — La tessera
- [x] 1.1 `components/Sidebar/PinnedTile.tsx` — `role="treeitem"`, `data-pinned="true"`,
  `aria-label={item.name}`, tinta da `iconTint`, `ProjectFavicon` per i progetti,
  icona di tipo + nome per chat/terminali/browser, nome troncato **e nessuna tinta** per i
  progetti senza icona. **Mai** un monogramma sintetico. Testo ≥11px, contrasto ≥4.5:1 sul
  fondo composito, superfici dai token (mai un hex cablato). Badge notifiche invariato;
  indicatore di attività invariato (nessuna animazione nuova sulla tinta). La precedenza
  degli stati resta quella di `sidebarRowCard`: attenzione > selezionato > aperto > riposo.
- [x] 1.2 Drag source nativo HTML5: `PINNED_TILE` **e** `PANEL_ID` sullo stesso
  `dataTransfer` (il drop nella griglia dei pane deve restare identico), ghost compatto
  come `TopicItem.handleDragStart`.
- [x] 1.3 Menu contestuale della tessera: le stesse voci della riga (fissa/rimuovi,
  archivia, …) — nessuna funzione persa passando da riga a tessera.

## Phase 2 — La griglia, e via l'etichetta
- [x] 2.1 `components/Sidebar/PinnedTiles.tsx` — righe da `pinnedLayout` riconciliato,
  flex row con `flex-basis` calcolato, soft-wrap sotto `PINNED_TILE_MIN` **senza**
  riscrivere il layout salvato. `data-testid="sidebar-pinned-section"` sul contenitore.
- [x] 2.2 `TopicTree.tsx` — sostituire i 4 blocchi (`:999-1008`, `:1033-1044`,
  `:1052-1056`, `:1071-1075`) con `<PinnedTiles/>`. Spariscono le due intestazioni
  i18n e le due `renderSection('pinned', Pin, 'Fissati', …)`.
- [x] 2.3 `lib/i18n.ts` — rimuovere `sidebar.pinnedSection` (it `:139`, en `:251`).
  **Tenere** `sidebar.pinned`: è il titolo del marcatore sulla riga, usato anche altrove.
- [x] 2.4 Verificare che `pinnedBlock` resti l'unica fonte degli item (nessuna doppia
  resa: gli unpinned continuano a escludere i fissati).

## Phase 3 — Composizione delle righe in drag & drop
- [x] 3.1 Drop target per riga: calcolo dell'indice d'inserimento dalla posizione X,
  tessera fantasma al posto d'inserimento.
- [x] 3.2 Ridimensionamento in diretta: la riga sotto il cursore calcola `flex-basis` con
  `n+1` mentre il drag è sopra di lei; `transition: flex-basis 120ms`.
- [x] 3.3 Zona di drop "riga nuova" sotto l'ultima riga (8px a riposo, riga intera in hover).
- [x] 3.4 Al rilascio: `moveTile`/`appendRow` → `setPinnedLayout`. Annullamento pulito su
  `dragend` senza drop (nessuno stato fantasma appeso).
- [x] 3.5 Verificare a mano che il drag di una tessera **dentro la griglia dei pane**
  continui ad aprire l'elemento (è il rischio numero uno di questa change).

## Phase 4 — Espansione sotto la riga
- [x] 4.1 Stato aperto transitorio (`useState`, un `Set<string>`); click sulla tessera
  fa toggle. Nessuna persistenza.
- [x] 4.2 Rendering: dopo ogni riga, la/e fascia/e delle sue tessere aperte. Contenuto =
  `item.children` con il `renderItem` esistente.
- [x] 4.3 Più fasce aperte: contenitore in colonna, `flex: 1 1 0` per fascia, scroll
  proprio, tetto d'altezza della sezione.
- [x] 4.4 Tastiera: `Enter`/`Space` sulla tessera fa toggle come il click; `Escape`
  chiude la fascia col focus dentro.

## Phase 5 — Verifica ed evidenza
- [x] 5.1 `bun run typecheck:client` + `bun run build:client` verdi.
- [x] 5.2 Test E2E esistenti dei Fissati verdi **senza modificarli**:
  `tests/e2e/sidebar.spec.ts` (describe «Sidebar — Fissati (pinning)»),
  `tests/e2e/spaces-switcher.spec.ts:356`, `tests/e2e/topic-management.spec.ts:398`.
  Se uno va aggiornato, motivarlo qui invece di riscriverlo di soppiatto.
- [x] 5.3 Nuovo `tests/e2e/sidebar-pinned-tiles.spec.ts`: tessere affiancate; nessuna
  intestazione in nessun modo di vista; drag fra righe con persistenza dopo reload;
  espansione inserita fra le righe giuste (assert su `boundingBox().y`); due fasce
  aperte insieme; drag verso la griglia che apre ancora il pane.
- [x] 5.4 **Evidenza durevole = video**: `recordVideo` sul context per lo scenario di drag
  (le size in diretta) e per l'espansione — un `.png` non prova un comportamento.
  → `~/.topics/media/sidebar-pinned-tiles-2026-08-06.webm` (306 KB, girato con
  `E2E_EVIDENCE=1`: drag dalla terza riga alla prima con le tessere che si
  stringono, poi apertura e chiusura della fascia del progetto).
- [x] 5.5 `bun run check:deadcode` — verificare che `renderSection` sia ancora usata dai
  gruppi per tipo/stato (lo è) e che non resti nient'altro orfano.
- [x] 5.6 Bump di versione (root `package.json` + `Cargo.toml` +
  `desktop-tauri/src-tauri/tauri.conf.json` in lockstep) e voce di changelog.

## Fuori piano, arrivato in corsa
- [x] **Il pin torna una scorciatoia** (Attilio, 06/08): la tab fissata si chiude,
  resta fissata, e la tessera la riapre. Rimossi `isPaneClosable` (+ test) e la
  guardia `isCloseBlockedByPin` in `App.tsx`; PIN-1/2/3 riscritti.
- [x] **Larghezza della tessera**: il `<button>` non è un flex item, quindi si
  fermava al contenuto invece di riempire lo slot. `w-full`.
- [x] **Menu contestuale della tessera per OGNI tipo**: chat, terminale e browser
  ne erano scoperti — una volta fissati non c'era più nessun posto da cui
  togliere il pin.
