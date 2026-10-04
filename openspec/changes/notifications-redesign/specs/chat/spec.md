# Chat: delta di notifications-redesign

## MODIFIED Requirements

### Requirement: CHAT-WAIT-03 — ⌘J porta alla prossima chat che ti aspetta

Un comando SHALL portare il fuoco sulla prossima riga della sidebar in attesa di
una tua risposta: il cui soggetto di attenzione è `needs-you` con motivo
`question`, `permission` o `plan` (ATTN-01, ATTN-04), qualunque sia il runtime.
Da tastiera è `Mod+J` (⌘J sul Mac, Ctrl+J altrove).

**Le mete.** Una meta SHALL essere una riga chat o terminale il cui soggetto
(`topic:<id>`, `terminal:<id>`) ha `attentionOf(subject).tier = 'needs-you'` con
motivo `question`, `permission` o `plan`: le righe che la sidebar colora
d'ambra, lette dallo stesso store di attenzione e non più da
`awaitingInputTopics` o `claudePhaseAwaitingInputTermIds`. Una chat al lavoro,
in background o col turno finito (`finished`, visto o no) e un sotto-agente
annidato NON SHALL essere mete. La chat del runtime nativo col piano che l'app
chiede a fine turno (`server/lib/plan-approval.ts`) ora è `needs-you(plan)`,
ambra, e SHALL essere una meta. Una card in review o parcheggiata non è una riga
della sidebar e NON SHALL essere una meta: la porta la inbox. Il «visto» non
conta: una meta guardata resta una meta finché la domanda è aperta.

**L'ordine.** Le mete SHALL essere ordinate da una funzione pura
`waitingQueue(allItems, pinnedIds, sig)` in `client/src/lib/waitingQueue.ts`:
prima le righe fissate, nell'ordine dei Fissati (un progetto fissato porta al
suo posto le mete fra le sue tab, che la sua fascia disegna lì e la lista sotto
non ripete); poi quelle che `groupSidebarItemsByState` mette in «Ti aspetta» (la
sezione che legge il tier `needs-you`, ATTN-12), nel loro ordine. Ogni soggetto
SHALL comparire una volta sola, alla prima occorrenza: una chat fissata dentro un
progetto sta sia fra i Fissati sia fra i figli che la vista promuove, e conta
fra i Fissati.

**Il passo.** La meta SHALL essere scelta da una funzione pura
`nextWaiting(queue, focused, last)`:

- se la riga a fuoco è una meta, la prima meta dopo di lei; dopo l'ultima, la
  prima;
- se la riga a fuoco è quella dove l'ultimo passo ti ha portato e non è più una
  meta, la prima meta che la seguiva nella coda di quel passo; se non ne resta
  nessuna, la prima;
- altrimenti la prima meta.

Nessuna meta diversa dalla riga a fuoco SHALL dare un avviso («Nessuna chat ti
aspetta» a coda vuota, «Nessun'altra chat ti aspetta» se l'unica è quella a
fuoco) e nessun cambio di fuoco.

**Il gesto.** Il tasto SHALL annunciare l'evento `topics:next-waiting` e basta;
la sidebar (`TopicTree`) SHALL rispondere chiamando lo stesso gestore del clic
sulla riga: `handleChatRowClick` per le chat, e per i terminali un
`handleTerminalRowClick` che manda il visto del soggetto alla porta del server
(ATTN-06) e poi chiama `onTerminalClick`, estratto dalla riga (`TopicTree.tsx:2376`) e usato da
lei e dal tasto. Una meta disegnata nella card di un gruppo che la finestra non
mostra SHALL passare prima da `goToSpace` di quel gruppo, come fa la cattura del
clic sulla card (`SpaceGroups`): la finestra va sul gruppo, e in una
finestra-gruppo (`?space=`) la query lo segue; un gruppo che vive in una
finestra sua viene portato davanti. Una meta FISSATA non sta in nessuna card
(i fissati stanno nel blocco delle tessere sopra i gruppi): il suo gruppo SHALL
leggersi dalla mappa delle pane (`sidebarItemSpace`), e la meta SHALL fare la
stessa deviazione; anche il clic sulla sua tessera la fa, e così SHALL fare la
tessera di OGNI tipo (chat, terminale, progetto, browser, utility), dalla stessa
`goToHomeSpaceOf`. Fa eccezione la sola board, che porta la finestra dal suo
gruppo con `onOpenBoard`. In una finestra normale (senza `?space=`) il passo
SHALL commutare la griglia sul gruppo della meta, e la query NON SHALL comparire.

**Il tasto.**

- Il registro `shared/shortcuts.ts` SHALL avere la voce `[MOD, 'J']` nel gruppo
  «Chat» con `native: { chars: ['j'] }`, e `shortcuts_generated.rs` SHALL essere
  rigenerato: con una pane browser a fuoco l'accordo SHALL arrivare lo stesso.
- Il gestore SHALL confrontare `e.key`, non `e.code`, e SHALL scattare anche con
  il fuoco nel composer o in un altro campo di testo.
- Sul ramo `ctrlKey` il gestore SHALL cedere a terminale ed editor
  (`isRawKeySurfaceFocused`), dove Ctrl+J è un tasto vero.
- Con Shift o Alt premuti il gestore NON SHALL scattare.

#### Scenario: due chat in attesa e una al lavoro
- **GIVEN** su `:13334`, vista per stato, tre chat: A ferma su un permesso (`needs-you(permission)` dal permission bridge del server di test), B ferma su una domanda dentro l'app (`needs-you(question)` da `mcp__topics__ask_user_question`), C con uno stream aperto e nessuna domanda
- **AND** il fuoco su C
- **WHEN** si preme ⌘J tre volte
- **THEN** la tab a fuoco (`[role="tab"][data-active="true"]`) è, nell'ordine, la prima riga di `sidebar-state-section-awaiting`, poi la seconda, poi di nuovo la prima
- **AND** C non riceve mai il fuoco

#### Scenario: la successiva dopo quella a fuoco
- **GIVEN** `queue = [A, B, C]` e il fuoco su B
- **WHEN** si chiede `nextWaiting`
- **THEN** la risposta è C

#### Scenario: dopo l'ultima si riparte
- **GIVEN** `queue = [A, B, C]` e il fuoco su C
- **THEN** la risposta è A

#### Scenario: il fuoco fuori dalla coda
- **GIVEN** `queue = [A, B]`, il fuoco su una chat al lavoro e nessun passo precedente
- **THEN** la risposta è A

#### Scenario: dopo una risposta si va avanti, non indietro
- **GIVEN** l'ultimo passo ha portato su B con `queue = [A, B, C]`
- **AND** hai risposto a B, quindi ora `queue = [A, C]` e il fuoco è ancora su B
- **THEN** la risposta è C

#### Scenario: nessun'altra meta
- **GIVEN** `queue = [A]` e il fuoco su A, oppure `queue = []`
- **THEN** la risposta è `null`

#### Scenario: in app, nessun'altra chat ti aspetta
- **GIVEN** su `:13334` una sola chat A ferma su un permesso (`needs-you(permission)`), a fuoco
- **WHEN** si preme ⌘J
- **THEN** compare il `toast` «Nessun'altra chat ti aspetta»
- **AND** la tab a fuoco è ancora A

#### Scenario: l'ordine è quello della sidebar
- **GIVEN** una chat fissata F in attesa, una chat P in attesa dentro un progetto, e una chat L in attesa fuori dai progetti che nella lista sta sopra al progetto
- **WHEN** si calcola `waitingQueue`
- **THEN** la coda è `[F, L, P]`

#### Scenario: una chat fissata dentro un progetto conta una volta
- **GIVEN** una chat X fissata e in attesa dentro un progetto, e una chat A in attesa fuori dai progetti
- **WHEN** si calcola `waitingQueue`
- **THEN** la coda è `[X, A]`, e la sua lunghezza, che è il numero della porta di CHAT-WAIT-04, è 2

#### Scenario: una chat in attesa dentro un progetto fissato
- **GIVEN** un progetto fissato con dentro una chat Q in attesa, e una chat A in attesa fuori dai progetti
- **WHEN** si calcola `waitingQueue`
- **THEN** la coda è `[Q, A]`

#### Scenario: un turno finito non è una meta
- **GIVEN** una chat `finished(done)` non vista, e una in `background`
- **THEN** nessuna delle due è nella coda

#### Scenario: un terminale fermo su un permesso è una meta
- **GIVEN** un terminale Claude Code `needs-you(permission)`
- **THEN** è nella coda, al posto della sua riga

#### Scenario: il piano del runtime nativo è una meta
- **GIVEN** una chat nativa il cui turno chiude aprendo il pannello del piano (`needs-you(plan)`)
- **THEN** è nella coda, e il numero della porta di CHAT-WAIT-04 la conta

#### Scenario: su Windows Ctrl+J resta al terminale
- **GIVEN** su `:13334` una chat A ferma su un permesso e il fuoco dentro un terminale
- **WHEN** si scrive `echo $((6*7))<marcatore>` e si preme Ctrl+J (`ctrlKey` sì, `metaKey` no)
- **THEN** il terminale stampa `42<marcatore>`: il tasto è arrivato alla shell come a capo
- **AND** A non riceve il fuoco
- **WHEN** si preme ⌘J nello stesso terminale
- **THEN** a fuoco va A

#### Scenario: su Windows Ctrl+J resta all'editor
- **GIVEN** su `:13334` una chat A ferma su un permesso e il fuoco dentro un editor CodeMirror (`.cm-editor`) di un progetto
- **WHEN** si preme Ctrl+J e poi si scrive un marcatore
- **THEN** il marcatore compare nell'editor e A non riceve il fuoco
- **WHEN** si preme ⌘J nello stesso editor
- **THEN** a fuoco va A

#### Scenario: Ctrl+J scatta anche dal composer
- **GIVEN** su `:13334` una chat A ferma su un permesso e il fuoco nel composer di un'altra chat
- **WHEN** si preme Ctrl+J
- **THEN** a fuoco va A

#### Scenario: in una finestra-gruppo ⌘J va dove va il clic sulla riga
- **GIVEN** su `:13334` una finestra `?space=<G>` con A nel gruppo G e B nel gruppo Principale, entrambe ferme su un permesso, e il fuoco su A
- **WHEN** si preme ⌘J
- **THEN** la tab a fuoco è B, il gruppo attivo è Principale e la query dice `space=space:default`
- **WHEN** si preme ⌘J di nuovo
- **THEN** la tab a fuoco è A e il gruppo attivo è di nuovo G

#### Scenario: una meta fissata con la tab in un altro gruppo
- **GIVEN** la stessa finestra `?space=<G>`, con B fissata e la sua tab nel gruppo Principale
- **WHEN** si preme ⌘J
- **THEN** la tab a fuoco è B e il gruppo attivo è Principale
- **WHEN** dopo essere tornati su A si clicca la tessera di B
- **THEN** la tab a fuoco è di nuovo B, nel gruppo Principale

#### Scenario: una tessera progetto o browser con la tab in un altro gruppo
- **GIVEN** la finestra `?space=<G>`, con un progetto e un browser fissati e le loro tab nel gruppo Principale
- **WHEN** si clicca la tessera del progetto
- **THEN** il gruppo attivo è Principale e la tab del progetto è attiva
- **WHEN** di nuovo in `?space=<G>` si clicca la tessera del browser
- **THEN** il gruppo attivo è Principale e la tab del browser è attiva

#### Scenario: nella finestra normale ⌘J commuta la griglia sul gruppo della meta
- **GIVEN** su `:13334` una finestra senza `?space=`, con A nel gruppo G e B nel gruppo Principale, entrambe ferme su un permesso, la finestra su Principale e il fuoco su B
- **WHEN** si preme ⌘J
- **THEN** la tab a fuoco è A, il gruppo attivo è G e la URL non ha `space`
- **WHEN** si preme ⌘J di nuovo
- **THEN** la tab a fuoco è B e il gruppo attivo è di nuovo Principale

#### Scenario: l'accordo passa anche da una pane browser
- **WHEN** la tabella decisionale dei tasti riceve Ctrl+J (`chords.rs`)
- **THEN** l'accordo è inoltrato alla webview principale come `key:'j'`

