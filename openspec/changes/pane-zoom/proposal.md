# Proposal — pane-zoom

## Why

Lo split e' un gesto di sola andata. Si divide con un clic, si affianca una
browser che l'agente ha aperto, e da quel momento la conversazione che si sta
leggendo vive in un quarto di superficie. Per tornare a vederla intera oggi
esistono solo strade distruttive: chiudere le altre pane (e perdere il layout),
trascinare divisori (e committare pesi che restano), o staccare una finestra.
L'audit della griglia del 2026-06-06 lo aveva gia' segnato come lacuna nota,
col nome che gli danno tmux e VS Code: maximize / zoom a pane. Non e' mai stato
fatto.

La richiesta di Attilio nomina quattro cose, e vanno lette tutte e quattro:
un modo per ingrandire, l'innesco col doppio clic, la presentazione «tipo una
modale» da cui si esce cliccando fuori, e l'ambito: «soltanto per quella chat,
eventualmente delle tab che ha aperto». L'ultima e' la meno ovvia ed e' quella
che decide se la funzione serve: quando un agente apre una browser, la browser
finisce in un gruppo accanto alla chat. Ingrandire la CELLA della chat
lascerebbe fuori proprio la meta' che l'agente ha appena prodotto.

Nell'ultima frase ci sono pero' due parole, non una. «Eventualmente» non e'
«sempre»: il corredo e' il default giusto, non l'unico ambito ammesso. Un gesto
che sa fare solo l'ambito largo lascia scegliere QUALE conversazione isolare e mai
QUANTO, e per giunta si spegne da solo proprio dove il layout e' affollato, che e'
il caso in cui servirebbe di piu'. Per questo il corredo e' il comportamento del
gesto semplice, e un modificatore chiede la sola cella.

## What Changes

Un gesto che ingrandisce UNA conversazione, e con lei le tab che quella
conversazione ha aperto, senza toccare il layout persistito.

Il meccanismo NON e' una modale. Le celle che non ospitano il set vanno a peso
zero e `display:none`; la cella superstite riempie la superficie di tiling meno
una cornice; la cornice e' scura, cliccabile, ed e' il «fuori» letterale della
richiesta. Nessun portale, nessun `position: fixed`, nessun `role="dialog"`,
nessun nodo spostato nell'albero React. L'aspetto e' quello di una modale, il
meccanismo no, e la differenza non e' filosofica: qualunque contenitore modale
che AVVOLGE una pane browser nativa la congela in un PNG, perche' e' cosi' che
`browserOcclusion` protegge i menu. Una modale vera mostrerebbe una fotografia
della pagina che dice di ingrandire.

- **Innesco** — doppio clic sulla tab, stratificato SOTTO il fissaggio
  dell'anteprima che quel gesto ha gia'; voce «Ingrandisci» / «Riduci» nel menu
  contestuale della tab; scorciatoia ⌘E, che il registro deve dichiarare
  inoltrabile oltre una pane browser nativa, o si spegne proprio nel layout per
  cui esiste (LAYOUT-41). Nessun bottone nuovo nella barra tab.
- **Innesco col modificatore** — ⌥ + doppio clic, ⌥⌘E, e una voce distinta,
  «Ingrandisci solo questa», ingrandiscono la SOLA cella che ospita la tab. Non e'
  un secondo comando e non e' una seconda modalita': e' lo stesso stato con un
  insieme di celle piu' piccolo, e si esce dalle stesse quattro vie.
- **Ambito** — di suo, la conversazione ancorata piu' le pane browser che portano
  il suo `contextId` e i terminali dei suoi sotto-agenti. Tutto derivato da
  identita' che esistono gia': nessun campo nuovo su `Pane`, nessuna migration.
  L'insieme e' VIVO: una tab che l'agente apre mentre guardi entra da sola.
- **Il comando non e' mai assente e non e' mai un no-op muto.** Se la
  conversazione e cio' che ha aperto occupano gia' tutte le celle vive, il gesto
  semplice DEGRADA alla sola cella invece di sparire. Il metro della
  disponibilita' non e' piu' il set derivato ma la cella dell'ancora: il comando
  se ne va solo dove non c'e' niente da togliere, cioe' su una superficie a cella
  sola e sotto i 768px.
- **Uscita** — clic sulla cornice, di nuovo il gesto, Escape (ma come ULTIMO
  ramo, dopo lo stop del turno in streaming), e automatica quando l'ancora
  sparisce, il fuoco va altrove, o qualcosa riorganizza la griglia.
- **Stato** — effimero, in memoria, per finestra, uno per superficie. Mai
  persistito, mai sincronizzato, mai ripristinato al ricarico.

## Impact

**Nuovi**: `client/src/components/Layout/paneZoom.ts` e `zoomScope.ts` (puri, coi
loro `paneZoom.test.ts` e `zoomScope.test.ts`), `client/src/state/paneZoom.ts`
(store effimero) col suo `paneZoom.test.ts`, il test del chiavistello nativo
accanto all'hook che lo porta (`client/src/hooks/useTauriBrowser.park.test.ts`,
sulla convenzione del gia' esistente `useTauriBrowser.polls.test.ts`), e
`tests/e2e/pane-zoom.spec.ts`. Sono CINQUE file di test nuovi, ed e' il conto che
`check:untraced-tests` chiede di far tornare: la barra del design li esegue tutti,
il quinto sotto `bun test client/src/hooks/`.

**Modificati**: `PanelGrid.tsx` (memo a valle di `treeRoot`, scrim e stage
incondizionati, `display` e `hasBox` nel wrapper di cella, la cornice),
`GroupLayout.tsx` (parita' dietro `enableZoom`), `StandaloneChatGroup.tsx`
(prop `hasBox`), `PaneTabBar.tsx` (gesto stratificato che ora prende l'evento per
leggere ⌥, e DUE voci di menu), `RemoteBrowserPanel.tsx` (una riga),
`useTauriBrowser.ts` (il chiavistello del parcheggio, vedi design §D10),
`useKeyboardShortcuts.ts` (⌘E, ⌥⌘E, ed Escape come ultimo ramo),
`shared/shortcuts.ts` (due righe, tutte e due col campo `native`) con l'allowlist
Rust rigenerata e committata e i DUE test della tabella dei chord in
`desktop-tauri/src-tauri/src/chords.rs` estesi al caso 'e', quello delle chord
inoltrate e quello dell'asimmetria di Alt (il terzo, che elenca le chord lasciate
alla pagina, NON si tocca: e' un ciclo che asserisce il contrario, e con 'e'
dentro sarebbe rosso per sempre), `desktop-tauri/src-tauri/src/lib.rs` (il monitor
NSEvent legge il bit di Option e lo propaga fino ad `app_chord_dispatch_js`, che
guadagna il parametro `alt`: senza, ⌥⌘E sopra una pane nativa non e' inerte,
diventa ⌘E. Quella funzione e' gia' pura e gia' compilata da `cargo test --lib`
sul Mac, quindi col parametro guadagna anche il primo test della sponda macOS, che
e' cio' che rende vero lo SHALL di LAYOUT-40 invece di affidarlo a un video),
`index.css`, i due file
i18n, e i contratti negativi in `modalSurface.test.ts` /
`browserOcclusion.test.ts`.

**Nessuna** migration, nessun campo su `Pane`, nessuna riga in `sanitizePane`,
nessun campo nuovo su `NativeForward` ne' su `Shortcut`, nessuna riga cambiata in
`browserOcclusion.ts` e `modalSurface.ts`.

**Su Windows il comportamento CAMBIA, ed e' voluto.** La funzione
`chords::decide` non si tocca, ma fermarsi li' e' vero della funzione e falso del
comportamento: l'allowlist che quella tabella interroga e' generata dallo stesso
registro e non ha nessun `cfg` (il file generato lo dichiara nella propria
intestazione: «il monitor macOS e la tabella di decisione Windows leggono questa
unica lista»), quindi la riga nuova vale per tutt'e due le sponde. Da quel
momento, su Windows, Ctrl+E con una pane browser a fuoco viene inoltrato alla
webview di UI e a WebView2 viene tolta la propria azione di default per
quell'acceleratore; il keydown DOM la pagina continua a riceverlo, ed e' la
differenza fra le due sponde che quel codice dichiara gia' per iscritto. E'
l'esito VOLUTO, Ctrl+E deve ingrandire anche li' come ⌘E sul Mac, ed e' il
requisito `LAYOUT-41`: una sola dichiarazione, letta da tutte e due le sponde
native. Per questo va affermato dai test della tabella, che oggi resterebbero
verdi soltanto perche' non nominano 'e': un verde per omissione non e' la prova
che niente e' cambiato.

L'asimmetria che resta e' **solo quella di Alt**. `decide()` restituisce
`PassThrough` per qualunque chord che lo porti, in cima e prima di guardare la
tabella, e quel ramo non si tocca: Alt e' del sistema e del menu (Alt+F4,
Alt+Spazio). Quindi su Windows ⌥⌘E non arriva con una pane browser a fuoco, e
restano il ⌥ + doppio clic e la voce di menu, che ci sono ovunque. La spec lo
AMMETTE in LAYOUT-40 invece di vietarlo, ed e' una delle ragioni per cui il
modificatore ha tre inneschi e non uno; aggiungere un asse piattaforma al
registro delle scorciatoie, per correggerla, e' fuori ambito.

**Due delta di spec, non uno.** Oltre a `specs/layout/`, la change porta un delta
su `specs/remote-browser/`: il chiavistello del parcheggio cambia cosa fa una
vista nativa allo scongelamento, al cambio di dispositivo, al riconcilio UA, al
ridimensionamento responsive e alla ricreazione (cinque vie, non quattro), ed e'
comportamento di QUELLA capability, dove vivono `OCCLUSION-01` e `NATIVEOPS-01`,
non del layout. Dichiararlo solo in un requisito LAYOUT vorrebbe dire che, ad
archiviazione avvenuta, `openspec/specs/remote-browser/spec.md` continuerebbe a
descrivere il vecchio comportamento resuscita-al-thaw, e due spec approvate si
contraddirebbero. I requisiti nuovi sono `NATIVEPARK-01` (il chiavistello) e
`NATIVEPARK-02` (una vista dietro un guscio antenato nascosto e' spenta, salvo
l'agente al lavoro, e torna senza rimontarsi); `LAYOUT-38` li CITA per id e
dichiara la sola meta' che e' di layout, cioe' chi decide se una cella ha un box e
cosa la superficie di tiling garantisce, invece di riscriverne il testo, o la
stessa regola finirebbe in due spec approvate. Quello che la change NON fa e'
invertire la polarita' di `OCCLUSION-01`: con la cella collassata la lettura del
rettangolo vivo torna vuota, e si finisce proprio nel ramo che quel requisito
dichiara gia' («nel dubbio si congela»).

## Cosa NON si fa

- **Una modale vera** (portale, `role="dialog"`, velo a tutto viewport):
  congelerebbe la pane che vuole mostrare, e chiederebbe un emendamento a
  `OCCLUSION-01`, che e' una spec approvata con test di contratto.
- **Due modalita' di zoom.** Il modificatore cambia l'INSIEME di celle, non lo
  stato: non esiste nessuna «modalita' cella» in cui si possa restare, e ripetere
  qualunque gesto sull'ancora esce, ⌥ compreso. L'ambito si sceglie entrando.
- **Riorganizzare le pane.** Lo zoom RIVELA, non riorganizza. Se chat e browser
  sono due tab della stessa cella, si vede una cella con due tab. Spostarle fra
  celle e' un cambio di genitore React, cioe' un remount: PTY resettata, pagina
  ricaricata, bozza persa.
- **Lo zoom sotto i 768px.** Li' una cella sola e' gia' la vista di default.
- **Lo zoom dentro il cassetto di un task.** Il cassetto e' gia' una superficie
  sovrapposta: due «fuori» annidati non sono un'interfaccia.
- **Persistenza** (ricarico, cross-device, localStorage) e **animazione della
  geometria**, e lo **zoom annidato** dentro una cella gia' ingrandita.
- **Rendere durevole lato server la parentela chat -> browser.** Lo zoom
  funziona con la memoria che c'e' oggi; e' un miglioramento successivo con un
  ciclo di verifica suo.
