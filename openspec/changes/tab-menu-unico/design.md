# Design: tab-menu-unico

Misure lette sul codice di `origin/main` a `bbae359fb` (04/10). Righe di
`client/src/`.

## 1. Cosa c'è oggi

### 1.1 Il menu a tendina del tasto destro (tutte le tab della barra)

`components/Layout/PaneTabBar.tsx`, aperto da `handleContextMenu` (`:585`) e
dalla pressione lunga (`tabLongPress`, `:576`), disegnato su `ContextMenuPortal`
ancorato al rettangolo della tab (`:1543-2080`).

| # | Voce | Su quali tab | Riga | testid |
|---|------|--------------|------|--------|
| M1 | Fissa / Rimuovi dai Fissati / Fissa il progetto / Fissa questa tab | fissabili (`pinKeyForPane`) | 1553-1612 | `tab-menu-pin-project`, `tab-menu-pin-tab` |
| M2 | Ricarica (riavvia la sessione) | terminale | 1618-1649 | – |
| M3 | Cerca | pane con un cercatore (chat, terminale, browser, editor) | 1654-1668 | `tab-menu-find` |
| M4 | Rinomina (campo dentro il menu) | terminale; chat e browser se l'ospite lo cabla | 1675-1716 | – |
| M5 | Apri nel progetto | browser nel drawer di un task | 1734-1749 | `tab-menu-open-in-project` |
| M6 | Copia link alla tab / Copia link | tab indirizzabili | 1764-1771 | – |
| M7 | Copia URL della pagina | browser | 1772-1782 | – |
| M8 | Interrompi il turno | chat che lavora | 1793-1803, 2090 | `tab-menu-stop` |
| M9 | Chiudi ora | chiudibili | 1809-1820 | – |
| M10 | Chiudi (con conto alla rovescia) | chiudibili | 1821-1828 | – |
| M11 | Chiudi le altre | più di una tab | 1831-1846 | – |
| M12 | Ingrandisci / Ingrandisci solo questa / Riduci | dove lo zoom della cella esiste | 1862-1891 | `tab-menu-zoom`, `tab-menu-zoom-cell`, `tab-menu-unzoom` |
| M13 | Dividi a destra / Dividi in basso | dove gli split si disegnano | 1892-1910 | – |
| M14 | Reimposta pannelli | idem | 1923-1931 | – |
| M15 | Sposta nel gruppo › (gruppi, Nuovo gruppo) | non in finestra staccata | 1932-2000 | – |
| M16 | Sposta in una nuova finestra | chat | 2001-2015 | – |
| M17 | Stacca il gruppo in una nuova finestra | gruppo con più tab | 2017-2026 | – |
| M18 | Sposta in una cella separata | gruppo principale | 2029-2040 | – |
| M19 | Riporta nel pannello principale | cella separata | 2045-2056 | – |
| M20 | Impostazioni della chat | chat | 2058-2077 | – |

Massimo misurato per una tab browser di primo livello con split e più tab: 17
righe (M1, M3, M4, M6, M7, M9-M15, M17, M18 o M19), di cui 3 di chiusura.
Scritte fisse fuori dal catalogo: M1 (tutte e quattro le forme), M6 (due), M14,
e il ripiego «Gruppo» di M15.

### 1.2 Il foglio della tab browser

`components/Browser/BrowserTabSheet.tsx` (quando si apre e si chiude) e
`BrowserTabSheetBody.tsx` (cosa disegna, portale su `body`, `:268-634`). Porte:
clic sull'etichetta della tab attiva (`PaneTabBar.tsx:1412-1419`), tre puntini
(`BrowserTabChrome.tsx:313-331`), ⌘L, spia dei download.

| # | Voce | Riga | testid |
|---|------|------|--------|
| F1 | Indirizzo (a fuoco e selezionato) | 295-310 | `browser-tab-address-input` |
| F2 | Indietro, Avanti, Ricarica | 317-335 | `browser-tab-back`, `browser-tab-forward`, – |
| F3 | Copia indirizzo, Apri nel browser di sistema | 337-347 | `browser-tab-copy-url`, – |
| F4 | In questa scheda (fino a 5) | 350-367 | – |
| F5 | I tuoi siti (fino a 5) | 369-386 | – |
| F6 | Riporta nella chat | 388-395 | `browser-tab-return-to-window` |
| F7 | Torna alla chat che ha aperto questo browser | 397-405 | `browser-tab-spawner` |
| F8 | Console, Download, DevTools | 410-446 | `browser-tab-console`, `browser-tab-downloads`, `browser-tab-devtools` |
| F9 | Zoom (della pagina) | 450-473 | `browser-tab-zoom` |
| F10 | Dispositivo (5 segmenti + L×A) | 483-536 | `browser-tab-device`, `browser-tab-device-*` |
| F11 | Sessione: condivisione, motore, resa | 551-621 | `browser-tab-share`, `browser-tab-engine`, `browser-tab-render` |
| F12 | Dimentica questo sito… | 624-630 | `browser-tab-forget-site` |

Massimo: 22 righe (F1, la riga di F2+F3, 10 suggerimenti, una fra F6 e F7, 3
strumenti, zoom, dispositivo, 3 di sessione, F12).

Sulla tab stessa, fuori da entrambe: Ricarica al posto della favicon al passaggio
del puntatore (`BrowserTabChrome.tsx:93-105`, `browser-tab-reload`) e «Riprendi
il controllo» mentre un agente guida (`:251-272`, `browser-tab-take-control`),
tutti e due rivelati dal passaggio del puntatore.

### 1.3 Doppioni e buchi

- **Doppione:** M7 «Copia URL della pagina» e F3 «Copia indirizzo». Stessa azione,
  due nomi, conferma a toast nel menu e a icona nel foglio.
- **Parola doppia per due cose:** «Zoom» (F9, la pagina) e «Ingrandisci» (M12, la
  cella). Restano due comandi, con due nomi che non si confondono.
- **Solo nel menu:** M1, M3, M4, M5, M6, M8-M20. Dal foglio non si chiude, non si
  cerca e non si divide.
- **Solo nel foglio:** F1-F12. Dal tasto destro non si torna indietro e non si
  apre la console.
- **Coppia spezzata:** «Riporta nella chat» (F6, nel foglio) e «Apri come tab»
  (bottone della finestrella, `TopicBrowserWindow.tsx:571-578`) sono andata e
  ritorno, in due superfici diverse.

### 1.4 Le altre tab

| Superficie | Clic | Tasto destro / pressione lunga |
|------------|------|------------------------------|
| Tab chat, terminale, progetto, utilità della barra | attiva | il menu §1.1 |
| Schede della finestrella del browser della topic (`TopicBrowserWindow.tsx:540-556`) | attiva | niente dell'app; nessun foglio, contro `TOPIC-BROWSER-02` («la stessa regola vale per la finestra della topic») |
| Titolo sul telefono sotto 768 px (`StandaloneChatGroup.tsx:999-1037`) | – | solo sulla chat: un menu con «Impostazioni della chat» |
| Tab dell'editor di file (`EditorTabs.tsx:268`, `:290-314`) | attiva | Chiudi, Mantieni aperta, Copia percorso (fuori scope) |

## 2. La struttura proposta, voce per voce

Regole comuni:

- **Il primo livello** porta le voci che si cercano subito; tutto il resto sta in
  un livello, una riga con la freccia e lo stato in coda.
- **Un livello con una sola voce non esiste**: la voce sale al primo livello col
  suo nome. Un livello senza voci non si disegna.
- **Le voci contestuali** (dove vive la scheda, chi la guida) compaiono solo
  quando servono, in cima.
- **Ordine dei livelli fisso** su ogni tipo, così la posizione si impara una
  volta: Pagina, Strumenti, Sessione, Tab, Disposizione.

### 2.1 Tab browser nella barra

| Posto | Voce | Da | Note |
|-------|------|----|------|
| testata | Indirizzo | F1 | a fuoco e selezionato solo dalle porte dell'indirizzo (§D2) |
| testata | Indietro · Avanti · Ricarica · Copia indirizzo · Apri nel browser di sistema | F2, F3, M7 | M7 sparisce, resta F3 con la conferma a icona |
| sotto la testata | In questa scheda, I tuoi siti | F4, F5 | solo col fuoco nell'indirizzo |
| 1° livello, contestuale | Riprendi il controllo | tab | solo mentre un agente guida |
| 1° livello, contestuale | Riporta nella chat · Apri nel progetto · Torna alla chat che ha aperto questo browser | F6, M5, F7 | ognuna solo dove esiste |
| 1° livello | Cerca nella pagina (⌘F) | M3 | |
| 1° livello › Pagina | Zoom della pagina · Dispositivo (+ L×A) · Dimentica questo sito… | F9, F10, F12 | coda: «100% · Desktop». Il livello resta aperto dopo un clic su zoom e dispositivo |
| 1° livello › Strumenti | Console · Download · DevTools | F8 | coda: errori e download, nel colore del segnale |
| 1° livello › Sessione | Condivisione · Motore · Resa | F11 | coda: lo stato della condivisione |
| 1° livello › Tab | Rinomina · Fissa (o Fissa il progetto e Fissa questa tab) · Copia link alla tab | M4, M1, M6 | |
| 1° livello › Disposizione | Ingrandisci / Riduci · Ingrandisci solo questa · Dividi a destra · Dividi in basso · Reimposta pannelli · Sposta nel gruppo › · Sposta in una cella separata / Riporta nel pannello principale · Stacca il gruppo in una nuova finestra | M12-M15, M17-M19 | «Sposta nel gruppo» è un terzo livello (gruppi, Nuovo gruppo), non più una fisarmonica |
| 1° livello | Chiudi (⌘W) | M9 | chiude subito |
| 1° livello | Chiudi le altre | M11 | solo con più di una tab |
| – | ~~Chiudi (con conto alla rovescia)~~ | M10 | esce (§D5); il conto alla rovescia resta sulla X |

Primo livello sotto l'indirizzo: al massimo 3 contestuali + Cerca + 5 livelli + 2
chiusure = 11 righe.

### 2.2 Tab chat

Testata: il pallino del colore della topic, il nome, lo stato («sta lavorando»).
Primo livello: Interrompi il turno (M8, solo mentre lavora) · Cerca nella chat
(M3) · Impostazioni della chat (M20) · Tab › (Rinomina, Fissa, Copia link) ·
Disposizione › (come §2.1 più «Sposta in una nuova finestra», M16) · Chiudi ·
Chiudi le altre.

### 2.3 Tab terminale

Testata: il nome della sessione. Primo livello: Ricarica (M2) · Cerca (M3) · Tab ›
(Rinomina, Fissa, Copia link) · Disposizione › · Chiudi · Chiudi le altre.

### 2.4 Tab progetto e utilità (file, git, board, log)

Testata: il nome. Primo livello: Cerca (se la pane ha un cercatore) · Tab ›
(Fissa il progetto, Fissa questa tab, Copia link) · Disposizione › · Chiudi ·
Chiudi le altre. Una utilità con id sorteggiato non ha link e spesso non si
fissa: il livello Tab resta con zero o una voce, e la regola dei livelli lo
toglie o lo appiattisce.

### 2.5 Schede della finestrella del browser della topic

Come §2.1, con tre differenze: «Apri come tab» al posto di «Riporta nella
chat»; niente livello Tab (una scheda della finestrella non è nel pane-store,
quindi non si fissa e non ha permalink) e niente Disposizione (la finestrella
non ha split). Chiudi chiude la scheda (`topicBrowserWindow.close`).

### 2.6 Titolo sul telefono

La pressione lunga apre il foglio della superficie in primo piano (§2.1-2.4)
come foglio dal basso a tutta larghezza, bersagli da 44 px. Niente
Disposizione: sul telefono gli split non si disegnano (la regola «un comando
compare dove ha effetto» del requisito sugli split in `layout`).

## 3. Decisioni

### D1 — La tab si allunga, non apre un pannello

Mentre il foglio è aperto la tab porta `data-sheet-open` ed è dipinta con la
stessa superficie del foglio; il bordo inferiore della tab non c'è e il bordo
superiore del foglio si interrompe sotto la tab. Il foglio parte dal bordo
inferiore della tab, allineato al suo bordo sinistro (al destro quando a destra
non ci sta), con angolo vivo dal lato della tab e raggio normale sugli altri tre.

Il foglio resta un portale su `body` (la ragione è in `TOPIC-BROWSER-02`:
l'antenato trasformato della striscia), quindi la saldatura è un fatto di
**posa**, non di DOM: la posizione si calcola dal rettangolo della tab come
oggi (`computeMenuPosition`), e la tab si ridisegna da sé leggendo lo stato
aperto. Se la tab scorre fuori dalla striscia o cambia larghezza col foglio
aperto, il foglio si ripone (oggi la posa si rifà solo sul cambio di `chrome`).

Alternativa scartata come consigliata: pannello staccato come oggi. Non costa
niente, ma è esattamente il «nuovo dropdown» che la richiesta non vuole.

### D2 — Due porte, una struttura

Il guscio conosce tre porte (oggi due, `wantsCaret` vero o falso):

| Porta | Fuoco | Suggerimenti | Livello aperto |
|-------|-------|--------------|----------------|
| indirizzo: clic sulla tab browser attiva, tre puntini, ⌘L | indirizzo, testo selezionato | sì | nessuno |
| download: la spia nella tab | nessuno | no | Strumenti, con la lista dei download aperta |
| comandi: tasto destro, pressione lunga, Shift+F10, tasto menu | prima voce del primo livello | no | nessuno |

Il contatore delle richieste nuovo (`commandsOpenRequest`) sta in
`state/browserPaneChrome` accanto a `addressEditRequest` e
`downloadsOpenRequest` per le tab browser; per gli altri tipi il guscio è
aperto direttamente dalla barra, che non ha bisogno di un contatore pubblicato.

Un tasto destro sulla stessa tab col foglio aperto lo chiude (la regola
«porta che si richiude» di `BrowserTabSheet.tsx` vale anche per il tasto
destro); su un'altra tab chiude questo e apre quello.

### D3 — I livelli con `SubmenuItem`

`components/Shared/SubmenuItem.tsx` fa già tutto ciò che serve: livello di lato
con ribaltamento al bordo, apertura al passaggio del puntatore e blocco al clic,
uno per profondità, freccia destra e sinistra, Esc un livello per volta, foglio
dal basso sotto 768 px. Lo usano il menu utente e i suoi livelli.

Il rischio è uno solo, ed è il primo task: `SubmenuItem` nasce dentro un `Menu`,
e il foglio della tab non lo è. Due cose vanno verificate prima di qualunque
voce: che un clic dentro un livello conti come «dentro» per la regola del clic
fuori del foglio (oggi lo fanno console e download con `data-popover-owner`), e
che aprire un livello non chiuda il foglio per il registro «un popover alla
volta» (`lib/popoverRegistry`). Se una delle due non regge senza toccare
`SubmenuItem`, la si estende lì, non con una copia.

Alternativa: il livello prende il posto del foglio con una riga «Indietro». Tiene
tutto dentro la tab espansa, ma è una primitiva nuova e su desktop costa un
passo in più per tornare.

### D4 — Ogni tab, una superficie

Il blocco `ContextMenuPortal` di `PaneTabBar.tsx` si cancella. Il guscio
`TabSheet` (estratto da `BrowserTabSheet`) prende un contenuto per tipo:
`browserTabEntries`, `chatTabEntries`, `terminalTabEntries`, `utilityTabEntries`,
tutti costruiti con le stesse callback che la barra riceve oggi dall'ospite
(`onToggleFissato`, `onSplitRight`, `onPopOut`, …). Nessuna callback nuova
dall'ospite.

La rotaia di `CTXMENU-01` (`lib/contextMenuSurfaces.test.ts`) oggi accetta solo
`<ContextMenuPortal`. Accetterà anche `<TabSheet`, solo per le barre di tab
(`PaneTabBar.tsx`, `TopicBrowserWindow.tsx`, `StandaloneChatGroup.tsx`), così un
menu scritto a mano in un altro file resta rosso.

`data-testid`: il pannello è `tab-sheet` con `data-pane-type`; `browser-tab-sheet`
sparisce in un solo giro sulle 14 spec che lo leggono. Le voci tengono i testid
che hanno (`tab-menu-*`, `browser-tab-*`); quelle che non ne hanno ne prendono uno
`tab-sheet-<voce>`, e i livelli `tab-sheet-level-<nome>`.

### D5 — Due chiusure, non tre

Il menu oggi offre «Chiudi ora», «Chiudi (con conto alla rovescia)» e «Chiudi le
altre». Il tasto destro è già il gesto esplicito (lo dice il commento a
`PaneTabBar.tsx:1804-1808`), e il conto alla rovescia esiste per la X, che si
preme per sbaglio. Restano «Chiudi», immediata, e «Chiudi le altre».

## 4. Rischi

- **Saldatura e vista nativa.** Il foglio è `glass-surface`, quindi
  `lib/shell/browserOcclusion` parcheggia la WKWebView sotto; i livelli di lato
  coprono una parte di pagina in più, e anche loro devono portare il marcatore.
  `SubmenuItem` lo porta già (`role="menu"`).
- **19 spec E2E** fanno tasto destro su una tab e cercano una voce che passa in
  un livello. `splitViaContextMenu` (`tests/e2e/helpers/layout.ts:91`) è il punto
  di quasi tutte: una modifica lì (aprire Disposizione prima di cliccare) ne
  copre la maggior parte.
- **Shift+F10 su una tab**: `lib/contextMenuOrigin` sintetizza un `contextmenu`
  sull'elemento a fuoco; la barra lo riceve già da `handleContextMenu`, quindi
  la porta comandi arriva gratis.

## 5. Dove cambiarla

| # | Scelta | Requisito |
|---|--------|-----------|
| 1 | la tab si allunga, una superficie | `TABSHEET-01` (paragrafo «La forma» e scenario «la tab e il foglio sono una superficie»); §D1 |
| 2 | tasto destro = fuoco sulla prima voce, niente suggerimenti | `TABSHEET-01` (paragrafo «Da dove si parte», scenari «tasto destro» e «clic sulla tab attiva»); `TOPIC-BROWSER-02` modificato; §D2 |
| 3 | livelli di lato con `SubmenuItem` | `TABSHEET-02` (paragrafo dei livelli, scenario «tutto da tastiera»); §D3 |
| 4 | ogni tab, la finestrella e il titolo sul telefono | `TABSHEET-03`, `TABSHEET-04`; `CTXMENU-01` e `LAYOUT-02` modificati; §D4 |
| 5 | niente chiusura col conto alla rovescia nel menu | `TABSHEET-03` (riga «Chiudi»); `LAYOUT-02` (scenario «Close tab via context menu», che ora apre il foglio); §D5 |
