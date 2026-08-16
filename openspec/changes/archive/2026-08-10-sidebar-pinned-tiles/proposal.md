## Why

Il blocco **Fissati** della sidebar oggi è una lista verticale identica a tutte le altre:
stesse righe piene, stesso ingombro, distinta solo da un'intestazione testuale. Costa
un'etichetta e una riga intera per elemento, e non guadagna niente in riconoscibilità —
sono proprio gli elementi che hai dichiarato «questi li voglio sempre sotto mano» a
essere i meno distinguibili a colpo d'occhio.

Stato verificato nel codice:

- **L'intestazione è scritta 4 volte**, una per modo di vista:
  `TopicTree.tsx:999-1008` (gruppi), `:1033-1044` (timeline), `:1052-1056` (grouped),
  `:1071-1075` (state). Due passano da i18n (`sidebar.pinnedSection` → «Fissati»/«Pinned»,
  `i18n.ts:139,251`), due hanno la stringa **hardcoded** dentro
  `renderSection('pinned', Pin, 'Fissati', …)`.
- **Ogni fissato è una riga piena a tutta larghezza**: i 4 siti fanno
  `pinnedBlock.map(item => renderItem(item))` (`TopicTree.tsx:1005,1039,1054,1073`) —
  lo stesso renderer delle righe normali. 8 fissati = 8 righe = mezza sidebar.
- **L'icona reale del progetto esiste già** (`ProjectFavicon` → `GET /api/projects/icon`)
  ed è già usata nella riga progetto (`TopicTree.tsx:739`), ma resta un dettaglio
  accanto al titolo invece di essere l'identità dell'elemento.
- **Non esiste alcun layout dei fissati**: `pinnedItems` è un array piatto in ordine di
  pin (`useSidebarState.ts:82`). Non c'è modo di dire «questi quattro sulla prima riga».
- **Un progetto ha due chiavi di pin diverse** a seconda di dove lo fissi: la sidebar
  scrive il path grezzo (`buildSidebarItems.ts:509,544`), la tab bar quello codificato
  (`pinKeyForPane` → `pane.id`, `paneConfig.ts:158-171`). Oggi il danno è silenzioso — un
  progetto fissato dalla tab non compare fra i Fissati, e lo stesso progetto può stare
  due volte in `pinnedItems`. Con un layout indicizzato per chiave diventerebbe
  permanente: celle che non si risolvono mai.

## What Changes

Il blocco Fissati diventa una **griglia di tessere illuminate**, con la stessa grammatica
delle pinned tab di Dia: chiuse stanno affiancate e si riconoscono dal colore, aperte si
espandono in una fascia sotto la loro riga.

1. **Via l'etichetta.** Nessuna intestazione testuale, in nessuno dei 4 modi di vista. La
   griglia di tessere in cima *è* l'indicazione: il pin si vede, non si annuncia. Le
   chiavi i18n `sidebar.pinnedSection` vengono rimosse (`sidebar.pinned`, il titolo del
   marcatore sulla singola riga, **resta**: serve all'accessibilità).
2. **Tessera al posto della riga.** Un fissato chiuso è una tessera quadrata affiancata
   alle altre. Contenuto: **l'icona reale del progetto** dove esiste, senza ripetere il
   titolo; dove l'icona non esiste, il nome troncato. Nessun monogramma sintetico —
   la regola «solo icona reale o zero ingombro» resta in piedi.
3. **Illuminate.** Ogni tessera porta una tinta derivata dalla sua icona (colore
   dominante campionato una volta e messo in cache) su fondo scuro, con un alone morbido:
   il bagliore è **identità**, si riconosce il progetto senza leggerlo. La **corona
   rotante resta riservata a «sta lavorando»** — i due segnali non si pestano, ed è
   esattamente la separazione che [[project_working-aura-strict-signal]] ha già pagato una
   volta.
4. **Righe componibili in drag & drop.** Trascinando una tessera scegli **su quale riga**
   sta e **quante ce ne stanno**: le tessere della riga di destinazione si stringono in
   diretta mentre trascini, così vedi la misura finale prima di lasciare. Una zona di drop
   sotto l'ultima riga crea una riga nuova. Nessun controllo separato per «quante per
   riga»: il numero *è* il contenuto della riga.
5. **Espansione sotto la riga.** Il click su una tessera apre una fascia a tutta larghezza
   **subito sotto la riga in cui la tessera si trova** — non in fondo alla sezione. Per un
   progetto la fascia contiene le sue tab (chat, terminali, browser): gli stessi figli che
   oggi vedi annidati nell'albero, con lo stesso renderer. Con più tessere aperte, le fasce
   si dividono l'altezza della sezione e le tessere chiuse si riadattano.
6. **Il layout viaggia col pin.** Nuovo campo `pinnedLayout` in `SidebarState`: sale sulla
   pipeline che i fissati già percorrono (localStorage + `ui-state` sul server + WS +
   cross-tab), quindi la disposizione ti segue da un device all'altro come i pin stessi.
7. **Il pin torna una scorciatoia, non un lucchetto** (Attilio, 06/08): una tab fissata
   **si chiude** come tutte le altre, resta fissata, e la sua tessera la riapre — finché
   non togli il pin. Rovescia la regola del 03/08 (`ee55a33f`). Regge perché il ritiro non
   cancella niente: la chat si archivia chiudendo, ma l'escape `pinnedIds` tiene la tessera
   anche archiviata e riaprirla disarchivia. `isPaneClosable` sparisce, e con lei la
   guardia sull'azione in `App.tsx`.
8. **Due precondizioni, non opzionali.** (a) La chiave di pin dei progetti si unifica sulla
   forma grezza, con migrazione e dedup al caricamento. (b) La scrittura di `sidebar-state`
   passa a CAS (`?base=<server_seq>` + retry sul 409): il server lo supporta già
   (`ui-state.ts:283-328`), e con un layout dentro una scrittura persa non costa più un
   pin ma l'intera disposizione — che è esattamente come i pin andarono persi la prima volta.

Non-goal: toccare cosa *entra* nei fissati (il pin resta il pin), la vista non-fissata
della sidebar, i Gruppi/Spazi, o il comportamento di drag della sidebar verso la griglia
dei pane — quest'ultimo va **preservato** (vedi Risks).

## Impact

- **Codice**: `TopicTree.tsx` (4 siti di render → 1 componente), nuovo
  `components/Sidebar/PinnedTiles.tsx` + `PinnedTile.tsx`, nuovo modulo puro
  `lib/pinnedLayout.ts` (che riusa `components/Layout/gridWidths.ts`, non riscrive la
  matematica delle larghezze), `hooks/useSidebarState.ts` (+1 campo, +migrazione, +CAS),
  `state/pane/adapters/paneConfig.ts` (chiave di pin), `lib/dndTypes.ts` (+1 tipo),
  `lib/i18n.ts` (−2 chiavi), nuovo `lib/iconTint.ts`.
- **Dati**: nessuna migration SQL. `pinnedLayout` è un campo in più dentro il payload
  `ui-state:sidebar-state` già esistente; i client vecchi lo deserializzano come assente e
  ricadono sul wrap automatico.
- **Test esistenti da non rompere**: `tests/e2e/sidebar.spec.ts` («Fissati») e
  `spaces-switcher.spec.ts:356` interrogano `getByTestId("sidebar-pinned-section")` e
  cercano dentro `getByRole("treeitem", { name: /…/ })`. Il testid **resta** sul contenitore
  della griglia e la tessera **resta un `treeitem` con nome accessibile** anche quando
  mostra la sola icona.
