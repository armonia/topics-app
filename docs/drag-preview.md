# Cosa si vede mentre trascino

Documento breve accanto al contratto (`client/src/lib/dragPreview.ts`). Serve a
non ripagare, al dodicesimo punto di drag, una lezione gia' pagata due volte.

## La segnalazione da cui nasce

«All'interno di un progetto non si riesce a fare bene il drag and drop fra
tabbar splittate: e' difficile fare il drop perche' non c'e' nessuna anteprima.
Dovrebbe esserci l'anteprima completa della carta, in tutti quanti i casi in cui
andiamo a fare un drag and drop posizionale.»

La meccanica del rilascio era gia' a posto. Quello che mancava e' il riscontro
durante il gesto: non si vedeva **cosa** si stava portando, ne' **dove** sarebbe
atterrato. Senza quei due segni il rilascio si azzecca a tentativi, ed e' per
questo che la segnalazione dice «e' difficile fare il drop» e non «il drop non
funziona».

## Perche' in WKWebView non si fotografa un nodo fuori schermo

Il modo classico di dare un'immagine al trascinamento e' `setDragImage(nodo)`:
il motore fotografa quel nodo del DOM. Il trucco altrettanto classico e'
costruire la pillola a `left:-9999px`, fotografarla, e buttarla via.

**Nella WKWebView del guscio (Tauri su macOS, e Safari) quella fotografia torna
VUOTA.** Il motore fa lo snapshot dal layer di composizione, e un nodo fuori dal
viewport visivo non ha nulla da comporre. Il sistema allora ripiega sull'icona
generica di documento di macOS: e' la segnalazione «la tab sembra un file mentre
la trascino». Su Chromium lo stesso codice funziona benissimo, quindi il difetto
esiste solo dove l'app viene davvero usata, e una suite che gira solo su
Chromium resta verde mentendo.

Da qui le due conseguenze che governano tutto il resto:

1. **il nodo di anteprima dev'essere sullo schermo**, alla posizione del
   cursore, nel momento in cui viene consegnato a `setDragImage`;
2. **una asserzione su Chromium non basta**: la stessa va ripetuta nel motore
   WebKit, che e' quello del guscio.

## Come e' fatta l'anteprima

Un nodo vero, vivo, alla posizione del cursore, per tutta la durata del gesto.
Serve due volte:

- e' la sorgente di `setDragImage` (essendo dentro il viewport, la fotografia
  riesce anche in WKWebView);
- **resta li' e segue il puntatore**, con lo STESSO punto di presa passato a
  `setDragImage`. Il fantasma disegnato dal sistema e la nostra scheda si
  sovrappongono per costruzione: dove il sistema disegna, sotto c'e' la stessa
  cosa. Non si vede doppio, e dove il fantasma di sistema non esiste affatto
  (iOS: il drag HTML5 non c'e', il gesto e' un long press) l'anteprima si vede
  lo stesso.

Il secondo punto e' anche l'unico modo di PROVARLO. Il fantasma del sistema lo
disegna il compositor, non il documento: nessun test potra' mai vederlo. Un nodo
nel DOM si', e infatti l'anteprima si marca con `data-drag-preview`.

## Il contratto, in un posto solo

`client/src/lib/dragPreview.ts`. Prima la scelta era replicata in undici
`onDragStart` diversi, ognuno con la sua idea: chi una pillola, chi la riga
fotografata, chi niente. Un comportamento deciso in undici posti diverge, e il
modo in cui diverge era esattamente questo.

| Cosa | Chi | Nota |
| --- | --- | --- |
| `startDragPreview(e, spec)` | chiamata nel `dragstart`, dopo le `setData` | monta la scheda al cursore e la consegna a `setDragImage` |
| `startTouchDragPreview(spec, x, y)` + `moveDragPreview(x, y)` | il gesto col dito | qui non c'e' nessun fantasma di sistema: questo nodo e' l'UNICA anteprima |
| `endDragPreview()` | fine gesto | idempotente: le porte di spegnimento sono cinque perche' `dragend`/`drop` non sono garantiti nella WKWebView |
| `data-drag-preview` | l'attributo sul nodo | uno solo, e non ce n'e' mai piu' di uno alla volta |
| `data-drop-active` | il BERSAGLIO, mentre il puntatore ci passa sopra | valori `into` / `before` / `after` / `split` |

L'anteprima e' la **scheda intera**, non un'etichetta: `title` (il nome della
cosa), `subtitle` (il contesto: percorso, progetto, colonna, URL), `badges`
(stato, tipo, conteggi), `icon`, `accent`. Chi trascina deve riconoscere la cosa
che ha in mano.

## Il bersaglio si dichiara

Meta' della segnalazione era l'anteprima, l'altra meta' e' questa. Una superficie
che accetta il rilascio si marca con `data-drop-active` mentre il puntatore ci
passa sopra, e il disegno sta in `client/src/index.css` in UNA regola sola: una
superficie nuova si dichiara aggiungendo un attributo, non ricopiando uno stile.

I quattro valori non sono lo stesso atterraggio:

- `into` il rilascio entra DENTRO il bersaglio (un gruppo, una colonna);
- `before` / `after` si inserisce accanto (riordino posizionale);
- `split` taglia il bersaglio in due (i bordi di una griglia).

## Le superfici trascinabili, e cosa mostra ciascuna

Undici file hanno un `onDragStart`. Questa e' la lista, con cosa deve mostrare
ciascuno. La colonna «adottato» dice se quel punto passa gia' dal contratto:
oggi nessuno lo fa ancora, il contratto e' appena nato ed e' il lavoro che
resta.

| Superficie | File | L'anteprima mostra | Adottato |
| --- | --- | --- | --- |
| Tessera di tab bar (anche fra split) | `components/Layout/PaneTabBar.tsx` | titolo della tab, sottotitolo col progetto, badge del tipo | no |
| Bordi della griglia dei pannelli | `components/Layout/PanelGrid.tsx` | la scheda del pannello trascinato, intento `split` | no |
| Pannello di chat | `components/Layout/ChatPanel.tsx` | titolo della chat, ultimo messaggio come sottotitolo | no |
| Gruppo di pannelli | `components/Layout/GroupLayout.tsx` | nome del gruppo, conteggio dei pannelli come badge | no |
| Gruppo di chat isolato | `components/Layout/StandaloneChatGroup.tsx` | nome del gruppo, conteggio come badge | no |
| Voce dell'albero dei topic | `components/Sidebar/TopicItem.tsx` | titolo del topic, percorso come sottotitolo, icona | no |
| Albero dei topic (contenitore) | `components/Sidebar/TopicTree.tsx` | come sopra, piu' l'intento `into` sui rami | no |
| Tessera fissata | `components/Sidebar/PinnedTile.tsx` | titolo, icona, progetto come sottotitolo | no |
| Griglia delle tessere fissate | `components/Sidebar/PinnedTiles.tsx` | come sopra, intento `before`/`after` | no |
| Card della board kanban | `components/Board/KanbanBoardPane.tsx` | titolo della card, colonna come sottotitolo, stato e priorita' come badge | no |
| File explorer | `components/Project/FileExplorer.tsx` | nome del file, percorso come sottotitolo, icona del tipo | no |

## Come si verifica

Due guardie, e nessuna delle due esiste ancora: sono il lavoro che resta,
tracciato sulle carte figlie della segnalazione.

La prima e' **statica**: ogni file con un `onDragStart` deve importare il
contratto, e chi e' esente lo dichiara con la ragione scritta accanto. E' quella
che impedisce al dodicesimo punto di drag di nascere muto, ed e' l'unica difesa
contro il ritorno del problema originale, che non era un bug ma una scelta
replicata in undici posti.

La seconda e' **E2E**, e va fatta girare in due motori: `chromium` e `webkit`.
Iniziato il trascinamento esiste un nodo `[data-drag-preview]` visibile e porta
il testo della cosa trascinata; passando sopra un bersaglio valido, quello si
marca `[data-drop-active]`. La stessa asserzione ripetuta nel motore WebKit non
e' zelo, e' il punto: e' li' che lo snapshot torna vuoto, ed e' li' che l'app
viene usata. Una suite che gira solo su Chromium resta verde mentendo.

La seconda ora esiste: `tests/e2e/drag-preview.spec.ts`, quattro test su tre
superfici, e il progetto `webkit` di `playwright.config.ts` la ripete nel motore
del guscio.

## La prova che sa diventare rossa

Verde e' un'informazione debole finche' nessuno mostra il rosso. Le tre
promesse del contratto sono state rotte una alla volta, ricostruendo il bundle
e rigirando la spec nei DUE motori; poi il file e' stato ripristinato e la
misura rifatta. Il comando e' sempre lo stesso:

```
bun run build:client
npx playwright test drag-preview --project=chromium --project=webkit --retries=0
```

| Mutazione | Dove | Chromium | WebKit |
| --- | --- | --- | --- |
| nessuna (riferimento) | - | 4 verdi | 4 verdi |
| l'anteprima non porta il NOME della cosa presa (titolo fisso) | `lib/dragPreview.ts`, `costruisci` | 3 rossi | 3 rossi |
| l'anteprima non si SPEGNE a fine gesto (niente `remove()`) | `lib/dragPreview.ts`, `endDragPreview` | 3 rossi | 3 rossi |
| il BERSAGLIO non si dichiara (via `data-drop-active` dalla card del gruppo) | `Sidebar/SpaceGroups.tsx` | 2 rossi | 2 rossi |

Ogni mutazione cade in entrambi i motori, e cade citando la promessa rotta: «e
porta il nome della cosa presa», «a gesto finito l'anteprima sparisce», «il
bersaglio si dichiara con uno fra into». Nessuna passa in un motore e cade
nell'altro: non c'e' asserzione che stia in piedi solo grazie a Chromium.

Quello che le mutazioni dicono ANCHE, ed e' la parte che serve a chi tocchera'
il codice dopo:

- **DPREV-04 (la board) non passa da `lib/dragPreview`.** Le prime due
  mutazioni non la sfiorano, perche' li' la scheda la disegna il `DragOverlay`
  di dnd-kit e il contratto si adotta MARCANDO quel nodo. E' scritto nel
  commento della spec, e la mutazione lo conferma sul campo.
- **Il bersaglio e' una promessa PER SUPERFICIE.** La terza mutazione tocca una
  sola card e infatti abbatte solo i due test che la usano: nessuna superficie
  copre le altre, e una superficie nuova che nascesse muta non farebbe rossa
  nessuna di queste righe. E' esattamente il buco che la guardia STATICA qui
  sopra deve chiudere.
- **Le costanti del contratto non sono importate dalle superfici**:
  `DRAG_PREVIEW_ATTR` e `DROP_ACTIVE_ATTR` esistono in `lib/dragPreview.ts`, ma
  chi marca il DOM scrive la stringa a mano (`data-drop-active={...}` in sei
  file). Rinominare la costante non muove niente: il legame regge perche' il
  test unitario del contratto confronta le costanti con le regole di
  `index.css`, non perche' il codice le usi.
