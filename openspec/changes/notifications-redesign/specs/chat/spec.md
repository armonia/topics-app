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

### Requirement: BGVIS-01 — Una chat che aspetta il suo lavoro in background è in corso, con l'anello di lavoro

Quando una chat non ha un turno aperto ma il suo ultimo turno ha lasciato lavoro
in background (stato di attenzione `working` con compiti in volo, ATTN-01), la
riga di sidebar, la sua tab e, a cartella chiusa, il roll-up del progetto SHALL
mostrare l'anello di lavoro in corso, lo stesso di un turno che risponde:
`LoaderSlot` con `data-loader-state="working"`. Il terzo glifo grigio e lento
(`background`) non esiste più (modifica del 2026-10-04, richiesta di Attilio:
«uniformare lo stato in cui sta attendendo un job da finire»).

Precedenza, sulla stessa riga o sullo stesso progetto: `waiting` (ambra) >
`working` (blu). Su un fill di attenzione l'arco di lavoro SHALL prendere
l'inchiostro tenue del fill (`loaderArcClass`), come il tempo che sostituisce.
Con `prefers-reduced-motion` l'arco SHALL stare fermo.

Il tooltip dell'anello di una chat senza turno aperto SHALL dire quanti lavori
girano e che la chat è libera (chiavi i18n it/en). `ProjectElapsed` NON SHALL
contare il lavoro in background: misura il turno più vecchio in corso. Il
composer resta libero (BGVIS-02): la chat è in corso ma un messaggio parte subito.

#### Scenario: la riga di sidebar di una chat in background
- **GIVEN** lo stato di attenzione della chat T `working` con due compiti, nessun turno aperto
- **WHEN** la sidebar mostra la chat T
- **THEN** la riga di T contiene `[data-loader-state="working"]`, col tooltip «2 lavori in background. La chat è libera…»
- **AND** non contiene `[data-loader-state="waiting"]`

#### Scenario: la tab e il progetto chiuso dicono lo stesso
- **GIVEN** la chat T in attesa del suo lavoro, aperta in una tab, dentro il progetto P
- **WHEN** la cartella di P è chiusa in sidebar
- **THEN** la tab di T e la riga di P mostrano `[data-loader-state="working"]`, e P nessun tempo vivo

#### Scenario: il lavoro torna
- **GIVEN** la chat T in attesa di un Bash in background, non guardata
- **WHEN** il Bash torna e il turno che lo riporta chiude
- **THEN** la riga di T ha `data-attention="done"` e nessun `[data-loader-state]`

### Requirement: BGVIS-03 — Le chat in background contano fra gli agenti al lavoro

`activeAgentRowsFrom` (`client/src/state/signals.ts`) SHALL mettere una chat o
un terminale `working` sullo stato di attenzione (anche senza turno aperto, in
attesa del suo lavoro) fra i `working`, una riga per soggetto (mai per task),
solo per le chat a schermo, mai due volte. Non esiste più un gruppo
`background` né un'intestazione «In background» nel menu (modifica del
2026-10-04).

Il numero sul pulsante del menu e la coda della riga «Agenti attivi» SHALL contare
`working`, calcolati da una sola funzione sulle stesse righe, così numero ed
elenco non possono divergere (STATUSLINE-05).

#### Scenario: una chat in background è un agente al lavoro
- **GIVEN** la chat T in attesa del suo lavoro, nessun turno aperto
- **WHEN** si calcola `activeAgentRowsFrom`
- **THEN** `working` contiene una riga `{id: T, kind: "topic"}`
- **AND** il numero sul pulsante del menu vale 1

#### Scenario: una chat archiviata non conta
- **GIVEN** la chat T in attesa del suo lavoro ma archiviata
- **WHEN** si calcola `activeAgentRowsFrom`
- **THEN** `working` è vuoto

### Requirement: BGVIS-08 — Un server lanciato dalla chat si vede come server, non come lavoro che la chat aspetta

Un comando lanciato con `run_command` che NON sveglia la chat (`wake: false`) e
il cui albero di processi ascolta su almeno una porta TCP SHALL essere un
**server** della chat: non lavoro in background che la chat aspetta. Lo stesso
vale per uno script del progetto che l'agente avvia con `run_script` (modifica
del 2026-10-04): la sua riga nel registro porta la chat della sessione che l'ha
lanciato, e uno script non sveglia mai nessuno.

Dal 2026-10-04 il lavoro che la chat aspetta è lavoro in corso (ATTN-01, ATTN-02):
il server è l'UNICO stato a parte. La riga della chat in sidebar SHALL portare,
fra i segni quieti della coda, il segno del server (`data-testid="row-server-sign"`,
icona `Server` di lucide, tooltip «Server acceso: <indirizzo>…» da i18n) finché
un suo server è in corsa, senza anello di lavoro, senza fill e senza contare
nella inbox né fra gli agenti al lavoro. Un server appena finito non ha il segno. Un comando
che sveglia la chat resta lavoro atteso (BGVIS-07) anche se ascolta su una
porta; uno che non ascolta su niente pure.

Il caso da cui nasce (01/10, Attilio su una chat viva: «questa sessione ha la
chat in attesa di un lavoro in background ma invece dovrebbe essere un processo
Topics e si dovrebbe vedere che il server è attivo»): l'agente aveva lanciato
`python3 -m http.server 8777 --bind 127.0.0.1` con `run_command` senza sveglia;
la chat diceva «In attesa di 1 lavoro in background» con l'anello grigio sulla
tab per tutta la vita del server, e `GET /api/processes?topicId=` di quella
chat rispondeva `[]` mentre la chat nominava il processo.

- Riconoscimento, misurato e non indovinato dal testo del comando: le porte in
  ascolto dell'albero del processo (`lsof`, `server/lib/command-services.ts`),
  guardate da un timer che gira solo mentre c'è un comando senza sveglia in
  corsa (2 s all'inizio, raddoppio fino a 30 s finché niente cambia, di nuovo
  2 s a ogni avvio). Finché un comando senza porta ha meno di 2 minuti, il
  raddoppio SHALL fermarsi a 5 s: un server che compila a lungo si vede entro
  5 s dal momento in cui apre la porta. La route di stato NON SHALL lanciare `lsof`.
- Un server NON SHALL comparire fra i `tasks` di `/api/topics/streaming`: niente
  riga `background-work-line`, niente anello di lavoro su riga, tab e
  progetto, niente riga fra gli agenti al lavoro, e lo Stop del composer non lo
  riguarda. La risposta SHALL portare a parte `services: [{topicId, sessionKey,
  services}]` (`TopicServices`, `shared/background-work.ts`).
- In chat, nel `Footer` del trascritto sotto la riga di BGVIS-04, una riga
  compatta per server `data-testid="running-service-row"` (non un banner):
  «Server · 127.0.0.1:8777 · nome» con **Apri** (una tab del browser di Topics
  sull'indirizzo, attraverso `openLink` come ogni link della chat), **Log** (il
  log del processo nella finestra di progetto, evento `open-process-log`) e
  **Ferma** (`POST /api/scripts/:id/stop`). Entra con `reveal-in`.
- Dal vivo: un avvio, una fine e una porta che compare o sparisce SHALL mandare
  `background:changed`, come per BGVIS-06/07.
- Fine: per `SERVICE_END_SHOWN_MS` (8 s) dopo l'uscita il server resta fra i
  `services` con `ended: {at, exitCode, stopped}`; la riga dice come è finito
  («Server fermato», «Server terminato (exit N)») e sparisce da sé dopo 5 s.
- Un server che sta finendo (fermato, o col processo morto e la riga non ancora
  chiusa: uno riadottato dopo un riavvio si chiude al controllo del pid ogni
  3 s) SHALL tenere i suoi indirizzi anche se il timer non vede più la porta:
  non torna fra i `tasks` e la sua fine resta detta con `ended`.
- `GET /api/processes?topicId=` SHALL elencare, prima dei sotto-agenti, i
  processi `run_command` di quella chat (in corsa e recenti), con le porte.

#### Scenario: il registro distingue un server da un comando atteso
- **GIVEN** un comando senza sveglia che avvia un vero server HTTP su una porta
  libera, e uno identico con la sveglia
- **WHEN** il timer vede la porta del primo
- **THEN** il primo è fra i `services` della chat con `listen: [{host:
  "127.0.0.1", port}]` e non fra i `tasks`; il secondo resta fra i `tasks`
- **AND** `GET /api/processes` della chat lo elenca `running` con la porta
- **WHEN** lo si ferma
- **THEN** è fra i `services` con `ended.stopped` e senza exit code
- **AND** il server non risponde più sulla sua porta prima che il test finisca

#### Scenario: un server che sta finendo non torna lavoro atteso
- **GIVEN** il timer conosce le porte di tre server
- **WHEN** un passaggio non vede più nessuna porta, e del primo il processo è
  morto, il secondo è stato fermato, il terzo è vivo
- **THEN** il primo e il secondo tengono i loro indirizzi e il terzo li perde
- **AND** chiusa la riga del primo, i `services` dicono come è finito

#### Scenario: una chat vera avvia un server
- **GIVEN** una chat in una finestra di progetto su una CLI finta
  (`helpers/fake-claude-service.ts`) che lancia con `run_command` senza sveglia
  un vero server HTTP su una porta libera
- **THEN** la chat ha UNA riga `running-service-row` con `127.0.0.1:<porta>` e
  il nome, nessuna `background-work-line`, nessun anello di lavoro sulla tab
  e nessuno Stop nel composer
- **AND** `GET /api/processes?topicId=` lo elenca `running` con la porta
- **WHEN** si clicca Apri
- **THEN** parte una `browser:open-tab` su `http://127.0.0.1:<porta>/` per quella chat
- **WHEN** si clicca Log
- **THEN** il log del processo si apre come tab della finestra di progetto
- **WHEN** si clicca Ferma
- **THEN** la riga dice «Server fermato» e poi sparisce

#### Scenario: con la sveglia resta lavoro atteso
- **GIVEN** la stessa CLI finta che lancia lo stesso server CON la sveglia
- **WHEN** il server risponde sulla sua porta
- **THEN** la riga `background-work-line` lo nomina con «sveglia la chat» e non
  c'è nessuna `running-service-row`

#### Scenario: un dev server avviato con run_script
- **GIVEN** una chat di progetto su una CLI finta che avvia con `run_script` lo
  script `serve` del progetto, un vero server HTTP su una porta libera
- **WHEN** il server risponde sulla sua porta
- **THEN** la riga della chat in sidebar ha `row-server-sign` col suo indirizzo
  nel tooltip e nessun `[data-loader-state]`, lo stato di attenzione non è
  `working`, e la inbox non ha la riga quieta
- **WHEN** il server si spegne
- **THEN** il segno sparisce
