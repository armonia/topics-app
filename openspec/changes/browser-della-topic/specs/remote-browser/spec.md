# Spec delta: browser-della-topic

## ADDED Requirements

### Requirement: TOPIC-BROWSER-01 — Il browser di una topic è una finestra con tre stati

Ogni topic SHALL avere al più UNA finestra browser, con le schede aperte da quella
topic. La finestra SHALL stare in uno di questi stati:

- **minimizzato**: flottante sopra l'area della topic, con dimensione predefinita,
  trascinabile; la chat SHALL restare larga e scorrere sotto;
- **espanso**: agganciata al lato destro dell'area della topic; la chat SHALL
  cedere lo spazio che la finestra occupa, e la larghezza SHALL regolarsi
  trascinando il bordo sinistro;
- **nascosto**: chiusa, con le schede conservate e un comando in alto a destra
  dell'area della topic per riaprirla (non nella barra: una topic autonoma non
  ne ha una).

La barra della finestra SHALL elencare le schede della topic, con la scheda attiva
che mostra la pagina viva; le schede aperte da altre superfici del progetto SHALL
essere raggiungibili dal «+», non elencate.

Una scheda SHALL poter diventare **tab**: una pane browser nel layout, con lo stesso
`contextId`, quindi la stessa pagina, cronologia e agente che la guida. Da tab SHALL
poter tornare nella finestra senza ricaricare. Una scheda NON SHALL essere nella
finestra e nel layout nello stesso momento.

Stato, posizione e larghezza SHALL persistere per topic e SHALL sincronizzarsi tra i
dispositivi con la stessa semantica LWW delle altre chiavi ui-state. La finestra e
le sue schede NON SHALL entrare in `pane-store-v2` finché restano nella finestra.

Sotto i 768 px di larghezza la finestra NON SHALL esistere: le schede SHALL aprirsi
come tab.

#### Scenario: minimizzata, la chat non cambia larghezza
- **GIVEN** una topic con la finestra browser minimizzata su una scheda
- **WHEN** si misura la larghezza della lista dei messaggi
- **THEN** è la stessa di quando la finestra è nascosta
- **AND** la finestra mostra la pagina della scheda attiva, non un'immagine

#### Scenario: espansa, la chat cede lo spazio
- **GIVEN** la stessa topic
- **WHEN** l'utente espande la finestra
- **THEN** la finestra occupa il lato destro dell'area della topic
- **AND** il bordo destro della lista dei messaggi non supera il bordo sinistro della finestra

#### Scenario: la posizione resta per topic
- **GIVEN** una finestra minimizzata trascinata nell'angolo in basso a sinistra
- **WHEN** l'utente cambia topic e torna, oppure ricarica l'app
- **THEN** la finestra è di nuovo in quell'angolo

#### Scenario: una scheda diventa tab e torna indietro
- **GIVEN** una finestra con due schede, attiva la prima
- **WHEN** l'utente sceglie «Apri come tab»
- **THEN** compare una pane `[data-browser-pane]` nel layout con lo stesso `contextId` e lo stesso URL
- **AND** la finestra elenca solo la seconda scheda
- **WHEN** dalla tab l'utente sceglie «Riporta nella chat»
- **THEN** la pane sparisce dal layout e la scheda torna attiva nella finestra, sulla stessa pagina senza ricaricarla

#### Scenario: telefono
- **GIVEN** un viewport largo 390 px
- **WHEN** un link della chat apre un sito
- **THEN** non c'è nessuna finestra flottante e il sito si apre come tab

### Requirement: TOPIC-BROWSER-02 — La tab è l'unica chrome, e si apre in un foglio

Una scheda browser SHALL avere una sola superficie di chrome: la sua tab. NON SHALL
esistere una riga dell'indirizzo separata, un menu a tendina dei comandi, né un
portale separato per modificare l'indirizzo.

Un clic sulla tab attiva, sui suoi tre puntini, oppure ⌘L SHALL aprire il **foglio
della tab**: un pannello che nasce dalla tab e contiene, in quest'ordine,
l'indirizzo in un campo già a fuoco e con il testo selezionato, i comandi di
navigazione, i suggerimenti, e tutti i comandi della scheda disposti in chiaro
(strumenti, zoom, dispositivo, sessione, dimentica sito, e lo spostamento tra
finestra e tab).

Il foglio SHALL vivere nel sottoalbero React della sua tab e SHALL sparire quando
quella tab sparisce. Il nodo DOM che lo ospita NON è vincolato: il vincolo è la
VITA del pannello, non il suo indirizzo nell'albero.

> Precisazione del 13/09, dopo una misura. La prima stesura diceva «il foglio NON
> SHALL essere un portale fuori dal contenitore della tab», e quella frase
> descriveva il rimedio invece del male. Il male era il vecchio
> `browser-address-dropdown`: un pannello che SOPRAVVIVEVA al proprio ancoraggio,
> perché una pane si chiude, cambia gruppo o torna tab mentre il suo pannello è
> aperto. Stare nel sottoalbero della tab è ciò che lo cura.
>
> Ma il nodo DOM non può stare lì: la striscia delle tab ha un antenato
> TRASFORMATO, e un antenato trasformato diventa il blocco contenitore di ogni
> `position: fixed` dentro di sé. Misurato sull'E2E di `BROWSER-CHROME-INLINE-01`:
> col pannello posato a `top: 8` il suo bordo superiore stava a **y = -3**,
> contro una tab il cui bordo inferiore è a 34 — un'altezza di striscia sopra il
> punto in cui era stato messo, cioè fuori dallo schermo. `createPortal` sul
> `body` tiene la vita React (muore con la tab) e restituisce al `fixed` la
> finestra come riferimento.

Mentre il foglio copre la pagina, la pagina SHALL essere un fermo immagine. Invio
SHALL navigare e chiudere; Esc e un clic fuori SHALL chiudere senza navigare. Alla
chiusura la pagina SHALL tornare viva.

La stessa regola SHALL valere per la finestra della topic e per una scheda in stato
tab.

#### Scenario: un clic sulla tab dà l'indirizzo pronto da riscrivere
- **GIVEN** una scheda attiva su `https://example.com/a`
- **WHEN** l'utente fa clic sulla tab
- **THEN** il foglio è aperto, il campo indirizzo ha il fuoco e tutto il testo è selezionato
- **AND** console, zoom e dispositivo sono visibili senza aprire un altro menu

#### Scenario: nessuna riga dell'indirizzo, mai
- **GIVEN** una scheda su una pagina caricata, nei rami nativo, iframe e streaming
- **WHEN** l'utente apre la console dal foglio, oppure parte un download
- **THEN** non compare nessuna riga dell'indirizzo sopra la pagina

#### Scenario: Esc non naviga
- **GIVEN** il foglio aperto con l'indirizzo modificato ma non confermato
- **WHEN** l'utente preme Esc
- **THEN** il foglio si chiude, la scheda resta sull'URL di prima e la pagina è di nuovo viva

### Requirement: TOPIC-BROWSER-03 — Niente sopra la pagina: il tipo della scheda è un'icona nella tab

Nessun elemento DOM permanente SHALL stare sopra l'area della pagina di una scheda
browser. Lo stato di connessione, il motore e la modalità di condivisione SHALL
comparire come un'icona dentro la tab, tra favicon e titolo, solo quando differiscono
dal tipo predefinito (vista nativa, non condivisa, connessa). I commutatori di motore
e di resa SHALL stare nella sezione Sessione del foglio della tab.

Il motore Playwright del server NON SHALL essere etichettato «Nativo».

Uno stato temporaneo attivato dall'utente sopra la pagina, come la modalità di
selezione dell'elemento, resta ammesso finché la modalità è attiva.

#### Scenario: una scheda condivisa
- **GIVEN** una scheda in modalità condivisa, connessa, su motore Playwright
- **THEN** `browser-engine-toggle`, `browser-render-toggle` e `browser-connection-indicator` non esistono dentro l'area della pagina
- **AND** la tab porta l'icona della condivisione
- **AND** il foglio della tab contiene i commutatori di motore e di resa

#### Scenario: una scheda normale
- **GIVEN** una scheda sulla vista nativa, non condivisa
- **THEN** la tab non porta nessuna icona di tipo

### Requirement: TOPIC-BROWSER-04 — Un sito aperto senza il gesto dell'utente non cambia il layout

Un link cliccato in una chat di topic SHALL aprire il sito come scheda della finestra
della topic, e lo stesso SHALL fare un `open_browser_pane` dell'agente di quella topic,
nello stato in cui la finestra si trova (una finestra nascosta SHALL diventare
minimizzata). Se una scheda con quel contesto è già una tab, SHALL navigare quella
tab. Nessuna delle due aperture SHALL creare uno split o spostare una pane del layout.

`/browser <url>` nel composer SHALL aprire la scheda nella finestra espansa, perché è
una richiesta esplicita di guardare.

#### Scenario: l'agente apre un sito mentre l'utente scrive
- **GIVEN** una topic con chat e terminale nel layout, e nessuna finestra browser
- **WHEN** l'agente chiama `open_browser_pane` con un URL
- **THEN** il layout ha le stesse pane con le stesse dimensioni
- **AND** la finestra della topic è minimizzata con una scheda su quell'URL

#### Scenario: un link con la scheda già in tab
- **GIVEN** una scheda della topic già aperta come tab
- **WHEN** l'agente apre un altro URL sullo stesso contesto
- **THEN** la tab naviga e nessuna finestra compare

### Requirement: TOPIC-BROWSER-05 — In condivisione il viewport lo decide chi usa la pagina

Quando più client mostrano lo stesso contesto browser, il server SHALL applicare le
dimensioni del viewport solo dal client che ha mandato l'ultimo input alla pagina
(puntatore, tastiera o rotella). In assenza di input, SHALL valere il primo client
connesso. Un client che si connette senza interagire NON SHALL cambiare il viewport.

Un client il cui contenitore ha dimensioni diverse dal viewport SHALL mostrare la
pagina in scala, centrata, su un fondo del tema, e NON SHALL lasciarla in alto a
sinistra su bianco. La resa DOM SHALL applicare anche i cambi di viewport a sessione
avviata (rrweb ViewportResize), non solo quello iniziale.

#### Scenario: un telefono che guarda non rimpicciolisce il Mac
- **GIVEN** un contesto condiviso usato dal Mac a 1280×800
- **WHEN** un telefono si connette allo stesso contesto con un contenitore da 390×700 e non tocca la pagina
- **THEN** il viewport del contesto resta 1280×800
- **AND** il telefono vede la pagina in scala, centrata

#### Scenario: chi tocca guida
- **GIVEN** lo stesso contesto
- **WHEN** l'utente del telefono fa scorrere la pagina
- **THEN** il viewport passa alle dimensioni del telefono
- **AND** il Mac vede la pagina in scala e centrata, e non su bianco in alto a sinistra

## MODIFIED Requirements

### Requirement: BROWSER-CHAT-02 — Live pane transport: push frames, input latency, degradation and recovery

The system SHALL stream the remote browser pane over a per-context WebSocket
(`/ws/browser/:id`), driving the pane's rendered surface, and SHALL degrade and recover
without stranding the pane. Numeric ceilings are read from
`tests/e2e/perf-baseline.json` (`browser_ws_streaming`), not hard-coded here.

Un download che PARTE SHALL annunciarsi in una spia dentro la tab, nella corsia dei
segnali; NON SHALL aprire da sé nessuna superficie sopra la pagina. Un clic sulla spia
SHALL aprire il foglio della tab con la sezione Download già aperta. Alla rimozione
dell'ultima voce la spia SHALL sparire.

> Cosa cambia e perché. La versione precedente diceva «il bottone compare nella
> TOOLBAR e il menu si apre da sé», e quella barra non esiste più
> (`TOPIC-BROWSER-02`). Il foglio non è il suo erede per questo: copre la pagina e
> la congela, quindi un file che arriva mentre leggi fermerebbe la lettura per
> riferire una cosa che in quell'istante nessuno ha chiesto. Resta vero il
> reclamo originale che aveva prodotto lo scenario — un download non deve essere
> muto — e resta vero il suo seguito: la lista è chiudibile e riapribile.

#### Scenario: First frame arrives push-driven after the socket opens
- **GIVEN** a browser pane is mounted for a topic via the `browser:open-and-navigate` event
- **WHEN** the first `frame` message arrives on the browser WebSocket
- **THEN** the elapsed time since the socket opened is below the `first_frame_ms_ceiling` baseline

#### Scenario: Input round-trip stays under the p95 ceiling
- **GIVEN** a connected pane whose clickable surface is the WebRTC `<video>` element
- **WHEN** the user clicks it repeatedly until at least `input_latency_sample_size_min` click→frame pairs are measured
- **THEN** the p95 of those round trips is below the `input_latency_p95_ms_ceiling` baseline

#### Scenario: Sustained frame rate stays within the bandwidth ceiling
- **GIVEN** a connected pane receiving frames
- **WHEN** at least `frame_count_in_2s_floor` frames have arrived
- **THEN** the measured bandwidth is below the `bandwidth_kbps_ceiling` baseline

#### Scenario: A transient socket drop reconnects and the surface returns
- **GIVEN** a connected pane showing the WebRTC `<video>` surface
- **WHEN** the WebSocket is closed underneath it
- **THEN** the client opens a NEW socket rather than staying in polling
- **AND** the `<video>` surface returns once the transport renegotiates

#### Scenario: With no socket at all the pane reports fallback, never "connecting"
- **GIVEN** the browser WebSocket constructor throws so no socket can be opened
- **WHEN** the pane mounts
- **THEN** the connection indicator is visible and carries the `connection-fallback` class within the `fallback_http_grace_ms_ceiling` baseline
- **AND** it does not carry the `connection-connecting` class

#### Scenario: The pane streams its real size on open and on resize
- **GIVEN** a browser pane has just opened its socket
- **THEN** a `resize` message is sent carrying a positive width, a positive height and a `deviceScaleFactor` of at least 1
- **WHEN** the window is resized
- **THEN** a further `resize` message is sent

#### Scenario: A download announces itself in the tab and is dismissible
- **GIVEN** a connected pane
- **WHEN** the server pushes a completed download
- **THEN** a downloads cue appears in the tab, no address row appears over the page, and the tab sheet does not open by itself
- **WHEN** the user clicks that cue
- **THEN** the sheet opens with the downloads list already open, the address field is not focused, and the entry names the file, links to its href and shows its size
- **WHEN** the user presses Escape the list closes, and clicking the downloads row in the sheet reopens it
- **WHEN** the user dismisses the last entry, the cue disappears from the tab


### Requirement: LINK-TAB-02 — Where the link-opened tab lands

The system SHALL place a link-opened tab beside the browser strip the user is already
looking at rather than tiling a new cell for every link, and SHALL insert it right after
the tab it was opened from, the way a browser does. When no browser pane exists yet, the
system SHALL split one out beside the pane the click came from, keeping the source pane
visible.

A link clicked in the chat of a topic SHALL NOT follow this rule on a viewport of 768 px
or wider: it SHALL land in that topic's browser window as specified by
`TOPIC-BROWSER-04`. This rule keeps governing links from terminals, browser panes,
project windows, task drawers, and every origin on a narrower viewport.

#### Scenario: A link in a topic chat lands in the topic window
- **GIVEN** a desktop-width window whose focused group holds a topic chat and a terminal, and no browser pane
- **WHEN** a link in that chat is opened
- **THEN** no split is created and the topic's browser window shows the link as its active tab

#### Scenario: The first link from a terminal splits a browser out beside it
- **GIVEN** a window whose focused group holds a chat and a terminal, and no browser pane
- **WHEN** a link is opened from the terminal
- **THEN** the target is that same group, split, anchored right after the terminal

#### Scenario: The second link joins the strip the first one made
- **GIVEN** a window that already has a group holding a browser pane
- **WHEN** another link is opened from a non-chat origin
- **THEN** the tab joins THAT group without splitting, anchored on its browser pane

#### Scenario: The click's origin wins over the focus
- **GIVEN** a click coming from a terminal or from a browser pane that is not the focused one
- **WHEN** the link is opened
- **THEN** the tab lands beside the pane the click came from, not where focus happened to be

#### Scenario: A vanished anchor appends instead of throwing
- **GIVEN** an anchor pane id that no longer exists in the group
- **WHEN** the tab is inserted
- **THEN** it is appended at the end of the strip and no error reaches the user
