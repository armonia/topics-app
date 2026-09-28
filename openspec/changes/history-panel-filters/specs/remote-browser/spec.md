# Cronologia: filtri in cima al pannello completo

Estende HISTORY-01 (`openspec/specs/remote-browser/spec.md`, «La cronologia è
UNA»), che dice come nascono le righe ma non come si restringono. HISTORY-01
resta invariato: la regola della ricerca è la sua.

## ADDED Requirements

### Requirement: HISTORY-02 — La lista della cronologia si filtra per tipo e per giorno, prima di ogni tetto

`buildHistoryRows` (`client/src/lib/historyRows.ts:57`) SHALL accettare, oltre a
`query` e `limit`:

- `kind?: HistoryRowKind` (`historyRows.ts:22`). Assente = le due sorgenti;
  `'tab'` = solo tab chiuse; `'page'` = solo pagine visitate.
- `range?: HistoryRange`, con
  `type HistoryRange = 'all' | 'today' | 'yesterday' | 'older'`. Assente o
  `'all'` = nessun filtro sul giorno.
- `now?: number` (epoch ms), default `Date.now()`: il riferimento dei giorni,
  iniettabile dai test.

Una funzione pura esportata `historyRangeOf(at: number, now: number)` SHALL
dire in che giorno cade una riga: `'today'` dalla mezzanotte locale di `now` in
poi, `'yesterday'` dalla mezzanotte locale del giorno prima, `'older'` prima
ancora. `buildHistoryRows` SHALL usare questa funzione, non una copia.

- Le mezzanotti SHALL venire dal calendario locale (`new Date(y, m, d)` e
  `new Date(y, m, d - 1)`), mai da `now - 86_400_000`: in Europe/Rome il
  25/10/2026 dura 25 ore, e la sottrazione sposta di un'ora il confine di ieri.
- Un `at` più avanti di `now` SHALL contare come `'today'`, mai sparire:
  `closedStack` si sincronizza fra dispositivi (CMD-05) e `closedAt` può venire
  dall'orologio di un altro.
- Ordine dei passi: tipo, giorno, ricerca (la regola di HISTORY-01, invariata),
  ordinamento, tetto. Il tetto resta l'ultimo: un filtro applicato dopo
  lavorerebbe solo sulle righe che il tetto ha lasciato passare.

Dove cambiarla: scelta 1 (i valori di `kind`), scelta 2 (i valori di
`HistoryRange` e i confini dei giorni).

#### Scenario: solo le pagine
- **GIVEN** 2 tab chiuse e 3 pagine visitate
- **WHEN** si chiama `buildHistoryRows({ closedTabs, pages, kind: 'page' })`
- **THEN** escono 3 righe, tutte con `kind === 'page'`, dalla più recente

#### Scenario: ieri, a cavallo della mezzanotte
- **GIVEN** `now` = 28/09/2026 00:10 locale e due pagine, alle 23:50 del 27/09 e alle 00:05 del 28/09
- **WHEN** si filtra con `range: 'yesterday'`
- **THEN** esce solo la pagina delle 23:50
- **AND** con `range: 'today'` esce solo quella delle 00:05

#### Scenario: il filtro lavora prima del tetto
- **GIVEN** 50 pagine di oggi e 1 pagina di ieri
- **WHEN** si chiama con `range: 'yesterday'` e `limit: 40`
- **THEN** esce 1 riga, la pagina di ieri

#### Scenario: un istante nel futuro è oggi
- **GIVEN** una tab chiusa con `closedAt` = `now` + 5 minuti
- **WHEN** si filtra con `range: 'today'`
- **THEN** la tab c'è

#### Scenario: il giorno del cambio d'ora
- **GIVEN** `TZ=Europe/Rome`, `now` = 26/10/2026 00:30 locale, e una pagina del 25/10/2026 alle 00:30 locale (25 ore prima)
- **WHEN** si chiede `historyRangeOf(at, now)`
- **THEN** la risposta è `'yesterday'`
- **AND** per una pagina del 24/10/2026 alle 23:30 locale è `'older'`

### Requirement: HISTORY-03 — Il pannello «Vedi tutta la cronologia» ha i filtri in cima

Nel pannello che «Vedi tutta la cronologia» apre
(`client/src/components/Sidebar/TopicsMenuItems.tsx:239-247`, poi
`setSearchScope('history')` in `client/src/App.tsx:1933` e `:2227`, poi
`CommandPalette` con `scope="history"`, `App.tsx:2342-2344`), SHALL comparire
una barra `data-testid="history-filters"` fra il campo di ricerca
(`client/src/components/Shared/CommandPalette.tsx:606-636`) e la lista
(`CommandPalette.tsx:642-656`). La barra vive in un componente suo,
`client/src/components/Shared/HistoryFilters.tsx`, controllato: valori e
`onChange` arrivano da `CommandPalette`, dentro non c'è stato. Negli scope `all`
(⌘K) e `projects` (⌘F) la barra NON SHALL esserci.

Due gruppi, ognuno `role="group"` con un'etichetta i18n:

- **tipo**: `history-filter-kind-all`, `history-filter-kind-tab`,
  `history-filter-kind-page`, cioè «Tutto · Tab chiuse · Pagine».
- **giorno**: `history-filter-range-all`, `history-filter-range-today`,
  `history-filter-range-yesterday`, `history-filter-range-older`, cioè
  «Sempre · Oggi · Ieri · Prima».

- Ogni bottone SHALL portare `aria-pressed`, ed esattamente uno per gruppo è
  premuto. La forma è quella del selettore di modo di
  `client/src/components/Project/FileSearch.tsx:260-281` (gruppo bordato,
  attivo `text-primary bg-primary/10`): nessun colore e nessun token nuovi.
- Da desktop i due gruppi SHALL stare su una riga. Sotto i 768 px
  (`useMobile().isMobile`, `CommandPalette.tsx:172`) SHALL stare un gruppo per
  riga, bottoni `flex-1` alti 44 px, senza scorrimento orizzontale.
- Lo stato dei filtri SHALL vivere in `CommandPalette` e tornare a Tutto e
  Sempre a ogni apertura, nello stesso effetto che azzera la query
  (`CommandPalette.tsx:518-525`).
- Dopo la scelta di un filtro il fuoco SHALL tornare al campo di ricerca: ↑↓ e
  ↵ vivono lì (`CommandPalette.tsx:533-549` e `:623`), e un fuoco rimasto sul
  bottone li spegnerebbe. La selezione SHALL ripartire dalla prima riga, come
  già fa un cambio di query (`CommandPalette.tsx:510-513`).
- Il numero accanto al titolo «Cronologia» (`CommandPalette.tsx:649`) SHALL
  contare le righe rimaste dopo filtri e ricerca.
- Le etichette SHALL passare dall'i18n, accanto alle chiavi della cronologia
  (`client/src/lib/i18n-it.ts:2278-2282`, `client/src/lib/i18n-en.ts:2000-2004`).
  «Tutto» e «Sempre» sono due parole diverse di proposito: due «Tutto» sulla
  stessa riga non dicono quale gruppo azzerano.

Dove cambiarla: scelta 1 (bottoni del tipo), scelta 2 (bottoni del giorno),
scelta 3 (azzeramento a ogni apertura; con «no» lo stato si ricorda per
dispositivo e cade lo scenario «i filtri non sopravvivono alla chiusura»).

#### Scenario: solo le pagine
- **GIVEN** la app su `:13334` con 2 tab chiuse (seminate in `closedStack`) e 3 pagine visitate (seminate in `localStorage['topics:browser-pages:v1']`)
- **WHEN** si apre «Vedi tutta la cronologia» dal menu utente e si preme `history-filter-kind-page`
- **THEN** la lista ha 3 righe, tutte `history-row-page`, e il numero accanto a «Cronologia» è 3
- **AND** `history-filter-kind-page` ha `aria-pressed="true"` e `history-filter-kind-all` `"false"`

#### Scenario: ieri
- **GIVEN** l'orologio della pagina fissato al 28/09/2026 10:00 (`page.clock`), 2 pagine di oggi e 1 del 27/09 alle 18:00
- **WHEN** si preme `history-filter-range-yesterday`
- **THEN** la lista ha 1 riga, la pagina del 27/09

#### Scenario: i filtri non sopravvivono alla chiusura
- **GIVEN** il pannello con Pagine e Ieri premuti
- **WHEN** si chiude con Esc e si riapre da «Vedi tutta la cronologia»
- **THEN** sono premuti `history-filter-kind-all` e `history-filter-range-all`, e la lista ha tutte le righe

#### Scenario: la tastiera continua dopo un clic
- **GIVEN** il pannello aperto con righe di entrambi i tipi
- **WHEN** si preme col puntatore `history-filter-kind-page`
- **THEN** il fuoco è sul campo di ricerca
- **AND** ↵ apre la prima pagina della lista filtrata in una pane browser, e il pannello si chiude

#### Scenario: sul telefono
- **GIVEN** un viewport di 375 × 812
- **WHEN** si apre il pannello
- **THEN** ogni bottone dei filtri è alto almeno 44 px, i due gruppi stanno su due righe, e `history-filters` non ha scorrimento orizzontale (`scrollWidth <= clientWidth`)

### Requirement: HISTORY-04 — Una sola ricerca nella cronologia, su tutta la lista

Le righe della cronologia in `CommandPalette` (`recentItems`,
`client/src/components/Shared/CommandPalette.tsx:306-346`) SHALL uscire da
`buildHistoryRows` con la query corrente, in entrambi gli scope che le mostrano
(`history` e `all`). La regola è quella di HISTORY-01: tutte le parole, anche in
campi diversi, su nome, dettaglio e indirizzo.

- `filterByQuery` (`CommandPalette.tsx:464-471`) NON SHALL più applicarsi alle
  righe della cronologia. Resta per progetti, topic, azioni e «Crea».
- Nello scope `history` NON SHALL esserci tetto: le sorgenti sono già limitate
  da `CLOSED_STACK_MAX` = 50 (`client/src/state/pane/types.ts:425`) e da
  `MAX_PAGES` = 200 (`client/src/state/browserSiteHistory.ts:72`). Nello scope
  `all` il tetto di 40 (`CommandPalette.tsx:310`) resta, applicato dopo la
  ricerca.
- L'età della riga («Chiusa 5m fa», `CommandPalette.tsx:324-325`) resta nella
  descrizione ma NON SHALL essere cercata.
- L'evidenziazione (`highlightQuery`, `CommandPalette.tsx:923-932`) SHALL
  segnare ogni parola della query, non solo la frase intera: con la ricerca a
  parole una frase intera spesso non c'è.
- Ogni riga della cronologia SHALL portare `data-testid="history-row-tab"` o
  `"history-row-page"` (`CommandAction.testId`, `CommandPalette.tsx:53-55`).

#### Scenario: la riga numero 45 si vede e si trova
- **GIVEN** 45 pagine visitate, la più vecchia su `https://quarantacinque.example/`
- **WHEN** si apre «Vedi tutta la cronologia» senza query
- **THEN** la lista ha 45 righe e il numero accanto a «Cronologia» è 45
- **AND** scrivendo `quarantacinque` resta 1 riga, quella pagina

#### Scenario: parole in campi diversi
- **GIVEN** una pagina «Pull request» su `https://github.com/armonia/topics/3`: `pull` sta solo nel titolo, `github` solo nell'indirizzo
- **WHEN** si scrive `github pull`
- **THEN** la pagina c'è

#### Scenario: l'età non si cerca
- **GIVEN** 3 tab chiuse fra 2 e 10 minuti fa (sotto il minuto l'età è «ora», `CommandPalette.tsx:913`, e «fa» non comparirebbe), nessuna delle quali ha «fa» o «chiusa» nel titolo, nel progetto, nella cartella o nell'indirizzo
- **WHEN** si scrive `fa`
- **THEN** la lista è vuota

#### Scenario: una tab browser chiusa si trova dal suo indirizzo
- **GIVEN** una tab browser chiusa con titolo «Guida» su `https://esempio.dev/guida`
- **WHEN** si scrive `esempio.dev`
- **THEN** la tab c'è, come `history-row-tab`

#### Scenario: anche ⌘K cerca su tutta la cronologia
- **GIVEN** le stesse 45 pagine del primo scenario
- **WHEN** si apre ⌘K e si scrive `quarantacinque`
- **THEN** la sezione «Cronologia» dei risultati contiene quella pagina

### Requirement: HISTORY-05 — Sotto i filtri, il vuoto si spiega e ⇧⌘T resta sulla tab giusta

Nello scope `history`:

- Senza nessuna riga nelle sorgenti resta il messaggio di oggi,
  `palette.noHistory` (`CommandPalette.tsx:654`).
- Con righe nelle sorgenti ma nessuna dopo filtri e ricerca, SHALL comparire
  `EmptyState` (`client/src/components/Shared/EmptyState.tsx:21-49`) col titolo
  «Niente con questi filtri» e, solo se almeno un filtro non è su Tutto o
  Sempre, un bottone «Mostra tutto» (`data-testid="history-filter-reset"`,
  nella prop `action`). Il bottone SHALL riportare i due filtri a Tutto e
  Sempre, lasciare la query com'è e ridare il fuoco al campo. Con la sola query
  attiva il titolo SHALL essere `palette.noResults`, senza bottone.

In entrambi gli scope, il suggerimento ⇧⌘T (`CommandPalette.tsx:334-337`) SHALL
stare sulla riga il cui `record.id` è quello di `closedTabs[0]`, la tab che
⇧⌘T riapre davvero (CMD-03, `client/src/hooks/useKeyboardShortcuts.ts:387`), e
su nessun'altra. Se quella riga è filtrata via, il suggerimento non compare.

#### Scenario: filtri che svuotano la lista
- **GIVEN** la cronologia con sole pagine di oggi, due delle quali su `github.com`, e `github` scritto nel campo
- **WHEN** si preme `history-filter-kind-tab`
- **THEN** compare «Niente con questi filtri» con `history-filter-reset`
- **AND** premendolo torna la lista delle pagine che contengono `github`, `history-filter-kind-all` è premuto e il campo contiene ancora `github`

#### Scenario: ⇧⌘T sulla tab giusta
- **GIVEN** una pagina visitata 1 minuto fa, la tab A chiusa 5 minuti fa e la tab B chiusa ieri
- **WHEN** si apre il pannello senza filtri
- **THEN** il suggerimento ⇧⌘T sta sulla riga di A, che non è la prima della lista
- **AND** con `history-filter-range-yesterday` premuto la riga di B non ha il suggerimento
