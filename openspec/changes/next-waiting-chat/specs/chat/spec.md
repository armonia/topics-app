# Chat — la prossima chat che ti aspetta

## ADDED Requirements

### Requirement: CHAT-WAIT-03 — ⌘J porta alla prossima chat che ti aspetta

Un comando SHALL portare il fuoco sulla prossima riga della sidebar in attesa di
una tua risposta, nel senso di CHAT-WAIT-01: ferma su una domanda, un permesso o
un piano da approvare. Da tastiera è `Mod+J` (⌘J sul Mac, Ctrl+J altrove).

**Le mete.** Una meta SHALL essere una riga chat il cui topic sta in
`awaitingInputTopics`, oppure una riga terminale Claude Code il cui id sta in
`claudePhaseAwaitingInputTermIds`: le righe che la sidebar colora d'ambra. Una
chat al lavoro, una chat col turno finito (`awaiting-user`, `paused`) e un
sotto-agente annidato NON SHALL essere mete. Il «visto» non conta: una meta
guardata resta una meta finché la domanda è aperta.

**L'ordine.** Le mete SHALL essere ordinate da una funzione pura
`waitingQueue(allItems, pinnedIds, sig)` in `client/src/lib/waitingQueue.ts`:
prima le righe fissate, nell'ordine dei Fissati; poi quelle che
`groupSidebarItemsByState` mette in «Attende te», nel loro ordine. La coda SHALL
partire da tutte le righe, ignorando il filtro di ricerca della sidebar.

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
sulla riga (`handleChatRowClick` per le chat, `onTerminalClick` per i terminali).

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
- **GIVEN** su `:13334`, vista per stato, tre chat: A ferma su un permesso (`session:state` con fase `awaiting-approval`), B ferma su una domanda dentro l'app (stream aperto e ultima riga con `mcp__topics__ask_user_question` in `waiting_for_input`), C con uno stream aperto e nessuna domanda
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
- **AND** in app compare l'avviso e il fuoco non cambia

#### Scenario: l'ordine è quello della sidebar
- **GIVEN** una chat fissata F in attesa, una chat P in attesa dentro un progetto, e una chat L in attesa fuori dai progetti che nella lista sta sopra al progetto
- **AND** un filtro di ricerca della sidebar che nasconde L
- **WHEN** si calcola `waitingQueue`
- **THEN** la coda è `[F, L, P]`

#### Scenario: un turno finito non è una meta
- **GIVEN** una chat in `awaitingFeedbackTopics` per la fase `awaiting-user` e non in `awaitingInputTopics`
- **THEN** non è nella coda

#### Scenario: un terminale fermo su un permesso è una meta
- **GIVEN** un terminale Claude Code in `claudePhaseAwaitingInputTermIds`
- **THEN** è nella coda, al posto della sua riga

#### Scenario: l'accordo passa anche da una pane browser
- **WHEN** la tabella decisionale dei tasti riceve Ctrl+J (`chords.rs`)
- **THEN** l'accordo è inoltrato alla webview principale come `key:'j'`

### Requirement: CHAT-WAIT-04 — Sul telefono la stessa coda è una porta in fondo

La fila in fondo al telefono (`MobileChromeBar`) SHALL avere una porta «In
attesa», prima del Profilo, con il glifo `Hourglass` della sezione «Attende te».

- Il numero sulla porta SHALL essere la lunghezza della coda di CHAT-WAIT-03,
  letta dallo stesso store: numero e mete non possono divergere.
- Premerla SHALL fare lo stesso passo di ⌘J (evento `topics:next-waiting`).
- A coda vuota la porta SHALL restare al suo posto, `disabled`, con un titolo
  che dice che nessuna chat ti aspetta: le altre porte NON SHALL spostarsi quando
  il numero cambia.
- Il Profilo SHALL restare l'ultima porta; ogni porta SHALL restare almeno 44 px
  e la fila SHALL continuare a seguire la curva dello schermo agli estremi.

#### Scenario: la porta porta alle due in attesa
- **GIVEN** su `:13334` un viewport da telefono e le tre chat di CHAT-WAIT-03
- **THEN** `mobile-chrome-waiting` mostra `2`
- **WHEN** la si preme due volte
- **THEN** a fuoco va la prima meta e poi la seconda, e mai la chat al lavoro

#### Scenario: a zero è spenta e non sposta niente
- **GIVEN** nessuna chat in attesa
- **THEN** `mobile-chrome-waiting` è `disabled`
- **AND** le cinque porte hanno la stessa larghezza di quando il numero è `2`
