# Tasks — pane-zoom

T0 e' un cancello: se cade, cade il disegno, e va fatto prima di scrivere codice.
T1 e T2 partono insieme dopo l'approvazione. T3 aspetta T1 e T2. T4 e T5 aspettano
T3 e sono indipendenti fra loro. T6 e' indipendente da tutto e puo' partire subito.
T7 aspetta T3, T4, T5. Ogni traccia atterra con la sua prova; «fatto» senza la
prova non e' fatto.

Un avviso trasversale: la cucitura delle chord native sta in DUE task, 3.5 e
3.11, e tocca DUE sponde che non si somigliano. Su Windows la decisione e' una
funzione pura gia' coperta da `cargo test --lib` (`chords::decide`), e questa
change la CAMBIA: il suo test va aggiornato perche' AFFERMI il cambio, non
lasciato verde perche' non nomina la chord nuova. Sul Mac la decisione e' invece
TAGLIATA IN DUE, ed e' la lettura che il giro precedente sbagliava:
`app_chord_dispatch_js` (lib.rs:8460) e' una `fn` senza una sola chiamata AppKit
nel corpo, `#[cfg(target_os = "macos")]`, quindi sulla macchina di sviluppo la
compila e la esegue lo stesso `cargo test --lib`; saldata dentro il monitor
NSEvent e' solo la meta' che le passa gli argomenti, cioe' l'estrazione di
`modifierFlags` (lib.rs:8600-8606), e QUELLA la prova solo il video di 7.7. Il
commento di testa di `chords.rs` (:4-13) dice «nothing of it is covered by a
test», ed e' vero della fotografia di oggi, non di cio' che e' possibile: e' una
constatazione, non un muro, e 3.11 la fa scadere.

## Come si dichiara la copertura (vale per ogni test di questa change)

Due canali, e si usano ENTRAMBI: non si sostituiscono a vicenda.

- **`@covers LAYOUT-34, LAYOUT-40` nel commento di testa del file.** Granularita'
  FILE, e non e' una dichiarazione di serie B: per un file Playwright che passa
  INTERO vale come prova, ed e' esattamente la ragione per cui
  `readPlaywrightOutcomes` esiste (check-spec-coverage.ts:355-367, «has the same
  evidential force as one declared by a green unit file: per file, not per
  requirement»).
- **`test.info().annotations.push({ type: "spec", description: "LAYOUT-34" })`
  dentro OGNI scenario.** E' l'unico canale che porta un esito PER REQUISITO
  (check-spec-coverage.ts:225-227: «A `@covers` names a FILE, and a file holds
  many tests, so it is evidence of a link, never evidence that the requirement
  passed»). Ed e' la convenzione gia' in casa, non una tassa nuova.
- Nei file `bun test` esiste solo il primo: `test.info()` non c'e'.
- **Un test Rust prova ma non dichiara.** Le radici che il cancello percorre sono
  `tests`, `client/src`, `server`, `shared`, `relay`, `cli`, `scripts`
  (check-spec-coverage.ts:74): `desktop-tauri/` non c'e', quindi nessun
  `#[test]` colora niente, e vale per tutti e tre quelli che questa change tocca o
  aggiunge. Il canale di dichiarazione sta altrove ed e' diverso per i due
  requisiti: `LAYOUT-41` lo dichiara il `@covers` di `shared/shortcuts.test.ts`
  (3.5), `LAYOUT-40` le annotazioni per scenario degli e2e di 7.2. I due
  `cargo test --lib` (3.5 e 3.11) sono la prova che ci sta sotto, e non vanno
  spacciati per la dichiarazione.
- L'id va scritto ESATTO, nella forma `/^[A-Z][A-Z0-9-]*-\d+[a-z]?$/`. Un'annotazione
  con un id fuori forma non dichiara niente, non colora niente nel living-doc e
  passa in silenzio ENTRAMBI i cancelli: e' R7, nove casi misurati su cinque file
  (check-spec-coverage.ts:185-198). Gli id del delta remote-browser oggi sono
  `NATIVEPARK-01` e `NATIVEPARK-02`: si rileggono da
  `specs/remote-browser/spec.md` di questa change prima di scriverli, non si
  ricopiano da qui se quel file nel frattempo si e' mosso.

## T0 — La verifica che puo' invalidare il disegno (nessun codice)

- [ ] 0.1 Guscio Tauri, build corrente. Layout a 3 celle, una pane browser nativa
  su una pagina riconoscibile in una cella che verra' collassata. Portare la cella
  a `display:none` a mano (devtools) e provare le CINQUE vie che chiamano
  `applyBounds` senza passare dal placeholder, che sono le cinque che
  `NATIVEPARK-01` nomina: `thaw()` (useTauriBrowser.ts:581, aprire e chiudere un
  menu sopra la superficie), `setDevice` (:1611), il riconcilio UA (:1644), il
  ridimensionamento responsive (`setResponsiveSize`, :1656) e la stretta di mano
  di `recreate` (:1722).
  **Prova**: registrazione dello schermo in cui la webview NON ricompare sopra
  l'area collassata in nessuna delle cinque, oppure, se ricompare, il conteggio
  di quali. Il risultato atteso oggi e' che ricompaia: e' la ragione per cui T2
  esiste.
- [ ] 0.2 Stesso banco, caso composto: cella collassata + agente che guida quella
  browser (`agentActive`) + un menu aperto e chiuso sopra la cornice.
  **Prova**: video. Se qui la vista resta parcheggiata anche senza chiavistello,
  T2 si riduce; se ricompare, T2 e' obbligatorio come scritto.

## T1 — I moduli puri (nessun innesto, nessun rendering)

- [ ] 1.1 `client/src/components/Layout/paneZoom.ts`: `applyZoomWeights(root, cellKeys)`,
  `cellKeysForPanes(rows, itemMap, paneIds)` **estratta** da `mobileVisibleKey`
  (PanelGrid.tsx:474-487, risalita da pane impilata compresa), `pruneZoom(keys, liveKeys)`.
  Stessa ref quando nulla cambia, convenzione di `soloCells.ts` (`pruneSoloCells`,
  soloCells.ts:135).
- [ ] 1.2 `client/src/components/Layout/zoomScope.ts`: `resolveZoomAnchor(paneId, deps)`,
  `computeZoomPaneIds(anchor, deps)`, `resolveZoomCells({ anchorPaneId, scope }, deps)`
  con `scope: 'derived' | 'cell'`, e `resolveEntryScope(paneId, requested, deps)`.
  Tutto iniettato (`openPanes`, `topics`, `terminals`, mappa spawner): niente import
  di store dentro il modulo.
  Le ultime due NON sono la stessa funzione, e la differenza e' il cuore di D4 e
  D12. `resolveZoomCells` e' pura e gira a OGNI render: dato uno scope lo
  traduce in celle (`derived` risolve `cellKeysForPanes(computeZoomPaneIds(...))`,
  `cell` risolve `cellKeysForPanes([anchorPaneId])`), ed e' un `if` dentro il
  memo, non un secondo percorso. La degradazione li' dentro non ci sta: girando a
  ogni render farebbe cambiare l'ambito sotto le mani ogni volta che una pane si
  apre o si chiude. `resolveEntryScope` gira UNA volta, al gesto: riceve l'ambito
  chiesto (`'cell'` col modificatore, `'derived'` senza), confronta il set derivato
  con le celle vive e, se lo copre gia' tutto, torna `'cell'`; torna `null` quando
  esiste una cella viva sola, cioe' quando il gesto non si offre. Il suo esito e'
  cio' che lo store memorizza, ed e' l'unico posto in cui la degradazione esiste.
- [ ] 1.3 `client/src/state/paneZoom.ts`: store zustand effimero,
  `bySurface: Record<string, { anchorPaneId: string; scope: 'derived' | 'cell'; openedSeq: number }>`,
  `toggle(surfaceId, paneId, scope)` / `exit` / `exitTop`, docstring che dichiara
  «EPHEMERAL, never persisted» e che l'uscita al cambio di Spazio e' VOLUTA.
  `scope` e' l'ambito fissato all'INGRESSO, non un interruttore di modalita': un
  `toggle` sulla stessa ancora ESCE, qualunque scope porti, e due `toggle` con
  scope diversi sulla stessa superficie lasciano UN record, mai due. Lo stato
  resta uno solo; quali celle rivelare lo decide `resolveZoomCells` a valle, sullo
  scope memorizzato.
  Un `cellOnly: boolean` al suo posto non e' un nome diverso per la stessa cosa:
  `cellOnly` nomina il TASTO, `scope` nomina l'ESITO. Nel caso degradato il tasto
  non e' stato premuto e l'ambito e' comunque la sola cella, quindi un booleano
  che si chiama come il modificatore o mente sul record o costringe a ricalcolare
  la degradazione a ogni render, che e' esattamente cio' che D4 vieta.
  L'invariante che ne discende e va tenuto vero fino all'e2e: entrando in caso
  degradato lo scope memorizzato e' `'cell'`, quindi una browser che l'agente apre
  dopo NON entra nel set, quindi scatta la regola di uscita di 3.10 e nessuna pane
  nasce dentro una cella collassata. E' lo scenario «una tab che nasce mentre si
  guarda la sola cella» di LAYOUT-40, e con un booleano ricalcolato sarebbe falso.
- [ ] 1.4 `paneZoom.test.ts`, `zoomScope.test.ts` e `client/src/state/paneZoom.test.ts`,
  header `@covers LAYOUT-34, LAYOUT-35, LAYOUT-36, LAYOUT-37, LAYOUT-40`.
  In `zoomScope.test.ts` i casi stanno separati perche' separate sono le funzioni.
  Su `resolveZoomCells`: con `scope: 'cell'` la sola cella dell'ancora e set
  derivato ignorato; con `scope: 'derived'` le celle del set; e con
  `scope: 'derived'` e set derivato = tutte le celle vive di nuovo TUTTE, perche'
  li' dentro la degradazione non abita, ed e' questo caso a provarlo.
  Su `resolveEntryScope`: chiesto `'derived'` con almeno una cella viva fuori dal
  set torna `'derived'`; chiesto `'derived'` con set derivato = tutte le celle
  vive torna `'cell'`, che e' la degradazione provata dove si decide; chiesto
  `'cell'` torna `'cell'` comunque; con una cella viva sola torna `null` in tutti
  e due i casi, cioe' gesto non offerto, che e' lo stesso caso in cui `canZoom`
  e' falso (3.9). Nello store: `toggle` due volte sulla stessa ancora esce anche
  cambiando scope, due `toggle` con scope diversi lasciano un record solo, e
  `exitTop()` torna falso a mani vuote.
  **Prova**: `bun test client/src/components/Layout/paneZoom.test.ts client/src/components/Layout/zoomScope.test.ts client/src/state/paneZoom.test.ts`
  verde, e ogni test falsificato una volta togliendo la riga che copre (un test che
  non si e' mai visto rosso non e' un cancello).
- [ ] 1.5 `mobileVisibleKey` riscritta sopra `cellKeysForPanes`: una conversione
  sola, non tre.
  **Prova**: `npx playwright test tests/e2e/mobile-*.spec.ts` (o il perimetro
  enumerato dai testid toccati) verde senza modifiche.

## T2 — Il chiavistello nel guscio nativo (dipende da T0)

- [ ] 2.1 `useTauriBrowser.ts`: un `hiddenRef` alzato nel ramo zero di `setBounds`
  (:449-458) e abbassato SOLO dal ramo positivo (:446-448), che e' l'unica porta
  che misura sul segnaposto. Si legge in DUE posti, perche' due sono le meta' di
  `NATIVEPARK-01`: in cima ad `applyBounds` (:399), cosi' la funzione esce sul
  guardiano gia' esistente `if (!slot || !openedRef.current) return` (:405) e
  nessuna via puo' rimettere la vista a schermo; e nella lettura dello slot di
  `evaluateOcclusion` (:608), dove `liveSlotRect(id) ?? pendingRectRef.current`
  a chiavistello chiuso deve valere `null` invece del rect stantio, o la
  decisione di congelamento continuerebbe a prendersi sulla geometria che la
  cella aveva PRIMA. La prima meta' impedisce il ritorno, la seconda toglie la
  bugia su cui si decideva: nessuna delle due copre l'altra.
  L'altra strada che sembrava equivalente, cioe' azzerare `pendingRectRef.current`
  nel ramo zero, NON soddisfa il requisito e va scartata qui invece di essere
  offerta come alternativa: `animateBounds` scrive `pendingRectRef.current = b`
  a :480 senza passare dal segnaposto, quindi il rect di riserva puo' tornare
  scritto da una via che non sa niente del box della cella. Il chiavistello va
  tenuto da una sua ref, non dedotto dall'assenza di un valore che qualcun altro
  riempie. (Che `animateBounds` non possa APRIRLO e' invece gia' vero: a :479
  rifiuta ogni rettangolo non positivo, che e' la meta' della regola gia' in
  casa.)
  E' comportamento della capability remote-browser, non del layout: quello che
  deve fare sta scritto in `NATIVEPARK-01` del delta `specs/remote-browser/spec.md`
  di questa change, ed e' l'id che il test di 2.2 deve dichiarare.
- [ ] 2.2 `client/src/hooks/useTauriBrowser.park.test.ts`, sulla convenzione del
  gia' esistente `useTauriBrowser.polls.test.ts`: test unitario della transizione,
  header `@covers NATIVEPARK-01`. Il path si scrive QUI perche' e' il quinto dei
  cinque file di test nuovi che il proposal conta nell'Impact, ed e' quel conto che
  `check:untraced-tests` deve far tornare: un task che dice «un test unitario»
  senza dire dove lascia il conto aperto. Dopo un park, sono no-op sulla geometria
  una chiamata diretta ad `applyBounds` e tutte e CINQUE le vie di ritorno che il
  requisito nomina: `thaw` (:581), `setDevice` (:1611), il riconcilio UA (:1644),
  `setResponsiveSize` (:1656) e la stretta di mano di `recreate` (:1722). Si asserisce contando i comandi di geometria inviati
  alla vista, non guardando lo schermo. La quinta e' quella che mancava, e una via
  non provata e' una via che torna.
  Poi: `decideFreeze(null, rects)` con overlay presenti torna `true`
  (browserOcclusion.ts:195) e il freeze in piu' e' innocuo; e il primo rettangolo
  positivo riapre il chiavistello, rimette la vista esattamente li' e fa cadere
  con la stessa chiamata il guasto dichiarato mentre la cella era collassata
  (`recordPaneOk` su `browser_set_bounds` dentro `paneInvoke`, il commento a
  :1706-1710 dice perche' e' quella la sola prova che qualcosa e' cambiato).
  **Prova**: `bun test client/src/hooks/` verde, col test visto rosso rimuovendo
  il `hiddenRef`.
- [ ] 2.3 `Browser/RemoteBrowserPanel.tsx:164`: `const isVisible = isVisibleProp && usePaneAlive()`.
  La riga e' GLOBALE e raggiunge il cassetto del task
  (`Board/useTaskBrowserGroupLayout.tsx:258/267`): una browser del cassetto dietro
  una pane kanban nascosta passa da `isVisible=true` a `browser_set_visible(false)`.
  Non e' un effetto collaterale da annotare a margine: e' il comportamento che
  `NATIVEPARK-02` dichiara, quindi si legge di li' e si prova. La meta' di layout
  di quel cambio, cioe' che un guscio ANTENATO nascosto propaghi l'assenza di box
  invece di fermarsi alla tab attiva del proprio gruppo, sta in `LAYOUT-38` e si
  ottiene da 3.2 e 5.1.
  **Prova**: nessuna regressione su `tests/e2e/browser-*.spec.ts`; il caso e2e sul
  cassetto in 7.1, annotato `NATIVEPARK-02` e `LAYOUT-38`; e la verifica a mano che
  la vista sia SPENTA, non solo a bounds zero.

## T3 — L'innesto sulla griglia standalone (dipende da T1, T2)

- [ ] 3.1 `PanelGrid.tsx`: memo `zoomedTree` a valle di `treeRoot` (:2502);
  `data-pane-zoom` sulla superficie (:2667); scrim e stage **incondizionati**;
  `style.display` e prop `hasBox` nel wrapper di cella di `renderTreeLeaf`
  (:2561-2588, dentro il callback che sta a :2539-2590); effetti di potatura, di
  uscita su fuoco-altrove, e `exit(surfaceId)` allo smontaggio;
  `notifyPaneReflow()` sulle transizioni; `onResize`/`onEqualize` non passati
  mentre zoomato. Le celle da rivelare arrivano da `resolveZoomCells` chiamata
  sullo scope MEMORIZZATO: qui non si riscrive nessuna regola di ambito e non si
  ricalcola nessuna degradazione. L'effetto di uscita su apertura di una pane
  fuori set NON sta qui: sta in 3.10, da solo, perche' e' l'unico bivio ancora
  aperto.
- [ ] 3.2 `StandaloneChatGroup.tsx`: prop `hasBox` (default `true`);
  `<PaneAliveContext.Provider value={surfaceAlive && hasBox}>` attorno al SOLO
  loop dei `PaneKeepAlive` (:966-981); `visibleKeys` INVARIATO (:409-413).
- [ ] 3.3 D8: split, reset, «Disponi», i bus `topics:reset-split-layout` e
  `topics:auto-tile-layout`, l'undo di layout e l'avvio di un drag di tab chiamano
  `exit(surfaceId)` prima di applicarsi.
- [ ] 3.4 `PaneTabBar.tsx`: il doppio clic prende l'EVENTO (l'handler a :1257 oggi
  e' `() => {...}`, senza argomento) e diventa stratificato: `markDraftTouched`,
  `return` sul ramo anteprima, poi
  `onToggleZoom?.(pane.id, e.altKey ? 'cell' : 'derived')`; `canZoom` falso sulle
  bozze. ⌥ e' libero sulla linguetta: in tutto il file non compare nessun `altKey`
  e l'unico `onDoubleClick` e' quello di :1257. Nel menu contestuale (:1997-2019,
  sezione degli split, sopra «Dividi a destra») DUE voci: «Ingrandisci» / «Riduci»
  con lo stato riflesso, e «Ingrandisci solo questa».
  Le due voci restano ENTRAMBE ogni volta che il comando esiste, caso degradato
  compreso, dove fanno la stessa identica cosa. Farne sparire una li' vorrebbe
  dire far dipendere il contenuto del menu dal set derivato, che e' proprio
  l'insieme che l'utente non ha modo di vedere: e' il difetto che D4 toglie,
  rimesso dentro in piccolo. L'unico posto dove il menu si accorcia e' lo zoom
  GIA' attivo, dove resta la sola «Riduci» (LAYOUT-40).
  Props `onToggleZoom(paneId, scope)` / `canZoom` / `isZoomed`; il predicato arriva
  da 3.9.
- [ ] 3.5 Le due chord nel registro, e il prezzo che si paga su due sponde. Il
  bit di Option e' lavoro di 3.11, non di qui.
  `useKeyboardShortcuts.ts`: ⌘E (ambito automatico) e ⌥⌘E (sola cella); Escape come
  ULTIMO ramo, dopo lo stop del turno (il ramo e' a :468-473). `shared/shortcuts.ts`:
  due righe nel gruppo «Panels & tabs» (:87), tutte e due **col campo `native`**,
  come gia' fanno ⌘P/⌘⇧P e ⌘T/⌘⇧T che condividono un char:
  `{ keys: ['⌘', 'E'], description: 'Ingrandisci la conversazione', native: { chars: ['e'] } }`
  e la gemella `['⌥', '⌘', 'E']` con lo stesso `chars`. Il generatore le fonde in
  un'arm sola, ed e' giusto cosi': la tabella decide se INOLTRARE 'e', non quale
  delle due chord sia.

  Perche' il campo e' la riga da non sbagliare: `forwardedCmdChars()` salta ogni
  scorciatoia che ne e' priva (`if (!s.native) continue;`, shortcuts.ts:148), quindi
  senza campo il char 'e' non entra nella tabella Rust generata, il monitor NSEvent
  non inoltra la chord, e ⌘E non raggiunge il renderer PROPRIO quando una pane
  browser nativa ha il fuoco, cioe' «chat + browser aperta dall'agente», la
  situazione per cui questa funzione esiste. E' `LAYOUT-41`, ed e' anche la ragione
  per cui i cancelli restano VERDI senza il campo: `bun run gen:shortcuts && git
  diff --exit-code` e `shared/shortcuts.test.ts` confrontano il `.rs` committato con
  l'uscita di `renderRustModule()`, e un registro che non nomina 'e' combacia
  benissimo con un `.rs` che non lo nomina. Provano la coerenza, non la copertura.

  **Il prezzo esiste su DUE piattaforme, ed e' voluto tutte e due le volte.** Sul
  Mac la pagina a fuoco smette di ricevere ⌘E, perche' il ramo che inoltra la
  ingoia (lib.rs:8473 decide, :8645 fa `return nil`). Su Windows cambia
  ALTRETTANTO, e la prima stesura diceva il contrario: `shortcuts_generated.rs` non
  porta nessun `cfg` e lo dichiara nella sua intestazione («the macOS monitor and
  the Windows decision table both read this one list»), e `chords::decide` chiama
  `is_forwarded_cmd_chord` (chords.rs:131). Aggiungere 'e' al registro cambia
  quindi anche la tabella Windows: da quel momento Ctrl+E con una pagina a fuoco
  viene inoltrato alla UI e INGOIATO (`swallow: true`, :132) invece di raggiungere
  la pagina. Non e' una regressione da evitare, e' il comportamento voluto: su
  Windows Ctrl+E deve ingrandire esattamente come ⌘E sul Mac, ed e' scritto in
  `LAYOUT-41`. Va dichiarato dove si legge, e va AFFERMATO da un test invece di
  passare inosservato.

  Il test Rust va quindi aggiornato, ed e' un'aggiunta in due punti:
  (a) `'e'` fra i char di `app_chords_from_the_registry_are_forwarded`
  (chords.rs:158), che e' la riga che afferma «Ctrl+E e' inoltrato e ingoiato»;
  (b) `ChordKey::Char('e')` fra le chiavi di `alt_is_never_ours` (chords.rs:224),
  che e' la riga che afferma l'asimmetria rimasta.
  `page_chords_stay_with_the_page` (:168-178) NON va toccata, e va letta per
  quello che e': oggi elenca c, v, x, a, z, f, l, y e non ha mai nominato 'e',
  quindi resta verde con e senza questa change e non prova niente sul punto. E'
  esattamente cio' che `LAYOUT-41` chiede di non lasciare all'omissione.
  **Falsificazione, e vale per (a), non per (b).** Si aggiunge prima `'e'` ad (a)
  e si lancia `cargo test --lib` col registro ANCORA vecchio: deve essere ROSSO.
  Se e' verde, le due sponde non stanno leggendo lo stesso elenco e il claim di
  `LAYOUT-41` e' falso prima ancora di partire. (b) invece e' verde prima e dopo
  per costruzione, perche' `decide()` esce su `c.alt` prima di guardare la tabella
  (chords.rs:103-105): non e' un difetto del caso, e' cio' che il caso presidia, e
  la sua falsificazione e' un'altra, cioe' togliere quel ramo e vederlo rosso. Va
  scritto, o il primo che lancia (b) e lo trova verde crede di aver provato
  qualcosa che non ha provato.

  Il bit di Option, che il campo `native` NON copre, e la funzione macOS da
  rendere interrogabile stanno in **3.11**: e' la stessa cucitura, ma e' lavoro
  suo, con un altro file, un'altra falsificazione e un test che qui non c'entra.
  **Prova**: `bun test shared/shortcuts.test.ts`, che guadagna `LAYOUT-41` accanto
  a `CMD-01` nel `@covers` di testa (shortcuts.test.ts:4) e un caso che asserisce
  che l'uscita di `renderRustModule()` elenca 'e' fra i char sempre inoltrati e
  non fra gli Shift-only: e' l'unico canale che DICHIARA il requisito, visto che
  il cancello non cammina su `desktop-tauri/`;
  `bun run gen:shortcuts && git diff --exit-code -- desktop-tauri/src-tauri/src`
  (il `.rs` va COMMITTATO); `(cd desktop-tauri/src-tauri && cargo test --lib)`
  verde DOPO le due aggiunte di (a) e (b) e visto rosso prima, che e' il modo di
  provare che la tabella Windows e' cambiata come si voleva; e il video di 7.7,
  che resta l'unica prova possibile del campo `native`, visto che i due cancelli
  del generatore restano verdi anche quando manca.
- [ ] 3.6 `index.css`: `--pane-zoom-inset: clamp(20px, 4vmin, 56px)`;
  `[data-split-surface][data-pane-zoom]` con padding, `--bg-solid` e la banda
  superiore `max(inset, spazio delle pastiglie)`; `.pane-zoom-scrim` (con
  `cursor: zoom-out`, `aria-hidden`, non focusabile, `app-no-drag` +
  `{...NO_DRAG_REGION}`); `.pane-zoom-stage`; spigoli quadri come
  `[data-split-surface][data-pane-zoom] [data-split-card]` (specificita' 0,3,0);
  transizione di sola opacita' 120 ms, azzerata sotto `prefers-reduced-motion`.
  Commento accanto: l'aritmetica della banda in fluttuante regge perche' la card
  e' un flex item. Gli spigoli quadri sono una decisione CHIUSA (design, «Bivi ›
  Chiusi»): qui non c'e' niente da confermare, solo da scrivere la regola alla
  specificita' che vince.
- [ ] 3.7 D6: nessun `content-chrome-inset` sulla cella zoomata; il comando di
  riapertura della colonna reso dentro la cornice.
- [ ] 3.8 `i18n-it.ts` / `i18n-en.ts`: `tab.menu.zoom`, `tab.menu.unzoom`,
  `tab.menu.zoomCellOnly` («Ingrandisci solo questa»), e l'etichetta del comando
  della colonna se nuova.
  **Prova di tornata**: `bun run typecheck`, `bun run lint`,
  `bun run check:ui-language`, e a mano: entrare e uscire dallo zoom su un layout
  a 3 celle con un terminale che sta scrivendo.
- [ ] 3.9 Il predicato di disponibilita'. `canZoom` si valuta su CELLE e non su
  pane, ed e' UNO solo per il gesto semplice e per quello col modificatore:
  **esiste piu' di una cella VIVA sulla superficie** (piu' il cancello
  `useSplitLayoutAvailable()` per i 768px e la regola sulle bozze). E' la forma che
  la spec scrive come «esiste almeno una cella viva fuori dalla cella che ospita la
  tab»: le due coincidono, perche' l'ancora sta sempre in una cella viva. Non e'
  piu' «esiste una cella viva fuori dal SET», che rendeva assente il comando
  proprio dove serve di piu' (chat + due browser + un terminale in quattro celle:
  set = tutte le celle vive, voce sparita e doppio clic no-op muto). Il predicato e
  `resolveEntryScope` devono concordare per costruzione, non per coincidenza: con
  una cella viva sola la funzione torna `null`, ed e' lo stesso caso in cui
  `canZoom` e' falso.
- [ ] 3.10 **Bivio ancora APERTO: questa riga e' l'unica cosa da ritirare se in
  approvazione si decide altrimenti.** Effetto in `PanelGrid.tsx`: aprire una pane
  NUOVA che non appartiene al set fa USCIRE dallo zoom. Sto implementando la
  risposta consigliata, che e' anche quella che la spec scrive, per una regola sola
  («una pane nasce visibile») che copre ⌘T, ⌘N, l'add-menu, ⇧⌘T e il
  `browser:force-open` del server senza casistica, inclusi gli inneschi che non
  toccano `focusedPaneId`. L'alternativa e' accoglierla nel set, e fa crescere un
  insieme che l'utente non ha modo di vedere, visto che non esiste nessuna banda di
  chip. Invertendo il bivio cadono questa riga e il suo caso in 7.1, e nient'altro.
- [ ] 3.11 Il bit di Option sulla sponda macOS, e la funzione che diventa
  interrogabile. E' il task che REALIZZA l'ultima riga dello scenario «la chord
  col modificatore non arriva degradata» di `LAYOUT-40` («la decisione SHALL
  essere una funzione pura interrogabile da un test sulle DUE sponde native, non
  solo su quella che ha gia' la tabella»): senza di lui quello SHALL resterebbe
  scritto in una spec approvata e provato da niente, col `@covers` a livello file
  a tenere il cancello verde.

  Il guasto, prima: per ⌥⌘E il campo `native` di 3.5 non basta, e il codice dice
  una cosa peggiore di «non funziona». `charactersIgnoringModifiers` ignora
  l'Option per definizione, quindi ⌘E e ⌥⌘E arrivano al monitor con lo stesso
  `chars`; il monitor estrae da `modifierFlags` solo CMD, CTRL e SHIFT
  (lib.rs:8600-8606) e il bit di Option (`1 << 19`) non lo legge mai; il keydown
  sintetico hard-coda `altKey:false` (lib.rs:8485); e subito dopo l'originale
  viene INGOIATO (`return nil`, lib.rs:8645). Messe in fila: ⌥⌘E digitato sopra
  una pane browser nativa non diventa inerte, **diventa ⌘E**. Si chiede la sola
  cella, si ottiene l'ambito intero, e niente lo dice. E' la sola forma che
  `LAYOUT-40` dichiara VIETATA.

  Il lavoro sta tutto in `lib.rs` e sono cinque punti, scritti per com'e' il file
  oggi e non per come la prima stesura li contava («tre righe»):
  (a) accanto a `CMD`/`CTRL`/`SHIFT` (:8601-8603) una quarta costante
  `OPT: u64 = 1 << 19`, simmetrica alle tre, col numero preso da dove gia'
  compare, cioe' l'`OTHER_MODS` del monitor del ⌘ destro (:8704);
  (b) `let alt = flags & OPT != 0;` in coda alle tre letture di :8604-8606;
  (c) un parametro `alt: bool` su `app_chord_dispatch_js` (:8460), dopo `shift`,
  cosi' i modificatori restano in fila;
  (d) `altKey:{alt}` al posto della costante dentro il `format!` di :8485;
  (e) il passaggio al chiamante, che e' **UNO solo e sta a :8611**, dove oggi si
  legge `app_chord_dispatch_js(cmd, ctrl, shift, &chars, key_code)`. Non a :8473:
  quella riga e' il ramo `is_forwarded_cmd_chord` DENTRO la funzione, e chi la
  legge come una chiamata conta un chiamante che non esiste.
  I rami di decisione (:8469-8480) NON cambiano, e va detto perche' invece di
  darlo per scontato: la decisione di INOLTRARE 'e' e' identica con e senza
  Option, esattamente come oggi e' Shift-agnostica per 'w', quindi
  `is_forwarded_cmd_chord` non guadagna nessun parametro e `NativeForward` nessun
  campo. A discriminare i due ambiti e' il renderer su `e.altKey`, e per farlo gli
  basta ricevere il flag vero.

  **Il test, che e' la meta' nuova e la ragione per cui questo task esiste.**
  `app_chord_dispatch_js` e' privata ma e' pura: nel corpo ci sono solo confronti
  su `key_code` e su `chars` e un `format!`, zero `msg_send!`. Si interroga quindi
  da un modulo figlio, nella forma che questo file usa gia' per i test
  macOS-only, `#[cfg(all(test, target_os = "macos"))] mod ...` con `use super::…`
  (ce ne sono gia' QUATTRO: lib.rs:11394, :11509, :11731, :12336; la prima
  stesura ne contava tre e saltava :11394, ed e' design.md ad avere il conto
  giusto). Modulo nuovo,
  `use super::app_chord_dispatch_js`, e tre asserzioni: con `alt = true` su un
  char inoltrato la funzione torna comunque `Some` e il JS porta `altKey:true`;
  con `alt = false` lo stesso char porta `altKey:false`; e le due stringhe sono
  DIVERSE, che e' l'unica forma in cui «non arriva degradata» si asserisce invece
  di descriversi.
  Si asserisce su DUE char, e non e' zelo: 'w', che il registro inoltra gia' oggi,
  e 'e', che ce lo mette 3.5. Con 'w' il caso si scrive e si vede ROSSO subito,
  prima che il registro cambi e senza dipendere da 3.5, e prova la cosa vera,
  cioe' che la costante di :8485 pesava su OGNI chord inoltrata e non solo sulla
  nuova. Il `key_code` da passare e' uno qualunque che non sia 48 (Tab) ne' 53
  (Escape), o a rispondere e' un altro ramo.
  **Falsificazione**: con la firma nuova gia' a posto si rimette `altKey:false`
  come costante a :8485 e si lancia
  `(cd desktop-tauri/src-tauri && cargo test --lib)`. Deve essere ROSSO
  sull'asserzione che le due stringhe differiscono, che li' tornano identiche. Un
  test che non si e' mai visto rosso qui non e' un cancello, e' una parafrasi
  della firma.

  **Il confronto da rifare PRIMA di toccare la costante**, perche' quella vale per
  ogni chord inoltrata e non solo per la nuova. I char inoltrati oggi sono
  b, k, n, p, t, w, /, ?, 1-9 (piu' u con Shift), e i rami che LEGGONO `altKey`
  sono tre, verificati alla riga: `Browser/RemoteBrowserPanel.tsx:493-498`
  (i, l, r, [, ], f), `useKeyboardShortcuts.ts:186` (⌘ destro) e
  `useMenuKeyboard.ts:80`, che e' pero' la guardia della sola mnemonic ed esce
  comunque su `metaKey`. I due insiemi non si intersecano, quindi propagare il
  flag vero non cambia nessun ramo esistente. Il confronto va rifatto sulla build
  del giorno invece di fidarsi di questa riga, e va ALLARGATO di due voci che
  l'elenco dei char non copre: la costante viaggia anche sui rami `Escape`
  (:8469) e `Tab` (:8471), quindi ⌥Escape e ⌥⌃Tab sopra una pane nativa cambiano
  payload come tutti gli altri.

  **Windows resta indietro sul solo ⌥, e va detto invece che scoperto.**
  `decide()` restituisce `PassThrough` per QUALUNQUE chord con Alt, in cima e
  prima di ogni altro ramo (chords.rs:103-105), con la ragione scritta accanto
  (Alt e' del sistema e del menu: Alt+F4, Alt+Spazio). Non si tocca, e nemmeno
  `dispatch_js` (chords.rs:92-96): li' l'Alt non raggiunge mai il ramo che
  sintetizza, quindi il guasto muto del Mac non esiste e il peggio che capita e'
  che ⌥⌘E non arrivi, con una pane browser a fuoco. La sponda Windows dello
  stesso SHALL e' quindi il caso (b) di 3.5, cioe' `ChordKey::Char('e')` dentro
  `alt_is_never_ours`: due sponde, due test, lo stesso `cargo test --lib`.
  Restano il doppio clic con ⌥ e la voce di menu, che ci sono sempre. Asimmetria
  dichiarata, e sta nell'Impact del proposal e in `LAYOUT-40`; aggiungere un campo
  per piattaforma a `Shortcut` e' fuori ambito.

  **Una riga di commento che scade con questo task.** `chords.rs:4-13` dice della
  sponda macOS «nothing of it can be run off a Mac and nothing of it is covered by
  a test». La prima meta' resta vera; la seconda smette di esserlo nel momento in
  cui il modulo di prova esiste. Si corregge quella frase nello stesso commit, o
  il primo che la cita la usa per non scrivere il test che c'e' gia'.
  **Prova**: `(cd desktop-tauri/src-tauri && cargo test --lib)` verde con le
  asserzioni nuove e visto rosso rimettendo la costante; piu' il video di 7.7, che
  resta l'unica prova della meta' saldata dentro il monitor, cioe' che il bit
  letto sia davvero quello che AppKit consegna con ⌥ premuto.
  **Dichiarazione**: nessuna, e va saputo invece di scoprirlo al cancello. Un
  `#[test]` sotto `desktop-tauri/` non colora niente (preambolo); `LAYOUT-40` lo
  dichiarano le annotazioni per scenario degli e2e di 7.2, e questo test e' la
  prova che ci sta sotto.

## T4 — `hasBox` anche dove il difetto e' vivo da prima (dipende da T3)

- [ ] 4.1 `PanelGrid.tsx:2759-2760` e :2791-2792: la riga e la cella che non
  ospitano `mobileVisibleKey` alimentano `hasBox=false` oltre a `display:none`.
  E' un difetto che precede questa change (su mobile una browser con box zero
  resta `alive=true` ed e' pavimento di residenza, sul dispositivo con meno
  memoria), e senza questa riga la spec dichiarerebbe un invariante falso. Anche
  questa e' una decisione CHIUSA (design, «Bivi › Chiusi»), non un bivio da
  confermare.
  **Prova**: lo scenario mobile di `LAYOUT-39` ha un suo test DICHIARANTE, e non
  lo copre nessuno degli altri: un caso in `tests/e2e/pane-zoom.spec.ts` a
  viewport sotto i 768px, annotato
  `test.info().annotations.push({ type: "spec", description: "LAYOUT-39" })`, con
  il seed di 7.4 (che gia' morde il tetto) e la browser in una cella che NON e'
  quella visibile. Asserisce la meta' osservabile in Chromium, cioe' che quella
  pane non e' piu' pavimento: il suo `[data-pane-shell]` si STACCA quando il
  budget morde, mentre oggi resta attaccato per sempre; e, nello stesso caso, che
  il `[data-pane-shell]` della cella VISIBILE resta, o il test sarebbe verde
  perche' ha sfrattato tutto. L'altra meta', «la vista nativa e' spenta», in
  Playwright non esiste (`isTauri` e' falso) e resta una verifica a mano su Tauri
  con una browser in una riga nascosta sotto i 768px.
  Piu': `pane-residency-cap.spec.ts` resta verde.

## T5 — Parita' sulla griglia di progetto (dipende da T3)

- [ ] 5.1 `GroupLayout.tsx`: stesso innesto su `treeRoot` (:778) e `renderTreeLeaf`
  (:1129); prop `enableZoom` **default false**, `true` solo da `ProjectWindow`;
  `hasBox` su `renderGroupBlock` (:932). Predicato, ambiti e degradazione arrivano
  dalle stesse funzioni pure di T1: due superfici, un comportamento, zero regole
  riscritte.
- [ ] 5.2 Il cassetto del task monta lo stesso `GroupLayout`
  (`Board/TaskDetail.tsx:2927` e :3098) e resta senza zoom, ma NON resta senza la
  propagazione dell'assenza di box: e' la meta' di `LAYOUT-38` che il layout
  decide, e senza di lei il caso di 2.3 non si verifica.
  **Prova**: `npx playwright test tests/e2e/project-tabs.spec.ts` piu' un caso che
  asserisce l'assenza di ENTRAMBE le voci dentro il cassetto, con l'annotazione
  `LAYOUT-38` sullo scenario.

## T6 — I contratti negativi (indipendente)

- [ ] 6.1 Riscrivere in `browserOcclusion.test.ts` e `modalSurface.test.ts` la
  forma dell'asserzione: montare il nodo e usare `el.matches(OVERLAY_SELECTOR)` /
  `el.matches(MODAL_SURFACE_SELECTOR)`, non `classStringMatchesSelector`, che
  filtra i soli token di classe e non vedrebbe `role="dialog"`.
- [ ] 6.2 Aggiungere i due casi negativi: contenitore di zoom e scrim NON
  soddisfano nessuno dei due selettori. `LAYOUT-38` va aggiunto agli `@covers` di
  testa dei due file, accanto a `OCCLUSION-01` e `MODAL-01` che ci sono gia'
  (browserOcclusion.test.ts:2, modalSurface.test.ts:15).
  **Prova**: il test visto ROSSO aggiungendo `role="dialog"` allo scrim, poi verde
  togliendolo. Senza aver visto quel rosso, il contratto non e' un cancello.

## T7 — Le prove end-to-end (dipende da T3, T4, T5)

- [ ] 7.1 `tests/e2e/pane-zoom.spec.ts`, `hermetic(test)`. Dichiarazione sui DUE
  canali del preambolo: header
  `@covers LAYOUT-34, LAYOUT-35, LAYOUT-36, LAYOUT-37, LAYOUT-38, LAYOUT-39, LAYOUT-40, NATIVEPARK-02`
  per il FILE, e dentro ogni `test(...)` la sua
  `test.info().annotations.push({ type: "spec", description: "LAYOUT-3x" })`, che e'
  l'unica cosa che porta un esito al singolo requisito.
  Casi: gesto stratificato su anteprima e su tab fissata; doppio clic su una tab di
  un'ALTRA cella (cambio di fuoco e badge che sparisce, POI lo zoom); bozza; il set
  che porta con se' la browser della chat; una tab che nasce mentre si guarda; una
  pane nuova fuori set che fa uscire (il caso del bivio di 3.10); clic sulla
  cornice a `(inset/2, height/2)` leggendo la variabile CSS, e quel clic che NON
  raggiunge la griglia; Escape con turno in streaming (mock con `POST /api/chat`
  sospesa, come `escape-modal-guard.spec.ts`); Escape senza turno; tavolozza
  aperta; sotto i 768px il comando non c'e' in nessuno dei suoi inneschi e il
  doppio clic fa quello che fa oggi; dentro il cassetto del task nessuna delle due
  voci esiste, e la sua browser dietro una pane kanban nascosta e' spenta (scenario
  annotato `NATIVEPARK-02` e `LAYOUT-38`, che in questo file entrano anche fra gli
  `@covers` di testa).
- [ ] 7.2 I tre casi del modificatore e della degradazione (LAYOUT-40), che sono
  sul GESTO e nessun unit puo' darli:
  (a) ⌥ + doppio clic su una chat che ha una browser in una cella accanto: resta
  viva la SOLA cella della chat, la browser sparisce con le altre, e la voce
  «Ingrandisci solo questa» fa la stessa cosa;
  (b) il caso peggiore, che prima era un no-op muto: chat + due browser + il
  terminale di un sotto-agente in quattro celle, cioe' set derivato = tutte le celle
  vive. Il doppio clic SEMPLICE lascia viva la sola cella dell'ancora invece di non
  fare niente, e nel menu ci sono ENTRAMBE le voci, «Ingrandisci» e «Ingrandisci
  solo questa»: il test asserisce la PRESENZA di tutte e due, perche' e' li' che
  farne sparire una rimetterebbe il menu a dipendere dal set derivato. Va asserito
  anche che il comando resta assente SOLO con una cella viva sola, altrimenti (b)
  e' verde per la ragione sbagliata;
  (c) l'uscita e' la stessa nei due ambiti: cornice, gesto ripetuto (col
  modificatore o senza) ed Escape senza turno vivo portano allo stesso stato di
  riposo, e in DOM non esiste nessun attributo che distingua due modalita'. E a
  zoom attivo il menu offre la sola «Riduci», qualunque sia lo scope memorizzato.
- [ ] 7.3 La prova strutturale del non-rimontaggio: `[data-split-leaf]` e
  `[data-pane-shell]` identici prima e dopo, divisori confrontati prima contro
  dopo con `countColDividers`/`countRowDividers` (`helpers/layout.ts:11,32`), un
  marcatore scritto in un terminale ancora leggibile e una bozza ancora nel campo.
- [ ] 7.4 Residenza: seed con **almeno 3 gruppi** (3 celle), ogni cella con piu'
  tab, e piu' di 12 pane non visibili per mordere il budget. Asserzione PUNTUALE:
  `[data-pane-shell="<id della tab attiva di ogni cella collassata>"]` ancora
  attaccato dopo 10 s di zoom, con annotazione `LAYOUT-39` sullo scenario. Il
  conteggio aggregato del seed a gruppo unico di `pane-residency-cap.spec.ts`
  sarebbe verde con o senza zoom: non prova niente.
- [ ] 7.5 `tests/e2e/drag-regions.spec.ts` verde con lo scrim montato.
- [ ] 7.6 Le sei spec che leggono il contratto DOM degli split, piu' i tre
  contratti che il doppio clic puo' rompere (`tab-sync.spec.ts:565`,
  `draft-pane-lifecycle.spec.ts:129-142`, e la barra di `grid-split.spec.ts`).
- [ ] 7.7 Le TRE passate a mano su Tauri, uniche prove che il guscio nativo
  ammetta: chiavistello (caso composto di 0.2); fluttuante acceso (larghezza e
  fondo della banda, spigoli della card); e le due chord col fuoco DENTRO una pane
  browser nativa, dove ⌘E ingrandisce, ⌥⌘E ingrandisce la sola cella, e nessuna
  delle due si trasforma nell'altra. Nella terza, registrare anche il `chars` che
  il monitor legge con ⌥ premuto: la lettura attesa e' `e`, ma e' un'assunzione che
  nessun file di questo repo dimostra.
  **Prova**: tre video, non tre frasi.
- [ ] 7.8 I quattro scenari di `LAYOUT-35` che non tocca nessun caso di 7.1 ne'
  di 7.3, nello stesso `tests/e2e/pane-zoom.spec.ts` e con la stessa doppia
  dichiarazione. Stanno insieme in un task perche' il buco e' di una classe sola:
  col `@covers` a livello FILE il cancello resta verde comunque, quindi un
  requisito puo' avere quattro scenari scritti e zero esiti, ed e' esattamente la
  cecita' che il disegno smonta altrove. Ognuno porta la sua
  `test.info().annotations.push({ type: "spec", description: "LAYOUT-35" })`, o
  non conta.
  (a) **Le celle collassate escono dalla tastiera.** Si tabula a partire dalla
  superficie e a ogni passo si legge `document.activeElement`: nessuno dei fuochi
  visitati SHALL stare dentro un `[data-split-leaf]` fuori dal set. Serve la
  guardia contro il verde a vuoto, che qui e' il modo di guasto piu' probabile: il
  giro deve contare almeno un fuoco atterrato DENTRO la cella ingrandita, o
  «nessuno fuori» e' vero perche' non si e' tabulato niente.
  (b) **Chi ha chiesto meno movimento.** Il caso ha una trappola sua: l'intera
  suite gira gia' con `contextOptions: { reducedMotion: "reduce" }`
  (playwright.config.ts:295), quindi un caso che asserisse la sola durata zero
  sarebbe verde anche se la transizione dello scrim non fosse mai esistita. Si
  misura nelle DUE modalita', come fa gia'
  `tests/e2e/reduced-motion-chrome-controls.spec.ts`, che apre i due contesti a
  mano con `browser.newContext` (il commento a playwright.config.ts:289-294 dice
  perche': `contextOptions` e' UN fixture solo, e un `test.use` lo SOSTITUISCE
  invece di aggiungerci una chiave) e verifica pure che il contesto sia davvero
  nella modalita' chiesta (:259). Con `no-preference` la `transition-duration`
  computata dello scrim SHALL essere i 120 ms di 3.6; con `reduce` SHALL essere
  `0s`. In tutt'e due, la proprieta' in transizione SHALL essere la sola opacita':
  e' la meta' «nessuna geometria e' animata».
  (c) **Il comando per riaprire la colonna resta raggiungibile.** Colonna chiusa,
  si ingrandisce una cella che NON e' la (0,0): il comando SHALL essere visibile e
  il suo box SHALL cadere dentro la banda superiore, cioe' sopra il bordo alto
  dello stage, con la misura letta da `--pane-zoom-inset` come fa il caso della
  cornice in 7.1; e la cella ingrandita NON SHALL riservare lo spazio delle
  pastiglie, cioe' la sua barra NON SHALL portare `content-chrome-inset`.
  **Questo caso ha una dipendenza su 3.7 che va onorata li', non aggirata qui**:
  oggi quel comando non ha nessun aggancio stabile. `SidebarToggleButton`
  (`client/src/components/Shared/SidebarToggleButton.tsx:38-45`) porta solo
  `title`/`aria-label`, e il valore e' copy; il suo contenitore in
  `StandaloneChatGroup.tsx:940-946` non ha `data-testid`. Un locator su copy
  tradotta qui non si fa, quindi 3.7 gli aggiunge il `data-testid` mentre lo porta
  dentro la cornice.
  (d) **Geometria e trascinamento durante lo zoom**, che sono DUE meta' e vanno
  asserite tutt'e due. La prima: si trascina un divisore a zoom attivo, le scatole
  delle celle superstiti NON SHALL muoversi, e uscendo la griglia SHALL essere
  quella di prima (scatole confrontate con quelle lette prima di entrare). Il caso
  va costruito con DUE celle superstiti, cioe' scope `derived` su una chat che ha
  la sua browser accanto: con una cella sola non c'e' nessun divisore da
  trascinare, perche' ne compare uno solo fra due fratelli a peso positivo
  (`gapHasDivider`, SplitTree.tsx:91), e il caso sarebbe verde per assenza di
  bersaglio. Da sapere mentre lo si scrive: il divisore RESTA nel DOM col suo
  `data-resize-axis`, perche' 3.1 toglie `onResize`/`onEqualize` e non il nodo
  (SplitTree.tsx:98-105); la prova e' quindi il trascinamento che non muove
  niente, mai un conteggio di divisori.
  La seconda: l'uscita che 3.3 implementa e che oggi nessun caso asserisce. Per
  ognuno di «Dividi a destra», «Reimposta pannelli», «Disponi» e l'avvio di un
  drag di tab, `[data-pane-zoom]` SHALL essere sparito E il comando SHALL essersi
  applicato alla griglia INTERA: dopo «Dividi a destra» le celle SHALL essere una
  in piu' di quelle contate prima di entrare nello zoom, e la cella nuova SHALL
  essere visibile. Senza questa seconda asserzione il caso sarebbe verde anche col
  comando applicato dentro una cella collassata, che e' il guasto per cui la
  regola esiste.

- [ ] 7.9 I cinque scenari di `LAYOUT-37` che non tocca nessun caso di 7.1 ne'
  di 7.3, nello stesso `tests/e2e/pane-zoom.spec.ts` e con la stessa doppia
  dichiarazione. La lista di 7.1 copre i TRE di Escape e si ferma li': «l'ancora
  sparisce», «il fuoco va altrove», «cambio di Spazio», «ricaricamento» e «lo
  zoom non viaggia» restano scritti in una spec approvata e provati da niente, e
  il `@covers` a livello FILE tiene il cancello verde lo stesso. E' il buco della
  stessa classe che 7.8 chiude su `LAYOUT-35`, applicato al requisito accanto.
  Due dei cinque non sono rifiniture: l'uscita su fuoco-altrove e l'uscita quando
  sparisce l'ancora sono cablaggio VERO, scritto in 3.1, e oggi non le asserisce
  nessuno. Ognuno porta la sua
  `test.info().annotations.push({ type: "spec", description: "LAYOUT-37" })`, o
  non conta.
  (a) **L'ancora sparisce.** Si entra con scope `derived` su una chat la cui
  cella ha DUE tab, e si chiude la SOLA tab ancorata (testid `pane-tab-close`,
  dichiarato a PaneTabBar.tsx:2360). `[data-pane-zoom]` SHALL essere sparito e le
  celle prima collassate SHALL essere di nuovo visibili. La costruzione a due tab
  non e' zelo: chiudendo l'unica tab sparirebbe la CELLA, e l'uscita sarebbe
  spiegata dalla potatura invece che dall'ancora, cioe' il caso sarebbe verde per
  la ragione sbagliata. Serve la guardia contro il verde a vuoto, prima di
  chiudere: almeno un `[data-split-leaf]` SHALL risultare collassato, o lo zoom
  non stava rivelando niente. L'altra meta' dello scenario, la chiusura da un
  ALTRO dispositivo, arriva sullo stesso effetto di potatura e non merita un caso
  proprio; chi lo volesse comunque ha gia' l'attrezzo in `helpers/multi-client.ts`
  (l'harness di `browser-cross-device-close.spec.ts`).
  (b) **Il fuoco va altrove, e le meta' da asserire sono DUE.** La prima: a zoom
  attivo il fuoco va su una pane che sta in una cella FUORI dal set, e lo zoom
  SHALL chiudersi. L'innesco non puo' essere un clic sulla tab di quella cella,
  che sta a `display:none` e non si clicca: si passa da fuori della griglia, cioe'
  dalla voce di sidebar del topic gia' aperto li', che dispatcha
  `topics:open-topic` (`Layout/spaceHelpers.ts:169`). La seconda, che e' la sola
  a mordere un'implementazione troppo grossolana: si cambia tab DENTRO la cella
  del set, e `[data-pane-zoom]` SHALL restare. Senza di lei «esce sul cambio di
  fuoco» sarebbe soddisfatto anche da un effetto che esce SEMPRE.
  (c) **Cambio di Spazio.** A zoom attivo si passa a un altro gruppo e si torna
  (`space-row`, l'harness di `spaces-switcher.spec.ts`): nessuno dei due SHALL
  risultare ingrandito. Va scritto nel caso PERCHE' e' voluto e non un difetto:
  `App.tsx:2088` chiavia il sottoalbero su `activeSpaceId`, la superficie si
  rimonta, e l'effetto di smontaggio di 3.1 chiama `exit(surfaceId)`. Guardia
  contro il verde a vuoto: al ritorno la griglia SHALL avere le stesse celle di
  prima, o «non ingrandito» sarebbe vero perche' il layout si e' perso.
  (d) **Ricaricamento.** A zoom attivo si ricarica: `[data-pane-zoom]` SHALL
  essere assente e la griglia SHALL essere quella di prima. La seconda meta',
  «nessuna cornice su una griglia non ancora idratata», ha due trappole da sapere
  PRIMA di scriverla. Il bersaglio: 3.1 monta scrim e stage INCONDIZIONATI,
  quindi contare il nodo `.pane-zoom-scrim` darebbe 1 sempre e proverebbe il
  contrario di cio' che si vuole; si asserisce su `[data-pane-zoom]` della
  superficie e sulla visibilita' computata del velo, mai sulla presenza del nodo.
  La finestra: l'osservazione conta solo se cade PRIMA dell'idratazione, e la
  finestra di boot si allarga ritardando ENTRAMBI i canali, il frame WS
  `ui-state:init` e il ripiego `GET /api/ui-state/pane-store-v2`
  (`state/pane/bootstrap.ts:125` e :315). Ritardarne uno solo lascia passare
  l'altro, e il caso misura il nulla.
  (e) **Lo zoom non viaggia, e sono DUE asserzioni.** Due contesti con la stessa
  griglia (`openTwoDevices`, `helpers/multi-client.ts`), e si ingrandisce su A. La
  prima: su B `[data-pane-zoom]` SHALL restare assente e le scatole dei
  `[data-split-leaf]` SHALL essere quelle lette prima del gesto. La seconda e' la
  meta' che la spec scrive e che nessun DOM mostra: durante il gesto su A NON
  SHALL partire nessuna scrittura dello stato dei pannelli, cioe' zero `PUT` su
  `**/api/ui-state/pane-store-v2*`, che e' la sincronizzazione col rimbalzo di
  `state/pane/middleware/syncServer.ts:150`. Il glob va scritto con la coda: quel
  `PUT` accoda `?base=<seq>`, e un pattern che finisce sulla chiave non combacia,
  cioe' conta zero per il motivo sbagliato. Serve la guardia: nello stesso test
  un'azione che SCRIVE davvero, per esempio aprire una tab, SHALL far salire il
  contatore, o «zero PUT» vuol dire solo che l'ascoltatore non era montato.

## T8 — Cancelli finali

- [ ] 8.1 La barra intera del design.md, in quell'ordine.
- [ ] 8.2 `bun run check:e2e-touched` prima di consegnare: l'E2E non e' fra i sei
  check della board, e un land verde rompe la nightly.
