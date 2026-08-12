# Design — sidebar-pinned-tiles

## Decisione 0 — Prima si unifica la chiave di pin dei progetti, o la griglia nasce con celle fantasma

**Bug pre-esistente, verificato.** Lo stesso progetto ha due chiavi di pin diverse a
seconda di *dove* lo fissi:

- dalla **sidebar** → `project:/Users/utente/Projects/X` (path **grezzo**,
  `buildSidebarItems.ts:509,544`);
- dalla **tab bar** → `project:%2FUsers%2Futente%2FProjects%2FX` (path **codificato**:
  `pinKeyForPane` restituisce `pane.id`, `paneConfig.ts:158-171`).

La divergenza è già scritta nero su bianco a `buildSidebarItems.ts:695-704` — «confonderli
significa non riconoscere mai un progetto come tab di un gruppo» — ma vale per
`sidebarItemPaneId`, non per il pin. Conseguenze **oggi**: un progetto fissato dalla tab
non compare mai nel blocco Fissati, e lo stesso progetto può stare **due volte** in
`pinnedItems`.

Oggi il danno è invisibile perché il blocco è una lista che semplicemente non mostra la
riga. Con un layout **indicizzato per chiave** diventa permanente: celle che non si
risolvono mai, che la riconciliazione non può né riempire né togliere.

Quindi la Phase 0 apre con: `pinKeyForPane` restituisce la forma grezza per i progetti,
più un `normalizePinKey()` esportato, applicato in migrazione una volta al load su
`pinnedItems` (decodifica + dedup). Non è scope creep: senza, il resto poggia sul vuoto.

## Decisione 1 — Il layout è una lista di righe con larghezze, non coordinate per elemento

```ts
/** Una riga di tessere: le chiavi in ordine, e le larghezze proporzionali.
 *  La LUNGHEZZA della riga È il "quante per riga": non esiste un campo a parte. */
type PinnedRow = { keys: string[]; widths: number[] };
pinnedLayout: PinnedRow[];
```

L'alternativa (`{ [id]: { row, col } }`) tiene due verità sullo stesso fatto — l'ordine
dentro la riga e il conteggio della riga — e le lascia divergere al primo drop
interrotto. Con le righe l'invariante è strutturale: una tessera sta in esattamente una
riga, e la riga si conta da sola.

`widths` esiste perché «vedendo in live le size di tutto» implica che le tessere possano
**non** essere tutte uguali. La matematica **non si riscrive**: `components/Layout/gridWidths.ts`
ha già `appendColumnWidths`, `splitColumnWidths`, `equalizeWidths`, `normalizeWidths`, e ha
già risolto il bug «trascinare mi resetta il layout» preservando le proporzioni delle
colonne non toccate. Il rendering usa lo stesso linguaggio flex delle colonne di
`SplitTree.tsx:99` (`flex: <width> 1 0%`).

**Riconciliazione** (`lib/pinnedLayout.ts`, modulo puro, unit-tested). Il layout non è
mai autorevole sull'*insieme*: lo è `pinnedItems`. A ogni render:

1. gli id nel layout che non sono più fissati vengono tolti (righe vuote scartate);
2. i fissati non ancora nel layout vengono accodati all'ultima riga finché entra
   (`PINNED_ROW_SOFT_MAX`), poi su una riga nuova;
3. layout assente (client mai passato di qui, o payload vecchio) ⇒ derivato da
   `pinnedItems` in ordine di pin, righe da `PINNED_ROW_DEFAULT`.

Questo rende il campo **auto-migrante**: `{ ...DEFAULT_STATE, ...parsed }`
(`useSidebarState.ts:121,166`) è già la migrazione, come lo fu per `pinnedItems`.

> ⚠️ `sanitizeSidebarPayload` (`useSidebarState.ts:60-66`) **strippa ogni chiave non
> presente in `DEFAULT_STATE`**. Il campo va aggiunto a `DEFAULT_STATE` *nello stesso
> commit* in cui viene scritto, o il round-trip col server lo cancella in silenzio.

**La LWW ereditata NON si eredita: si chiude.** `useSidebarState.ts:78-82` dichiara la
last-write-wins sull'oggetto intero come caveat accettato — «single release train» — e cita
che è esattamente così che i pin andarono persi la prima volta. Con un layout dentro, il
prezzo di una scrittura persa non è più un pin: è l'intera disposizione, e la ripaga anche
un client vecchio che al primo PUT rimette il campo a nulla per tutti.

Il rimedio **esiste già lato server e non va costruito**: `PUT /api/ui-state/:key` accetta
`?base=<server_seq>`, confronta dentro la stessa transazione `IMMEDIATE` e risponde **409
`stale_base`** senza scrivere né broadcastare (`server/routes/ui-state.ts:283-328`). Il
client per usarlo c'è già come modello: `state/pane/middleware/syncServer.ts:104,194`.
Quindi il PUT di `useSidebarState` passa a CAS + retry sul 409 (ri-legge, riapplica, ri-manda).

## Decisione 2 — Drag nativo HTML5, non dnd-kit

`useSortable` **c'è ancora in `TopicItem.tsx:106` ma è morto**: il commento a
`TopicItem.tsx:140-143` dice che una migrazione a dnd-kit rimosse il `DndContext`, e il
drag vero della sidebar oggi è HTML5 nativo con `DND_TYPES.PANEL_ID`. Non c'è nessun
`DndContext` fuori dalla board.

Rimontare un `DndContext` attorno alla griglia introdurrebbe il conflitto peggiore
possibile: il `PointerSensor` di dnd-kit fa `preventDefault` sul pointerdown e **uccide il
`dragstart` nativo**, cioè proprio il drag che porta un fissato dentro la griglia dei pane
(`SpaceGroups.tsx:285-286,309-310` legge `PANEL_ID`). Si perderebbe una funzione viva per
guadagnarne una nuova.

Quindi: **HTML5 nativo**, con la grammatica che il repo già parla
(`SIDEBAR_REORDER`, `LAYOUT_ROW`, `GRID_ROW` in `lib/dndTypes.ts`). Si aggiunge:

```ts
/** Riordino di una tessera dentro la griglia dei Fissati */
PINNED_TILE: 'application/x-pinned-tile',
```

La tessera scrive **entrambi** i tipi sul `dataTransfer`:

```ts
e.dataTransfer.setData(DND_TYPES.PINNED_TILE, item.id);  // la griglia dei fissati
e.dataTransfer.setData(DND_TYPES.PANEL_ID, item.id);     // la griglia dei pane, invariata
```

Chi riceve sceglie il tipo che capisce. Trascinare una tessera nella griglia continua ad
aprire il pane esattamente come oggi; trascinarla su un'altra riga la sposta.

## Decisione 3 — Le size in diretta si ottengono facendo posto, non simulando

Ogni riga è un flex row; la tessera ha
`flex: 0 0 calc((100% - (n-1)*gap) / n)` con `n` = numero di tessere **che la riga avrà
al drop**. Durante un drag sopra la riga bersaglio, `n` diventa `n+1` (o `n` se la
tessera viene da lì): le tessere si stringono davvero, con una `transition: flex-basis
120ms`. Non c'è un'anteprima separata da mantenere in sincrono — quello che vedi mentre
trascini **è** il risultato, con una tessera fantasma al posto d'inserimento.

Sotto l'ultima riga sta una zona di drop alta 8px che si apre a riga intera quando ci
passi sopra: è così che nasce una riga nuova.

**Sidebar stretta.** Il conteggio salvato si rispetta fino a `PINNED_TILE_MIN = 32px` per
tessera; sotto quella soglia la riga va a capo da sola (soft-wrap visivo) **senza
riscrivere il layout**. Un monitor stretto non deve poterti distruggere la disposizione
fatta su quello largo.

## Decisione 4 — Il bagliore è identità; la corona resta attività

La tinta ha **tre sorgenti in ordine di precedenza, e nessuna è inventata** — la regola
è dura e già scritta: *«no invented colors/icons; a project's icon + color should come
from a real manifest only if present; otherwise render plain»*, con i colori
auto-assegnati dal server contati esplicitamente come inventati.

1. **Progetto con icona reale** → colore dominante campionato dall'icona
   (`GET /api/projects/icon`, same-origin ⇒ canvas non taintato) su un canvas 1×1 in
   `lib/iconTint.ts`, memoizzato per path. È letteralmente il colore del progetto,
   non un'assegnazione.
2. **Chat / terminale / browser** → il colore di tipo che il repo già parla
   (`PANE_CONFIG` in `paneConfig.ts:45-57`: chat `#0066ff`, terminale `#8b5cf6`,
   browser `#10b981`). Preesistente, non nuovo.
3. **Progetto senza icona** → **nessuna tinta**. Tessera piatta sulla superficie neutra.

Il punto 3 è la parte che fa male e si tiene lo stesso: una hue derivata dall'hash dell'id
differenzierebbe meglio, ma sarebbe esattamente il colore inventato che la regola vieta.
Il progetto senza icona resta riconoscibile dal nome, che infatti in quel caso la tessera
mostra.

- **Resa**: fondo `color-mix(in oklab, <tinta> 22%, var(--bg-surface))` + `ring-1` a `40%`
  + un alone `radial-gradient` morbido dietro. Statico. Nessuna animazione. Superficie
  derivata dai token, mai un hex cablato — è l'offender ricorrente.
- **La corona rotante non si tocca**: resta il segnale di *sta lavorando*
  (`useTerminalWorkingRing` / `useTopicLoading`, e `AuraWave` è cablato a 5 stop senza
  prop di tinta: non è riusabile nemmeno volendo). Se il bagliore d'identità animasse, i
  due segnali diventerebbero uno solo e quello che dice qualcosa perderebbe.
- **Leggibilità**: testo minimo **11px** (standard imposto, non negoziabile), contrasto
  ≥4.5:1 calcolato sulla luminanza del fondo **composito**, non della tinta pura —
  l'errore già pagato quando il gate del contrasto ignorò l'`opacity`.

## Decisione 5 — Contenuto della tessera: l'icona dove parla, il nome dove serve

| Caso | Tessera chiusa |
|---|---|
| Progetto **con** favicon/manifest | **solo icona**, nessun titolo |
| Progetto **senza** icona | nome troncato (mai un monogramma sintetico) |
| Chat / terminale / browser | icona di tipo + nome troncato |

La riga «solo icona reale o zero ingombro» resta in piedi: non si inventano placeholder.
Per una chat il titolo *è* l'identità — toglierlo lascerebbe quattro icone-chat identiche,
che è il contrario del punto.

**Il nome accessibile non sparisce mai.** La tessera è `role="treeitem"` con
`aria-label={item.name}` anche quando mostra la sola icona: serve agli screen reader e
tiene in piedi `sidebar.spec.ts`, che cerca
`getByRole("treeitem", { name: /…/ })` **dentro** `getByTestId("sidebar-pinned-section")`.

## Decisione 6 — L'espansione si inserisce fra le righe, non in fondo

Le righe si renderizzano in sequenza; dopo ogni riga, se una o più tessere di *quella*
riga sono aperte, si inserisce la fascia. È letteralmente «sotto la riga dove si trova il
progetto».

```
riga 0   [icon][icon][icon][icon]
  └── fascia della tessera 2 aperta  ← qui, non in fondo
riga 1   [icon][icon]
```

Con più tessere aperte le fasce condividono l'altezza della sezione: contenitore a
`display:flex; flex-direction:column; max-height: 60%` della sidebar, ogni fascia
`flex: 1 1 0` con scroll proprio. Le tessere chiuse mantengono la loro riga e si
riadattano.

**Contenuto della fascia**: per un progetto, `item.children` — chat, terminali, browser —
renderizzati con `renderItem` esistente. Zero renderer nuovi, zero divergenza dalle righe
dell'albero.

**Stato aperto**: transitorio, in `useState` del componente. Non persiste. Riaprire l'app
non ti deve trovare mezza sidebar già espansa; il layout sì che persiste, l'espansione no.

## Decisione 7 — Un componente, quattro siti

`TopicTree` chiama `<PinnedTiles items={pinnedBlock} …/>` nei 4 rami
(`:999`, `:1033`, `:1052`, `:1071`), che oggi ripetono header + `.map(renderItem)`.

**Cosa si perde, dichiarato**: nei modi *grouped* e *state* il blocco fissati era una
`renderSection` collassabile con conteggio e badge aggregato delle notifiche
(`TopicTree.tsx:889-927`). Senza intestazione spariscono collasso, conteggio e badge
aggregato. È accettato: il badge aggregato esisteva perché la sezione poteva essere
chiusa e nascondere il non-letto — a tessere non si nasconde niente, e ogni tessera porta
il suo badge. Il collasso serviva a recuperare verticale, che è esattamente ciò che le
tessere restituiscono.
