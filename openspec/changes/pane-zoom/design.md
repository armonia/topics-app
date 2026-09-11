# Design — pane-zoom

## Context

Due superfici disegnano il tiling e condividono la barra tab: la griglia
standalone (`PanelGrid.tsx` + `soloCells`) e quella di progetto
(`hooks/useProjectLayout.ts` + `GroupLayout.tsx`). Entrambe finiscono nello
stesso posto: `buildShallowGridTree(...)` -> `<SplitTree>`, che dimensiona ogni
figlio con `flex: ${child.weight} 1 0%` (SplitTree.tsx:106) e sopprime il
divisore adiacente a un figlio a peso zero (`gapHasDivider`, SplitTree.tsx:91,
gia' usato dalle foglie `__skip:`).

Quel seam e' l'intero disegno: **si cambiano i pesi, non la forma dell'albero**.
Con `flex-basis: 0%` un solo figlio a grow non nullo si prende tutto, quindi non
serve nemmeno normalizzare i pesi superstiti.

Tre fatti del repo che vincolano tutto il resto, e che sono la ragione per cui
la strada «modale vera» e' stata scartata:

1. **Le pane browser native compositano SEMPRE sopra il DOM.** Nessun `z-index`
   ci mette un overlay sopra. L'unico rimedio in questa app e' il CONGELAMENTO
   (`lib/shell/browserOcclusion.ts`), pilotato da un `MutationObserver` su
   `OVERLAY_SELECTOR` (`.glass-surface`, `.native-occlude`, `[role="menu"]`,
   `[role="listbox"]`, `[role="dialog"]`).
2. **`decideFreeze` e' una pura intersezione di rettangoli** (browserOcclusion.ts:191).
   Non guarda la parentela: guarda la geometria. Un contenitore modale che
   avvolge una pane browser la interseca per costruzione, quindi la congela.
3. **`keyFor` chiavia `leaf:${node.id}` / `split:${index}`** (SplitTree.tsx:130-132),
   entrambi invarianti rispetto al peso. Cambiare un peso NON rimonta niente:
   verificato per lettura e per misura (modulo vero bundlato e renderizzato in
   Chromium: mount count invariato, nonce di `useState` identici, `data-probe-tag`
   ancora attaccato prima, durante e dopo).

## Decisioni

### D1 — Il meccanismo: pesi a zero, e un memo a valle

`treeRoot` non si tocca. Si aggiunge

```ts
const zoomedTree = useMemo(() => applyZoomWeights(treeRoot, zoomCellKeys), [treeRoot, zoomCellKeys]);
```

passato a `<SplitTree node={zoomedTree}>`. Non si toccano `gridRows`, `rows`,
`groups`, `soloCells`, `rowHeights`, `cellStacks`. Quindi nessuna
riconciliazione, nessuna scrittura di persistenza, nessun tombstone, nessun
`localSeq`, nessun PUT dell'intero snapshot.

### D2 — Tre segnali per una cella fuori zoom, non uno

| segnale | dove | perche' |
|---|---|---|
| `weight: 0` | l'albero passato a `SplitTree` | il figlio flex non occupa spazio, il divisore accanto sparisce da solo |
| `display: none` sul wrapper di cella | `renderTreeLeaf` | porta `clientHeight` a 0, cosi' al ritorno scatta il ResizeObserver 0 -> altezza di `MessageList.tsx:1506-1540` che ripristina l'ancora di lettura. Col solo peso 0 un collasso di COLONNA lascia altezza piena e larghezza 0: il ripristino non scatta e Virtuoso rimisura ogni item a larghezza 0. Ed e' anche l'unico modo perche' le celle collassate escano da tab-order e dall'albero di accessibilita' |
| `hasBox=false` -> `PaneAliveContext.Provider value={false}` | attorno al loop dei `PaneKeepAlive` | i terminali smettono di scaricare in un xterm a viewport zero (`hasLayout` in SingleTerminalPane.tsx:408 e' alimentato SOLO da `usePaneAlive()`; senza, la `WidthCache` non memorizza mai e il costo CRESCE col tempo passato in zoom) |

### D3 — Il gesto stratificato, il modificatore, e cosa NON e' vero di loro

`PaneTabBar.tsx:1257` diventa:

```ts
onDoubleClick={(e) => {
  markDraftTouched(pane.id);
  if (pane.preview) { onPinPane?.(pane.id); return; }
  if (canZoom) onToggleZoom?.(pane.id, e.altKey ? 'cell' : 'derived');
}}
```

Il livello 1 e' identico a oggi e ora esce con `return`: i contratti esistenti
(`tests/e2e/tab-sync.spec.ts:565`, `openspec/specs/tab-sync-e2e/spec.md:47,62`)
restano verdi. Il significato dichiarato del gesto (commento a
PaneTabBar.tsx:1253-1256) non cambia, scala: la fissi, poi la isoli. ⌥ e' libero
sulla linguetta: in tutto `PaneTabBar.tsx` non compare nessun `altKey`, e
l'unico `onDoubleClick` del file e' quello di :1257.

**Il cancello del primo livello e' `pane.preview`, non la presenza della
callback**, e la differenza va scritta perche' la prima stesura la sbagliava.
Con `if (pane.preview && onPinPane)` una tab in anteprima montata da un ospite
che non passa `onPinPane` scivolerebbe nel ramo zoom: il gesto che la spec
assegna al «fissa» ingrandirebbe. Oggi non morderebbe, ed e' verificato: la prop
e' opzionale (PaneTabBar.tsx:207) e arriva `undefined` da GroupLayout.tsx:1036 e
:1275 quando l'ospite non la passa, ma le due superfici che accendono lo zoom la
passano sempre (StandaloneChatGroup.tsx:688, ProjectWindow.tsx:617). Un cancello
che dipende da CHI ha montato la barra invece che dallo stato della tab e' pero'
un cancello che cambia significato appena qualcuno monta una terza superficie,
e non e' quello che la spec dichiara. Con `onPinPane?.()` il ramo anteprima
assorbe il gesto e esce comunque: se la callback manca, il doppio clic su
un'anteprima resta esattamente il no-op che e' oggi.

**Il modificatore chiede la SOLA cella.** ⌥ + doppio clic, ⌥⌘E, e una voce di
menu distinta, «Ingrandisci solo questa», ingrandiscono la cella che ospita la
tab e ignorano il set derivato (LAYOUT-40). Non e' una seconda modalita': e' lo
stesso stato di zoom con un insieme di celle diverso, e si esce esattamente allo
stesso modo.
La ragione sta nella richiesta, che dice «soltanto per quella chat,
EVENTUALMENTE delle tab che ha aperto»: «eventualmente» non e' «sempre e senza
scampo», e senza il modificatore l'ambito automatico sarebbe l'unico ambito
possibile: si potrebbe scegliere quale conversazione isolare, mai quanto.

**Ripetere QUALUNQUE gesto sull'ancora esce**, modificatore compreso. L'ambito si
sceglie all'INGRESSO; ⌥ non e' un interruttore di modalita'. Cambiare ambito
senza uscire vorrebbe dire mutare in silenzio un insieme che nessuna banda di
chip mostra, e romperebbe la sola promessa che il gesto fa: si torna indietro con
lo stesso gesto con cui si e' entrati.

Due cose che sarebbe comodo credere e sono false, entrambe verificate:

- **Non e' vero che oggi quel gesto «non produce niente di osservabile».** Vero
  e' che l'`onDoubleClick` non aggiunge nulla al clic. Il primo dei due clic
  passa da PaneTabBar.tsx:1252 -> `onActivate` -> `clearPane`
  (useTabNotifications.tsx:74-81) e, per un terminale, `clearTerminalFinished`:
  l'utente vede cambiare tab attiva e sparire il badge. Su una tab NON attiva il
  gesto fa quindi DUE cose, e la spec lo dichiara.
- **Una BOZZA non e' un'anteprima.** E' aperta `openPanel(draftId, 'permanent', true)`
  (usePanelLifecycle.ts:2075-2077), quindi `preview === false`, e col nuovo
  handler cadrebbe nel ramo zoom mentre oggi il doppio clic la marca soltanto
  (contratto vivo: `tests/e2e/draft-pane-lifecycle.spec.ts:129-142`). Decisione:
  **una bozza ha `canZoom` falso**. Non e' ancora una conversazione, non ha tab
  aperte, e il costo di sbagliare qui e' un contratto rosso su una funzione che
  non c'entra.

Dove il gesto NON va, e perche':

- **Area vuota della barra tab**: e' `app-drag-region`, cioe' la barra del
  titolo, dove macOS massimizza gia' la FINESTRA. Due «ingrandisci» a otto pixel
  di distanza e' il caso peggiore.
- **Divisori**: quattro doppi clic gia' assegnati (SplitTree.tsx:287,
  InsertDividers.tsx:122 e 213, CellSubStack.tsx:241), e due dei quattro senza
  `stopPropagation`.
- **Corpo della pane**: sopra una WKWebView nativa il doppio clic non raggiunge
  mai React; in chat seleziona una parola, in xterm un token.

**Le due chord, e il campo che nessun cancello controlla.** ⌘E e' verificata
libera (l'unico `'e'` con modificatori in `client/src` e' ⌘⇧E in
`RemoteBrowserPanel.tsx:965`, che pretende Shift). Va dichiarata in
`shared/shortcuts.ts`, gruppo «Panels & tabs», e va dichiarata **col campo
`native`**:

```ts
{ keys: ['⌘', 'E'],      description: 'Ingrandisci la conversazione', native: { chars: ['e'] } },
{ keys: ['⌥', '⌘', 'E'], description: 'Ingrandisci solo questa cella', native: { chars: ['e'] } },
```

La prima stesura diceva che «essendo ⌘+carattere il generatore la copre da sola».
E' FALSO, e va corretto qui perche' e' la riga su cui si costruisce il task.
`forwardedCmdChars()` salta ogni scorciatoia priva di `native`
(`if (!s.native) continue`, shortcuts.ts:148): senza quel campo la riga non entra
nella tabella generata, quindi il monitor NSEvent non inoltra la chord quando una
pane browser NATIVA ha il fuoco. Cioe' ⌘E morirebbe in «chat + browser aperta
dall'agente», che e' la situazione per cui questa funzione esiste. E' il
requisito **LAYOUT-41**: la chord senza modificatore va dichiarata inoltrabile, e
l'elenco che lo decide e' UNO SOLO per le due sponde native. L'id si cita qui
perche' e' questa riga di registro a realizzarlo, e compare nell'elenco che la
lettura del cancello usa piu' in basso.

E il cancello resterebbe VERDE lo stesso, che e' la parte che serve a chi legge.
`bun run gen:shortcuts && git diff --exit-code` e `shared/shortcuts.test.ts`
confrontano il `.rs` committato con l'uscita di `renderRustModule()`: senza
`native` il generatore per quella riga non emette niente, il file committato
combacia, il diff e' vuoto e il test passa. I due cancelli provano la COERENZA
fra registro e allowlist, non la COPERTURA: nessuno dei due ha una nozione di
«questa scorciatoia doveva essere inoltrata». L'unico modo di accorgersene e' una
passata a mano col fuoco dentro una pane browser nativa, e va messa fra le prove
del task, non lasciata alla CI.

**Per ⌥ NON serve un campo, e non va inventato.** `NativeForward` ha esattamente
`chars` e `requireShift` (shortcuts.ts:26-33), e per l'INOLTRO basta: 'e' va
inoltrato identico con e senza ⌥, esattamente come 'w' oggi e' Shift-agnostico. A
distinguere i due ambiti e' il renderer, su `e.altKey`. Il registro decide CHI
passa, non COME arriva.

Il guasto sta a valle, ed e' proprio il «come arriva»:

- il monitor macOS legge `modifierFlags` ed estrae SOLO CMD, CTRL e SHIFT
  (lib.rs:8600-8606); il bit di Option (`1 << 19`) non viene mai letto, e
  `charactersIgnoringModifiers` ignora l'Option per definizione, quindi ⌘E e ⌥⌘E
  arrivano ad `app_chord_dispatch_js` (:8460) con lo stesso identico `chars`;
- e il keydown risintetizzato scrive `altKey:false` come COSTANTE (lib.rs:8485).

Conseguenza: cosi' com'e', ⌥⌘E digitato sopra una pane browser nativa **non
diventa inerte, diventa ⌘E**. Il monitor non lo distingue, lo riscrive senza
Option e ingoia l'originale (`return nil`, lib.rs:8645): si chiede la sola cella e
si ottiene l'ambito intero, in silenzio. Un tasto morto e' un fastidio; un tasto
che fa la cosa sbagliata senza dirlo e' un difetto.

Decisione: il monitor legge anche `1 << 19` (il numero e' gia' nel file, in
`OTHER_MODS` del monitor del ⌘ destro, lib.rs:8703-8704) e lo porta fino in
fondo. Sono due righe NUOVE accanto ai tre `const` di lib.rs:8601-8603, e tre
righe toccate: la firma di `app_chord_dispatch_js`, che guadagna un parametro
`alt` (lib.rs:8460), la sua unica chiamata (lib.rs:8611), e la costante
`altKey:false` di lib.rs:8485, che diventa `altKey:{alt}`. Il registro non cambia
forma: due righe nel gruppo «Panels & tabs» (shortcuts.ts:87), tutte e due con
`native: { chars: ['e'] }`.

**Quel parametro e' anche il lavoro che rende vero lo SHALL di LAYOUT-40**, e va
registrato qui perche' la stesura precedente lasciava quello SHALL senza niente
che lo realizzasse. Lo scenario «la chord col modificatore non arriva degradata»
chiede che la decisione sia una funzione pura interrogabile da un test sulle DUE
sponde native, non solo su quella che ha gia' la tabella, e al Mac restava
assegnato un video come unica prova. Ma `app_chord_dispatch_js` e' gia' pura
adesso: sceglie una stringa e la formatta, non chiama AppKit, e sotto
`#[cfg(target_os = "macos")]` (lib.rs:8459) viene compilata da `cargo test --lib`
proprio sulla macchina di chi sviluppa. Le manca solo il parametro. Con `alt` al
suo posto, un modulo `#[cfg(all(test, target_os = "macos"))]` in `lib.rs` (forma
gia' in casa: quattro moduli gated cosi', per esempio :11394 e :11731) asserisce
che con `alt: true` la stringa porta `altKey:true` e con `alt: false` porta
`altKey:false`, cioe' che ⌥⌘E non puo' arrivare come ⌘E. Lo SHALL resta scritto
dov'e', ed e' questa la riga che lo paga: la sponda dove il difetto vive
davvero e' il Mac, visto che su Windows `decide()` scarta l'Alt prima di
sintetizzare qualunque cosa.

Quella costante vale pero' per OGNI chord inoltrata, non solo per la nuova, quindi
va falsificata prima di toccarla: i char inoltrati oggi e i rami che leggono
`altKey` vanno confrontati come due insiemi, non dedotti. Il confronto sta nel
task, dove ha la sua prova.

**Su ⌘E Windows NON resta indietro, e il conto va fatto qui.** Nel registro non
esiste un asse piattaforma: `Shortcut` porta `keys`, `description`, `desktopOnly`
e il `native` appena descritto, e niente altro (shortcuts.ts:35-45). Il file
generato lo dichiara da se' («No `cfg`: the macOS
monitor (`lib.rs`) and the Windows decision table (`chords.rs`) both read this
one list», shortcuts_generated.rs:10-12), e `decide()` interroga proprio quella
funzione (chords.rs:131). Aggiungere 'e' cambia quindi anche la TABELLA WINDOWS:
da quel momento Ctrl+E con una pane browser a fuoco viene inoltrato alla webview
di UI e `SetHandled(true)` toglie a WebView2 la sua azione di default per
quell'acceleratore. Il keydown DOM la pagina continua a riceverlo: e' l'unica
differenza onesta col Mac, dove il monitor NSEvent puo' scartare l'evento, ed e'
scritta in chords_win.rs:17-24 («here "swallow" means "the browser does not also
act", never "the page never knew"»).

E' il comportamento VOLUTO, non un effetto collaterale da evitare: su Windows
Ctrl+E deve ingrandire esattamente come ⌘E sul Mac, e la finestra che elenca le
scorciatoie e' una sola per tutt'e due. Va pero' scritto dove si legge, perche'
nessun cancello se ne accorge da solo: senza un test che lo nomini,
`cargo test --lib` resta verde per OMISSIONE, e un verde per omissione spacciato
per «la tabella Windows non e' cambiata» e' la prova sbagliata.

I test da estendere sono DUE, e la stesura precedente ne indicava un terzo che e'
proprio quello da non toccare:

- `'e'` fra i char di `app_chords_from_the_registry_are_forwarded`
  (chords.rs:157, la lista e' a :158): e' la riga che afferma «Ctrl+E e' inoltrato
  e ingoiato».
- `ChordKey::Char('e')` fra le chiavi di `alt_is_never_ours` (chords.rs:223, la
  lista e' a :224): e' la riga che afferma l'asimmetria rimasta, cioe' che
  Ctrl+Alt+E resta della pagina.

`page_chords_stay_with_the_page` (chords.rs:168-178) **NON si tocca**, ed e' un
errore che va nominato invece che corretto in silenzio, perche' la prima stesura
lo prescriveva. Quel test e' un CICLO che asserisce `PassThrough` per ogni char
della sua lista (c, v, x, a, z, f, l, y): metterci 'e' lo renderebbe ROSSO per
sempre dall'istante in cui il registro cambia, e romperebbe per giunta la
falsificazione «rosso prima, verde dopo» dello stesso task, che e' l'unico modo
di provare che le due sponde leggono davvero lo stesso elenco. Va letto per quello
che e': non nomina 'e' e non l'ha mai nominato, quindi resta verde con e senza
questa change e non prova niente sul punto. E' esattamente cio' che LAYOUT-41
chiede di non lasciare all'omissione.

**L'asimmetria che resta e' solo quella di Alt.** `decide()` esce con
`PassThrough` per QUALUNQUE chord con Alt prima di guardare la tabella
(chords.rs:103-105), con la ragione scritta accanto: Alt e' del sistema e del
menu (Alt+F4, Alt+Spazio). Non si tocca, e non si aggira aggiungendo un campo per
piattaforma a `Shortcut`: sarebbe un asse nuovo nel registro condiviso per una
scorciatoia di comodo, ed e' fuori ambito. Su Windows, con una pane browser a
fuoco, ⌥⌘E non arriva; restano il ⌥ + doppio clic e la voce di menu, che ci sono
sempre e su tutte le piattaforme. L'asimmetria si AMMETTE, con una frase in
LAYOUT-40 e la stessa nell'Impact del proposal, invece di essere scoperta, ed e'
una delle ragioni per cui il modificatore ha tre inneschi e non uno.

### D4 — Il gesto DEGRADA, non sparisce

La prima stesura rendeva il comando ASSENTE quando il set di celle da ingrandire
coincideva gia' con tutte le celle vive. E' il difetto peggiore del disegno,
perche' morde proprio il layout in cui la funzione servirebbe di piu': chat +
due browser + un terminale di sotto-agente in una griglia a quattro celle. Li' il
set copre tutto, «Ingrandisci» non compare e il doppio clic e' un no-op muto: il
comando sparisce esattamente sulle chat affollate. Non e' una semplificazione.

Decisione: in quel caso il gesto semplice **degrada alla sola cella dell'ancora**,
cioe' fa quello che farebbe il modificatore. Il comando non e' mai assente e non
e' mai un no-op. Il gesto semplice risponde «fammi vedere questa conversazione
piu' grande» con la risposta piu' grande che ha senso in quel layout; il
modificatore risponde sempre «solo questa cella».

Il predicato di disponibilita' cambia metro, e diventa piu' semplice di quello che
sostituisce: **esiste almeno una cella viva fuori dalla CELLA DELL'ANCORA**, non
piu' «fuori dal SET». Vale identico per il gesto semplice e per quello col
modificatore, e si valuta su CELLE e non su pane, altrimenti una chat che
condivide la cella con la propria browser non potrebbe mai ingrandire. La
copertura si legge in due righe: se esiste una cella viva fuori da quella
dell'ancora, o il set derivato ne lascia fuori almeno una, e lo zoom semplice fa
qualcosa; oppure le copre tutte, e degrada alla cella dell'ancora, che resta
comunque meno di tutte. Con una cella viva sola non c'e' niente da togliere, e li'
il comando non si offre, per la stessa ragione di `useSplitLayoutAvailable`. Sotto
i 768px il comando non esiste: stesso cancello `useSplitLayoutAvailable()`, e li'
il ramo desktop non viene nemmeno reso.

La degradazione si risolve **al gesto**, non a ogni render: chi apre confronta il
set derivato con le celle vive e, se lo copre, memorizza `scope: 'cell'` invece di
`'derived'` (D12). Cosi' l'ambito non cambia sotto le mani mentre una pane si apre
o si chiude, e dentro l'ambito scelto l'insieme resta VIVO come vuole D7: una
browser che l'agente apre dopo entra da sola se lo scope e' `derived`.

Nel caso degradato le due voci di menu fanno la stessa identica cosa, e va bene
cosi': a riposo «Ingrandisci solo questa» resta presente ogni volta che il comando
esiste. Farla comparire e sparire vorrebbe dire far dipendere il contenuto del
menu dal set derivato, che e' esattamente l'insieme che l'utente non puo' vedere,
e rimetterebbe dentro in piccolo il difetto che D4 toglie. Il caso opposto non e'
una deroga a questa regola ma un'altra situazione: mentre lo zoom e' ATTIVO tutti
gli inneschi RIDUCONO, col modificatore o senza, e il menu offre la sola «Riduci»
(LAYOUT-40). Li' le due voci non coinciderebbero per un caso di layout, ma
sempre, e due etichette per un'azione sola sono rumore.

Caso degenere accettato: con una finestra piccola e una cella collassata molto
stretta, lo spazio guadagnato puo' essere minore dei due lati di cornice, e la
cella «ingrandita» risultare marginalmente piu' piccola. Si accetta: il predicato
resta STRUTTURALE («esiste una cella viva fuori da quella dell'ancora»), perche' un predicato
geometrico per asse sarebbe un cancello che cambia risposta mentre ridimensioni la
finestra, e il gesto e' reversibile a un clic.

### D5 — La cornice

`[data-split-surface]` guadagna `data-pane-zoom="1"` e
`padding: var(--pane-zoom-inset)` con

```css
:root { --pane-zoom-inset: clamp(20px, 4vmin, 56px); }
```

Un NUMERO, non «un po' di margine»: senza, l'e2e clicca un punto scelto a occhio
e il primo aggiustamento lo fa rosso. La banda non scende mai sotto 20px, che e'
il minimo cliccabile dichiarato.

Dentro la superficie, **due figli SEMPRE montati**: `.pane-zoom-scrim`
(`position:absolute; inset:0; z-index:0`, `data-testid="pane-zoom-scrim"`,
`onClick` = esci) e `.pane-zoom-stage` (`position:relative; z-index:1;
width:100%; height:100%`) che contiene `<SplitTree>`. Lo stage riempie il content
box, quindi la banda di padding e' raggiungibile solo dallo scrim: il clic sul
«fuori» arriva senza `stopPropagation` sparsi e senza toccare i gestori di drag
della superficie, che sono in fase di CAPTURE.

Si montano incondizionatamente per igiene, non per paura: la motivazione «un
fratello che compare rimonta l'albero» e' FALSA e va detto, perche' dentro
`[data-split-surface]` (PanelGrid.tsx:2667) ci sono gia' fratelli condizionali
prima di `<SplitTree>` — `FullWidthRowZone` (:2706) e `RowGapDropZone` (:2719),
montati e smontati a ogni drag di tab. Se bastasse quello a rimontare, ogni
trascinamento resetterebbe i PTY. Si toglie l'attributo `hidden` e lo `style`,
mai la presenza del nodo, perche' e' piu' semplice da leggere e non costa niente.

Lo scrim porta `app-no-drag` + `{...NO_DRAG_REGION}`. In alto la prima banda di
cornice occupa il posto che a riposo e' barra tab trascinabile: senza quegli
attributi il «clic fuori» diventerebbe un trascinamento della finestra, e
`tests/e2e/drag-regions.spec.ts` e' rosso al primo dei due sbagli.

**Nessuna animazione di geometria.** Il passaggio scatta; solo lo scrim entra in
120 ms di sola opacita', e sotto `prefers-reduced-motion` nemmeno quella
(MOTION-01: chi ha chiesto MENO movimento non SHALL vederne). Non esiste percorso
nativo per animare una dimensione (`browser_animate_bounds` anima solo
`transform.translation.x`) e l'inseguimento per-frame e' gia' registrato come
«visibly stutter»; ogni frame di transizione farebbe rifare `fit()` a ogni xterm
montato. Ingresso e uscita chiamano `notifyPaneReflow()`: le stesse parentesi
`topics:pane-resize-start/-end` che `handleSplitGroup` usa gia'.

**Spigoli quadri, e la regola deve VINCERE.** `apply_browser_corner_mask`
(lib.rs:4471-4480) arrotonda solo gli angoli a filo della FINESTRA, con
tolleranza `window_corner_radius()+2`. Con un inset di 20-56px nessun angolo e' a
filo, quindi la webview dentro la card ha spigoli vivi: una card arrotondata
mostrerebbe una pagina squadrata dentro un angolo tondo. Ma
`.floating-splits [data-split-card] { border-radius: var(--float-radius) }`
(index.css:3795) ha specificita' (0,2,0) e una regola `.pane-zoom-card` (0,1,0)
PERDE: in modalita' fluttuante gli spigoli quadri non varrebbero, in silenzio.
La regola si scrive quindi come `[data-split-surface][data-pane-zoom] [data-split-card]`,
specificita' (0,3,0).

**La banda ha un fondo, e va dipinto.** In `.floating-splits` la superficie e'
`background-color: transparent` (index.css:3629) e solo `[data-split-card]`
dipinge `var(--bg)` (:3666-3669): fuori dalle card non c'e' nessuno strato
colorato, `useFloatingVibrancy` non emette regioni fra le card, e su Windows
`window_set_floating` toglie il backdrop DWM. Senza intervento la cornice
sarebbe, in fluttuante, un buco sul materiale nativo (su Windows, un buco sul
desktop) e in normale un `--bg` scurito: due bande diverse. Decisione:
`[data-split-surface][data-pane-zoom]` dipinge `--bg-solid` mentre lo zoom e'
attivo. Una banda sola, dichiarata, in tutte e due le modalita'.

Nota da tenere accanto al CSS: l'aritmetica della LARGHEZZA della banda regge
(i `-2px` della superficie fluttuante e i `+2px` della card si cancellano) SOLO
perche' la card e' un flex item (SplitTree.tsx:58 + PanelGrid.tsx:2560-2571 +
StandaloneChatGroup.tsx:883). Chi togliesse `display:flex` dal wrapper di cella
sposterebbe il bordo destro e basso di 4px senza rompere nessun test.

### D6 — Le pastiglie native e il comando della colonna stanno sulla CORNICE

`PanelGrid.tsx:2410-2414` aggancia `onToggleSidebar` alla cella (0,0): ingrandendo
un'altra cella il comando finisce fuori schermo e, con la colonna chiusa, non
resta un modo per riaprirla. Ma la prop e' anche il cancello di
`content-chrome-inset` (StandaloneChatGroup.tsx:913, 941), e il commento a :905-911
vieta esattamente a una cella che NON e' a filo finestra di indentare «per luci
che non le stanno sopra». In zoom le tre pastiglie del Mac stanno sopra lo SCRIM,
non sopra la cella.

Decisione: **mentre lo zoom e' attivo la cella non riserva nulla** (niente
`content-chrome-inset`, e la barra della cella NON cambia altezza: `--chrome-bar-h`
resta quella che il modello le da' da `rowIdx`, perche' `rows` non si tocca), e il
comando di riapertura della colonna vive **dentro la cornice**, nella banda
superiore, a destra dello spazio delle pastiglie. La banda superiore si calcola
`max(var(--pane-zoom-inset), spazio delle pastiglie)` quando quello spazio serve.
Cosi' WINCTL-02 continua a misurare la stessa cosa e nessuno riserva 70px a vuoto.

### D7 — L'ambito: la conversazione, non la cella

L'auto-split manda la browser aperta dall'agente in un gruppo suo accanto alla
chat (`useProjectBrowserPanes.ts:186-198, 379-398`). Zoomando la CELLA della chat
si perderebbe la seconda meta' della frase di Attilio.

Non serve nessun campo nuovo, e non va inventato: `openedBy`/`parentPaneId`
uscirebbe da `buildSnapshot` via `...rest` e rientrerebbe CANCELLATO dalla
whitelist scritta a mano di `sanitizePane` (sanitizeSnapshot.ts:99-152), che e'
l'asimmetria garantita, classe di guasto gia' pagata due volte. La parentela e'
gia' codificata in fonti durevoli:

| fonte | regola | durabilita' |
|---|---|---|
| id della pane | `createPaneId` conia `browser:<contextId>` e il server risolve `resolveContextIdForTopic(topic) = topic.browserState?.contextId ?? topic.id` (browser-tool-dispatcher.ts:282-284): la browser aperta dalla chat T e' `browser:<T>`, uguaglianza di stringhe | totale |
| `topics[T].browserState.contextId` | l'ultimo contesto browser della topic | durevole, sincronizzata, singola |
| `terminal_sessions.parent_session_key` | i sotto-agenti, come gia' in `SubAgentsStrip.tsx:38` | DB |
| `browserSpawner` | registro esplicito, ma sessionStorage, per-finestra, last-wins | **solo additivo** |

`zoomScope.ts` espone `resolveZoomAnchor(paneId, deps)` e
`computeZoomPaneIds(anchor, deps)` per la parentela,
`resolveZoomCells({ anchorPaneId, scope }, deps)` che traduce uno scope in celle,
e `resolveEntryScope(paneId, requested, deps)` che sceglie lo scope AL GESTO. Con
tutto INIETTATO (`openPanes`, `topics`, `terminals`, la mappa spawner:
`sessionKeyForPaneId` a paneConfig.ts:403-411 documenta il guasto muto di chi
deduce la sessionKey dall'id).

I due ambiti NON sono due percorsi: dentro `resolveZoomCells`, `derived` risolve
`cellKeysForPanes(rows, itemMap, computeZoomPaneIds(...))` e `cell` risolve
`cellKeysForPanes(rows, itemMap, [anchorPaneId])`. Un `if` dentro il memo, cosi'
uscita, potatura, cornice e residenza restano una strada sola. La quarta funzione
sta a parte per la ragione di D4: `resolveZoomCells` e' pura e gira a OGNI render,
e la degradazione li' dentro farebbe cambiare l'ambito sotto le mani ogni volta
che una pane si apre o si chiude. Lo scope si sceglie una volta, entrando, e cio'
che lo store memorizza e' il suo esito (D12). L'ancora e' la CONVERSAZIONE solo se
la tab e' una chat; altrimenti e' quella pane sola. Il maximize classico non e' pero' soltanto il caso
degenere: col modificatore e' raggiungibile su qualunque tab, ed e' la risposta
del gesto semplice ogni volta che l'ambito automatico coprirebbe tutto. Il registro
spawner entra in UNIONE: se e' vuoto (dopo un riavvio dell'app) l'insieme e' piu'
piccolo, mai sbagliato, e il caso piu' piccolo e' comunque lo zoom di cella.

Da pane a CELLA con `cellKeysForPanes`, che **estrae** la conversione gia'
esistente in `mobileVisibleKey` (PanelGrid.tsx:474-487), risalita da una pane
impilata compresa. `mobileVisibleKey` ne ridiventa il primo consumatore: la
conversione smette di esistere in due copie invece di aggiungerne una terza.

L'insieme e' ricalcolato a ogni render sulle sottoscrizioni che il layout ha
gia': con `scope: 'derived'`, se l'agente apre una tab MENTRE guardi, quella tab
entra da sola, che e' precisamente il momento in cui uno snapshot congelato
mentirebbe. Con `scope: 'cell'` l'insieme resta la sola cella dell'ancora e non
cresce: quella tab e' una pane nuova fuori dal set, quindi vale la regola di
uscita, ed e' il prezzo dichiarato di aver chiesto «solo questa».

Niente banda di chip, niente `FocusReason`, niente «aggiungi al focus»: sarebbe
interfaccia costruita per spiegare un modello dati che non c'e', dentro un gesto
che serve a togliere roba dallo schermo. Il prezzo, dichiarato: l'utente non ha
modo di sapere che dopo un riavvio dell'app l'insieme puo' essere piu' piccolo.

### D8 — Qualunque intenzione di RIORGANIZZARE esce dallo zoom

Una regola sola invece di sei casi. Escono dallo zoom, prima di applicarsi:
«Dividi a destra» e «Dividi in basso», «Reimposta pannelli», «Disponi», i bus
globali `topics:reset-split-layout` e `topics:auto-tile-layout`, l'undo di layout
(⌘Z), e l'avvio di un drag di tab. Ragione: tutti cambiano la geometria sotto lo
zoom, e il drag ha per giunta tutti i bersagli (`FullWidthRowZone`,
`RowGapDropZone`, `InsertDividers`) nell'area collassata. Uscendo, DNDSPLIT-01 e
DNDSPLIT-02 restano contratti veri invece di diventare condizionali.

I divisori DENTRO lo zoom restano linee, non maniglie: `onResize`/`onEqualize`
non vengono passati a `<SplitTree>` mentre lo zoom e' attivo. Non e' prudenza:
`handleTreeResize` converte i pixel con `pxToWeightDelta(bandPx, deltaPx)` contro
una banda che nel MODELLO include anche le voci a peso 0, mentre sullo schermo la
banda e' fatta delle sole celle superstiti. Il peso committato sarebbe sbagliato,
e finirebbe nel layout persistito. L'alternativa (ricalcolare la banda escludendo
i pesi nulli) e' fattibile ma e' una seconda aritmetica da mantenere per un gesto
che si fa uscendo.

### D9 — Escape resta dell'agente, e lo zoom non e' una superficie modale

Il contenitore dello zoom NON porta `.native-occlude`, `.glass-surface` ne'
`role="dialog"`, quindi `hasOpenModalSurface()` (modalSurface.ts:49-55) resta
falso e il ramo globale continua a interrompere il turno in streaming. Chi
ingrandisce una chat lo fa per GUARDARE l'agente lavorare: togliergli il tasto
che lo ferma e' il contrario dello scopo.

Escape chiude lo zoom come ULTIMO ramo della catena in `useKeyboardShortcuts.ts`,
dopo `if (sessionKey && isSessionStreaming(...)) { stopSession(); return; }`
(righe 468-473). Con un turno vivo, quindi, Escape non chiude lo zoom, e restano
le altre tre vie, tutte a un clic. Sopra di tutto sta `useModalDialog`, che
ascolta Escape in CAPTURE con la sua pila (useModalDialog.ts:32, 121-128): con la
tavolozza o le impostazioni aperte, Escape chiude quelle e lo zoom resta.

Questa e' una regola da scrivere in spec, non un dettaglio di implementazione: lo
zoom e' LAYOUT, non una superficie modale, e non cambia il significato di nessun
tasto. Senza la regola scritta, il primo che «sistema il velo» aggiungendo
`MODAL_PANEL` riporta il fermo-immagine su ogni webview visibile.

Il contratto che lo blinda va scritto in una forma che possa vederlo. Gli helper
di casa (`classStringMatchesSelector` in browserOcclusion.test.ts:65-73, `matches`
in modalSurface.test.ts:54-64) fanno `.filter(s => s.startsWith('.'))` e IGNORANO
gli attributi: un contratto negativo scritto con loro resterebbe verde proprio
sulla regressione che dichiara di catturare, perche' «trasformare lo zoom in una
modale vera» si fa con `role="dialog"`. Il test monta il nodo e usa
`el.matches(OVERLAY_SELECTOR)` / `el.matches(MODAL_SURFACE_SELECTOR)`. E va detto
per quello che e': protegge due nodi, non «tutto l'albero sopra la superficie».

### D10 — Le viste di sistema native: il rischio vero, e il chiavistello

**Dentro lo zoom** la webview resta viva e interattiva: la cella si allarga, il
ResizeObserver sul placeholder spinge il nuovo rettangolo, la vista segue.

Ma l'invariante «resta viva perche' nessun antenato e' marcato» e' FALSO, e va
riscritto in forma geometrica. `recompute()` interroga
`document.querySelectorAll(OVERLAY_SELECTOR)` sull'INTERO documento
(browserOcclusion.ts:134) e salta solo cio' che sta dentro uno slot; ogni overlay
canonico e' portalato su `document.body`. In zoom la cella superstite copre quasi
tutta la superficie, quindi QUALUNQUE menu, dropdown o tooltip aperto la interseca
e la congela, e la scongela chiudendosi. Il menu contestuale della tab e' `role="menu"`:
il ciclo congela -> clic su «Ingrandisci» -> scongela e' il percorso NORMALE di
uno dei tre inneschi, non un caso limite. Va dichiarato come comportamento voluto,
o l'e2e «la pane resta viva» diventa un rosso intermittente al primo tooltip.

**Fuori dallo zoom** la vista va spenta davvero, e qui sta la correzione piu'
importante rispetto alla prima stesura. La catena c'e': `flex: 0` da' box 0x0,
`display:none` porta `isVisible` a falso, `NativeBrowserPlaceholder.updateBounds`
esce PRIMA di `getBoundingClientRect()` e spinge `{0,0,0,0}` (:183-186), e
`setBounds` con width 0 entra nel ramo `else if (openedRef.current)` e parcheggia
a x=-100000 conservando `lastRealSizeRef` (useTauriBrowser.ts:449-461).

Il punto e' che quel nascondimento e' un IPC **usa-e-getta senza chiavistello**, e
tre letture lo disfano:

1. Il ramo zero non azzera `pendingRectRef` e non segna nessuno stato «nascosto».
   `applyBounds` (:399-443) ha come unico ingresso `pendingRectRef.current`, e il
   suo `hide` scatta solo se quel rect e' <= 0, cosa impossibile perche'
   `pendingRect` si scrive SOLO nel ramo width > 0. Quindi ogni `applyBounds()`
   su una pane collassata la RIMETTE a schermo all'ultimo rect reale. Chiamanti
   che non passano dal placeholder: `thaw()` (:581), `setDevice` (:1611), il
   riconcilio UA (:1644), `setResponsiveSize` (:1656), l'handshake di `recreate`
   (:1722).
2. `display:none` acceca anche `liveSlotRect`, che con zero client rect torna
   **null** (browserOcclusion.ts:214-221). Allora `evaluateOcclusion` ripiega sul
   rect STANTIO (`liveSlotRect(id) ?? pendingRectRef.current`, :608): una cella
   collassata continua a decidere freeze/thaw sulla geometria che aveva PRIMA
   dello zoom. Sequenza reale: menu aperto sopra la pane -> freeze; clic su
   «Ingrandisci» -> cella a `display:none`, park; menu chiuso -> `thaw()` ->
   `applyBounds()` -> `browser_set_bounds` al rect di prima. Il lato Rust lo
   applica senza condizioni.
3. La maschera cade proprio nel caso che sembrava sicuro: `setNativeVisible(isVisible
   || agentActive || opsInFlight)` (:669) riaccende la vista quando un agente la
   guida, e ogni op delegata fa `const woke = await setNativeVisible(true)` (:1492).
   Con `setHidden:YES` il danno non si vedeva; senza, la webview riaccesa torna
   sopra la cornice.

**Correzione obbligatoria, e una sola forma la soddisfa**: nel ramo zero di
`setBounds` si arma un `hiddenRef`, letto in cima ad `applyBounds`. Cosi' (a)
`applyBounds` esce prima di toccare la geometria, come gia' fa sul guardiano
`if (!slot || !openedRef.current) return` (:405), e nessun thaw, `setDevice`,
riconcilio UA, ridimensionamento responsive o handshake di `recreate` puo'
resuscitare la vista; e (b) `evaluateOcclusion` riceve `slot = null` invece del
rect stantio: con `decideFreeze(null, rects) = rects.length > 0`
(browserOcclusion.ts:195) il congelamento in piu' e' innocuo e il thaw diventa un
no-op.

La variante che sembra equivalente, cioe' azzerare `pendingRectRef.current` e
lasciare che sia il guardiano di :405 a fermare tutto, non lo e', e la differenza
e' strutturale, non di gusto: `animateBounds` scrive `pendingRectRef.current`
a :480 senza passare dal segnaposto, quindi con quell'implementazione il
chiavistello e' lo stesso campo che un altro percorso puo' riscrivere, e a
tenerlo chiuso resta la guardia di un chiamante (`isVisible` in
`onSidebarSlideStart`, NativeBrowserPlaceholder.tsx:357-364) invece della propria
forma. NATIVEPARK-01
chiede che il chiavistello sia apribile SOLO da un rettangolo positivo misurato
sul segnaposto: `hiddenRef` lo e' per costruzione, l'altra lo e' per coincidenza.

Cosa deve fare il chiavistello sta scritto una volta sola, in NATIVEPARK-01 del
delta `specs/remote-browser/` (le cinque vie di ritorno, la porta unica che lo
apre, e la decisione di congelamento presa sul «non lo so»), e qui non si
riscrive. Serve un test unitario su questa transizione, che dichiari quell'id, e
la verifica a mano su Tauri il cui caso decisivo NON e' la cella collassata da
sola ma **cella collassata + agente che guida quella browser + un menu aperto e
chiuso sopra la cornice**.

Conseguenza sull'elenco dei file: `useTauriBrowser.ts` entra fra i modificati.
La frase «zero righe nuove nella catena dei bounds» era falsa.

Conseguenza sull'elenco delle SPEC, che e' la seconda meta' della stessa cosa: il
chiavistello e' comportamento della capability **remote-browser**, dove vivono
`OCCLUSION-01` e `NATIVEOPS-01`, non del layout. Descriverlo solo in un
requisito LAYOUT vorrebbe dire che, ad archiviazione avvenuta,
`openspec/specs/remote-browser/spec.md` continuerebbe a raccontare il vecchio
comportamento resuscita-al-thaw e due spec approvate si contraddirebbero. La
change porta quindi un delta anche su `specs/remote-browser/`, accanto a quello
su `specs/layout/`.

E la divisione fra i due file e' una regola, non una cortesia: **la casa del
comportamento della vista nativa e' remote-browser** (NATIVEPARK-01 per il
parcheggio, NATIVEPARK-02 per lo spegnimento dietro un antenato nascosto).
LAYOUT-38 dichiara la meta' che e' di layout, cioe' chi decide se una cella ha un
box e cosa la superficie di tiling garantisce a chi quel box lo perde, e per il
resto CITA i due id. Ripetere il testo in tutt'e due i file non e' ridondanza
innocua: ad archiviazione avvenuta la stessa regola vivrebbe in due spec
approvate, che e' esattamente il guasto che questo delta esiste per evitare.

### D11 — Residenza: `hasBox` non e' `visibleKeys`, e non servono hold

Il segnale di liveness non deve azzerare `visibleKeys`, o dopo
`MIN_DWELL_MS` 4000 + `EVICT_DELAY_MS` 1500 il budget (`heavy: 3`, `light: 12`)
smonta le celle nascoste e uscire dallo zoom trova celle da ricostruire. In
`StandaloneChatGroup` `visibleKeys` si azzera con `surfaceAlive = usePaneAlive()`
(`surfaceAlive` a :408, `visibleKeys` a :409-413), quindi un Provider a livello di
cella toglierebbe il pavimento
«visibile = sempre residente» (policy.ts:147-148).

Forma esplicita, uguale sulle due superfici: prop `hasBox?: boolean` (default
`true`); `visibleKeys` continua a usare `surfaceAlive` **da solo**; SOLO il loop
dei `PaneKeepAlive` viene avvolto in
`<PaneAliveContext.Provider value={surfaceAlive && hasBox}>`. «Residente» e «ha un
box» sono due assi e restano distinti. Conseguenza: niente `holdKey`, niente
refcount da rilasciare, quindi non si eredita il peggior vettore di guasto
silenzioso della strada alternativa (un rilascio mancato rende una pane per sempre
non-sfrattabile, senza errore e senza test rosso).

Due frasi vanno dette nella forma vera, perche' quella comoda promette piu' di
quanto il codice dia:

- **`usePaneAlive()` non vale «hasBox && isPaneActive».** Vale «nessun guscio
  antenato e' nascosto»: implicazione a senso unico, come dice il commento del
  codice (GroupLayout.tsx:252-256). Il contratto va scritto come
  `!alive => nessun box`, mai come uguaglianza. Il controesempio e' in
  produzione e non e' un percorso esotico: `PanelGrid.tsx:2759-2760` e :2791-2792
  tolgono dal layout con `display:none` la riga e le celle diverse da
  `mobileVisibleKey`, senza nessun Provider in mezzo. Dentro quelle celle
  `usePaneAlive()` torna il DEFAULT `true`, e la pane attiva e' pavimento di
  residenza: su mobile una browser con box zero resta viva ed esente dal tetto,
  sul dispositivo con meno memoria. **Decisione: `hasBox` viene alimentato anche
  da `mobileVisibleKey` in quei due punti.** E' un difetto vivo che precede
  questa change, costa due righe, e senza di esso la spec spedirebbe un invariante
  falso.
- **Il pavimento copre UNA pane per cella, non la cella.** `visibleKeys` ritorna
  `p ? [stableKeyOf(p)] : []`: la sola tab ATTIVA. In una cella collassata con N
  tab, N-1 pane cadono nel ramo `contested` e vengono sfrattate quando il budget
  di classe si esaurisce (misurato sul codice vero: 17 candidati, 3 visibili,
  2 sfratti dentro celle collassate in classe light; 1 in classe heavy con 5
  pane `project`). La garanzia corretta e' quindi: **la tab attiva di ogni cella
  collassata resta pavimento**, e uscendo dallo zoom le tab di sfondo oltre il
  tetto si rimontano. Va scritto, o il primo che lo scopre lo tratta come
  regressione dello zoom mentre e' il tetto che funziona come sempre.

Caso accettato e dichiarato: una pane `project` in cella collassata riceve
`isVisible=false` come oggi lo riceve una pane di progetto su una tab di sfondo;
il suo `GroupLayout` annidato vede `surfaceAlive` falso e le sue pane interne
perdono il pavimento. E' identico in tipo a un comportamento in produzione da mesi.

La riga in `RemoteBrowserPanel.tsx:164` (`isVisible = isVisibleProp && usePaneAlive()`)
e' GLOBALE: raggiunge anche il cassetto del task
(`useTaskBrowserGroupLayout.tsx:258/267`), che questa change dichiara fuori scope
per `enableZoom={false}`. Oggi una browser del cassetto dietro una pane kanban
nascosta resta `isVisible=true` (vista viva, bounds a zero); dopo, prende
`browser_set_visible(false)`. E' probabilmente un miglioramento, ma e' un cambio
di comportamento su una superficie dichiarata intatta: lo dichiara NATIVEPARK-02,
con l'eccezione dell'agente al lavoro e il ritorno senza rimontaggio, ed e' quello
l'id che il caso e2e deve annotare.

### D12 — Stato effimero, e perche' NON persistito

`client/src/state/paneZoom.ts`, store zustand in memoria e per-finestra, sul calco
dichiarato di `state/projectFocus.ts` e `state/windowPresence.ts`:

```ts
{ bySurface: Record<string, { anchorPaneId: string; scope: 'derived' | 'cell'; openedSeq: number }>,
  toggle(surfaceId, paneId, scope), exit(surfaceId), exitTop(): boolean }
```

`scope` e' un campo in piu' su un record, non un secondo stato: uno zoom solo, con
un insieme di celle diverso. Si fissa all'INGRESSO, dal modificatore (D3) o dalla
degradazione (D4), e non si ricalcola a ogni render. E `toggle` sulla stessa
ancora ESCE, qualunque scope porti: due `toggle` con scope diversi sulla stessa
superficie lasciano UN record, mai due.

Un record per superficie, non uno slot globale, altrimenti uno zoom dentro un
progetto annidato cancellerebbe quello della griglia esterna. `exitTop()` chiude
l'ultimo aperto ed e' cio' che il ramo Escape chiama: serve un getter sincrono
perche' `useKeyboardShortcuts` sta a livello App e deve leggere lo stato di una
superficie che gli sta sotto senza passare per props.

Non persistito per tre ragioni misurate: `ui_state` ha `key TEXT PRIMARY KEY` e
nessuna colonna dispositivo (007-ui-state.sql:1-5) e il server fa broadcast a
tutti, quindi uno zoom sincronizzato sarebbe una modale che si apre da sola sul
telefono; ogni azione che non sia `FOCUS_PANE`/`SET_ACTIVE_SPACE` alza `localSeq`
e arma un PUT dell'INTERO snapshot a 500 ms (otto toggle = otto PUT da ~68 KB con
lo stesso hash); e `usePanelGridPersistence` scrive a ogni cambio, quindi lo zoom
si riaprirebbe da solo. Il precedente che decide e' la rimozione di
`pane-store-scroll-offsets` del 2026-08-06.

Conseguenza operativa: **nessuna riga nuova nel reset di
`tests/e2e/global-setup.ts:624`**, quindi nessuna contaminazione fra file di spec.

## Casi limite

| caso | comportamento |
|---|---|
| pane chiusa da un altro dispositivo | l'unione via tombstone la toglie; il set di celle e' derivato e POTATO a ogni render contro le celle vive, come `pruneSoloCells`. Sparisce l'ANCORA: si esce. Sparisce una pane del corredo: il set si restringe |
| ⌘W sull'ancora, «Sposta nello Spazio», «Sposta in una nuova finestra» | l'ancora non e' piu' fra le pane aperte di questa superficie: si esce |
| ultima tab della cella zoomata chiusa | la cella sparisce, potatura, uscita |
| reload | stato di riposo = non zoomato. Niente da ripristinare, nessuna cornice su una griglia non ancora idratata (`useServerHydrated`) |
| cambio di Spazio | `App.tsx:2088` chiavia il sottoalbero su `activeSpaceId`, la superficie si rimonta, l'effetto di smontaggio chiama `exit(surfaceId)`. E' il comportamento VOLUTO e va scritto nella docstring, o il primo che «lo aggiusta» sollevando lo stato fa attraversare lo zoom fra i gruppi |
| cambio progetto, pane progetto chiusa | `GroupLayout` smonta, `exit(surfaceId)` |
| il fuoco va su una pane fuori dal set (notifica, `topics:open-topic`, clic in colonna) | si esce. Confronto CELLA contro CELLA con la stessa risalita di `cellKeysForPanes`, cosi' cambiare tab DENTRO la cella zoomata non chiude niente |
| l'agente apre una browser per la chat ancorata | con `scope: 'derived'` entra da sola nel set, la sua cella riappare, lo zoom resta. Con `scope: 'cell'` (modificatore o degradazione) l'ambito e' la sola cella e non cresce: era quello che si e' chiesto |
| si apre una pane NUOVA che non e' del set (⌘T, ⌘N, add-menu, ⇧⌘T, `browser:force-open`) | **si esce**. Una pane nasce visibile: e' l'unica regola che copre con una riga tutti gli inneschi, incluso ⇧⌘T che non tocca `focusedPaneId` (reducers/panes.ts:324) e il force-open del server |
| finestra staccata (`?topics=` / `?topic=`) | nessuna persistenza monta li' (bootstrap.ts:300-304): lo zoom e' locale e volatile, come deve |
| finestra-gruppo (`?space=`) | ha una griglia vera con piu' celle: lo zoom esiste, ed e' per-finestra come dappertutto. Due finestre affiancate hanno due zoom indipendenti |
| pila di colonna (`cellStacks`) | `cellKeysForPanes` risale al PRIMARIO, quindi zoomando una chat impilata ci si porta dentro i vicini di pila, che non sono nel set. Limite dichiarato: lo zoom rivela, non riorganizza |
| set = tutte le celle vive (chat + le sue browser + i suoi terminali riempiono la griglia) | il gesto semplice DEGRADA alla sola cella dell'ancora: `scope` nasce `'cell'`, il comando non e' mai assente e non e' mai un no-op muto |
| ⌥ sul gesto, ⌥⌘E, «Ingrandisci solo questa» | si ingrandisce la sola cella che ospita la tab, set derivato ignorato. Stesso stato, stesse quattro uscite |
| layout a una cella viva sola | il gesto non si offre: non c'e' niente da rivelare |

## Alternative scartate

**Una modale vera** (portale, `role="dialog"`, velo a tutto viewport). Congela la
pane browser che vuole mostrare, perche' `decideFreeze` e' una pura intersezione e
l'esclusione a browserOcclusion.ts:142 vale solo per il verso opposto (overlay
DENTRO uno slot). Richiederebbe di emendare `OCCLUSION-01`, che e' approvata e ha
test di contratto, invertendo la polarita' che quel file dichiara per iscritto
(«nel dubbio si CONGELA»), e un fork di `hasOpenModalSurface`. In piu' farebbe
pagare uno screenshot nativo per ogni browser visibile a ogni apertura, e
l'ampiezza del velo diventerebbe una COINCIDENZA geometrica: la card deve restare
piu' larga della cella piu' piccola perche' il clic di uscita sia ricevibile. Un
invariante che nessun test esprime, sotto l'unica via di uscita della funzione.

**Hold di residenza con refcount** (`holdKey` preso all'ingresso, rilasciato
all'uscita). Non serve, perche' `visibleKeys` non viene mai azzerato; e un
rilascio mancato rende una pane per sempre non-sfrattabile, senza errore e senza
test rosso. E' la strada che riporta la regressione da 65 processi WebContent.

**Una banda di chip con le pane del set e i motivi del focus.** Interfaccia
costruita per spiegare un modello dati che non c'e', dentro un gesto che serve a
togliere roba dallo schermo.

**Un campo `openedBy` / `parentPaneId` su `Pane`.** Uscirebbe da `buildSnapshot` e
rientrerebbe cancellato da `sanitizePane`: asimmetria garantita.

**Animare la geometria.** Nessun percorso nativo per animare una dimensione, e
ogni frame farebbe rifare `fit()` a ogni xterm montato.

## Rischi

| rischio | dove morde | mitigazione |
|---|---|---|
| la webview parcheggiata torna sopra la cornice | le CINQUE vie di NATIVEPARK-01 (`thaw`, `setDevice`, riconcilio UA, `setResponsiveSize`, handshake di `recreate`), col risveglio di visibilita' che precede un'op d'agente a togliere la maschera che nascondeva il difetto | il chiavistello `hiddenRef` di D10 + il test unitario che le prova no-op tutte e cinque + la passata a mano su Tauri col caso composto |
| la pane ingrandita diventa un PNG al primo tooltip | qualunque overlay portalato che la interseca | dichiarato in spec come comportamento voluto; l'e2e non asserisce «resta viva» in presenza di overlay |
| il contratto negativo nasce gia' cieco | `classStringMatchesSelector` ignora gli attributi | il test monta il nodo e usa `el.matches()` |
| il tetto di residenza sfratta le tab di sfondo delle celle collassate | oltre `light: 12` / `heavy: 3` | garanzia riscritta sulla tab ATTIVA; e2e con seed a >= 3 gruppi e asserzione puntuale, non un conteggio aggregato |
| in fluttuante la cornice e' un buco e la card resta tonda | `.floating-splits` vince per specificita', e non dipinge fondo | regola a (0,3,0) + `--bg-solid` sulla superficie in zoom + passata a mano su Tauri con floating ON: in Playwright la classe non compare mai (`isDesktop = shellKind !== 'web'`) |
| il «clic fuori» trascina la finestra | la banda superiore e' zona di trascinamento a riposo | `app-no-drag` + `{...NO_DRAG_REGION}` sullo scrim, con `tests/e2e/drag-regions.spec.ts` a fare da cancello |
| il doppio clic rompe due contratti vivi | anteprima da fissare, bozza da marcare | stratificazione con `return` + `canZoom` falso sulle bozze + i due file e2e nella barra |
| una pane nasce invisibile | `openPanel` deposita nella cella a fuoco, che puo' essere collassata | regola unica: aprire esce dallo zoom |
| ⌘E muore proprio col caso d'uso della change | riga di registro senza `native`: il monitor NSEvent non la inoltra con una pane browser nativa a fuoco | il campo `native: { chars: ['e'] }` nominato in D3 e nel task; i due cancelli restano verdi lo stesso, quindi la prova e' la passata a mano col fuoco dentro una pane nativa |
| ⌥⌘E si trasforma in ⌘E, in silenzio | il monitor non legge `1 << 19` e risintetizza `altKey:false` come costante (lib.rs:8600-8606, 8485) | il bit letto e propagato fino ad `app_chord_dispatch_js`, che guadagna il parametro `alt` (D3), piu' un test Rust sulla funzione pura (modulo `#[cfg(all(test, target_os = "macos"))]` in `lib.rs`) che asserisce `altKey:true` con ⌥ e `altKey:false` senza: e' la meta' macOS dello SHALL di LAYOUT-40, che prima aveva solo un video. Col confronto fra i char inoltrati e i rami che leggono `altKey` fatto PRIMA di toccare la costante, e il video della passata a mano |
| su Windows ⌥⌘E non arriva mai | `decide()` esce su `c.alt` prima della tabella (chords.rs:103-105) | asimmetria AMMESSA in LAYOUT-40 e nell'Impact, non scoperta: il modificatore ha anche ⌥ + doppio clic e la voce di menu, che valgono ovunque. Non si corregge con un campo per piattaforma su `Shortcut`: fuori ambito |
| su Windows Ctrl+E cambia comportamento e nessuno lo dice | l'allowlist generata non ha `cfg`: la tabella di `decide()` legge la stessa lista del monitor macOS (shortcuts_generated.rs:10-12, chords.rs:131) | e' l'esito VOLUTO (Ctrl+E ingrandisce anche li'), dichiarato in D3, in LAYOUT-41 e nell'Impact; lo AFFERMANO DUE test estesi, `app_chords_from_the_registry_are_forwarded` (chords.rs:157) per l'inoltro e `alt_is_never_ours` (:223) per l'asimmetria, invece di restare verde per omissione. `page_chords_stay_with_the_page` (:168-178) NON si tocca: e' un ciclo che asserisce `PassThrough`, e con 'e' dentro sarebbe rosso per sempre |

## Barra

Si scrive una volta e si esegue sempre uguale.

```
bun run typecheck
bun run lint
bun test client/src/components/Layout/paneZoom.test.ts client/src/components/Layout/zoomScope.test.ts client/src/state/paneZoom.test.ts
bun test client/src/lib/modalSurface.test.ts client/src/lib/shell/browserOcclusion.test.ts   # contratti NEGATIVI con el.matches(), non con classStringMatchesSelector
bun test shared/shortcuts.test.ts                                   # ⌘E e ⌥⌘E dichiarate, col campo `native`; e' anche il file che DICHIARA LAYOUT-41, visto che il cancello non cammina su desktop-tauri/
bun run gen:shortcuts && git diff --exit-code -- desktop-tauri/src-tauri/src   # COERENZA registro <-> allowlist, NON copertura: una riga senza `native` passa verde
(cd desktop-tauri/src-tauri && cargo test --lib)                    # TRE test: i due della tabella Windows col caso 'e' AGGIUNTO (`app_chords_from_the_registry_are_forwarded` = Ctrl+E inoltrato, `alt_is_never_ours` = Ctrl+Alt+E no), piu' quello macOS su `app_chord_dispatch_js` col parametro `alt` (⌥⌘E non arriva come ⌘E). `page_chords_stay_with_the_page` NON si tocca. Verde senza i casi nuovi = verde per omissione
bun test client/src/hooks/                                          # il test del chiavistello: dopo un park, no-op su tutte e cinque le vie di NATIVEPARK-01
npx playwright test tests/e2e/pane-zoom.spec.ts
npx playwright test tests/e2e/pane-residency-cap.spec.ts            # con il seed a >= 3 gruppi e l'asserzione puntuale sulla tab attiva di ogni cella collassata
npx playwright test tests/e2e/grid-split.spec.ts tests/e2e/tab-sync.spec.ts tests/e2e/draft-pane-lifecycle.spec.ts
npx playwright test tests/e2e/split-dnd-matrix.spec.ts tests/e2e/pane-over-pane-group.spec.ts tests/e2e/project-tabs.spec.ts tests/e2e/floating-splits-ground.spec.ts tests/e2e/regression-fixes.spec.ts tests/e2e/project-sidebar-rail.spec.ts
npx playwright test tests/e2e/drag-regions.spec.ts
npx playwright test tests/e2e/escape-modal-guard.spec.ts
bun run check:occlusion                                             # il modulo vero dentro WebKit: lo zoom non entra fra gli occlusori
bun run check:spec-coverage                                         # prima dell'archiviazione e' rosso AL CONTRARIO, e si LEGGE: nota qui sotto
bun run check:untraced-tests
bun run check:sleeps                                                # zero waitForTimeout non dichiarati
bun run check:ui-language && bun run check:comment-language && bun run check:emdash
bun run check:deadcode
bun run test:unit
bun run check:e2e-touched                                           # l'E2E non e' fra i sei check della board: va lanciato prima di consegnare
bun run qa:gate                                                     # la barra intera in un comando
```

**Cosa fa davvero `check:spec-coverage` mentre la change e' aperta.** Il suo
denominatore e' `openspec/specs/` e basta (`SPECS`, check-spec-coverage.ts:70,
l'unico albero che `readRequirements` percorre, :147): finche' la change non e'
archiviata, LAYOUT-34..LAYOUT-41 e NATIVEPARK-01/02 non sono nemmeno enumerati,
quindi «un requisito senza test dichiarante e' rosso» (R2, :535-540) NON puo'
scattare su di loro. Prometterlo sarebbe la stessa classe di cancello cieco che
due righe piu' su si smonta per `gen:shortcuts`, e va detto invece di ripeterlo.

Quello che il cancello fa davvero, adesso, e' l'opposto: ogni test che dichiara
uno di quegli id finisce fra i PENZOLANTI di R1 («un test dichiara un requisito
che le spec non hanno», :529-534) e, non essendo nella linea di partenza, che
oggi e' a zero su tutt'e tre le voci (misurato lanciandolo), lo fa uscire 1.
Mentre si lavora il cancello e' quindi rosso per costruzione, e si LEGGE invece
di aspettarselo verde: nell'elenco R1 devono comparire tutti e soli gli id di
questa change, ognuno dichiarato dal file che deve provarlo. Sono DIECI, e vanno
contati leggendo il cancello, perche' un id che manca da questa riga e' un id che
nessuno cerca fra i penzolanti: LAYOUT-34, LAYOUT-35, LAYOUT-36, LAYOUT-37,
LAYOUT-38, LAYOUT-39, LAYOUT-40, **LAYOUT-41**, NATIVEPARK-01, NATIVEPARK-02.
L'ultimo dei LAYOUT e' quello che questa stesura aggiunge all'elenco: esisteva
nella spec e nei task, mancava qui, e una lista operativa a cui manca una voce da'
un falso positivo proprio a chi la usa come si deve. Un id scritto fuori
forma non compare nemmeno li': cade sotto R7 (`muteAnnotations`, :523-528), che
e' il secondo cancello vivo adesso ed e' quello che becca un `LAYOUT-3x` copiato
da un elenco. Il terzo e' `check:untraced-tests`, che chiede a ogni file di test
NUOVO di dichiarare cosa copre, e questa change ne porta quattro nominati piu'
quello del chiavistello. `--report` stampa gli stessi conti senza uscire 1,
quando serve solo guardarli.

La direzione promessa, «requisito senza test dichiarante = rosso», diventa vera
nello stesso commit che archivia, quando il delta entra in `openspec/specs/` e R2
morde sui nuovi id fuori dalla linea di partenza. Che e' anche il momento in cui i
penzolanti si risolvono da soli: nessuna voce va aggiunta alla linea di partenza
per far tacere il rosso di adesso, o all'archiviazione diventerebbe una voce
stantia e il cancello tornerebbe rosso per quella. Vale anche per `qa:gate`, che
lo esegue (qa-gate.sh:91): finche' la change e' aperta quel comando non puo'
uscire zero per questa ragione, e sapere QUALE riga e' rossa e perche' e' la
differenza fra leggere un cancello e smettere di guardarlo.

Fuori dalla barra automatica, e obbligatorie: **tre passate a mano sul guscio
Tauri**. La prima e' il claim del chiavistello (cella collassata + agente che
guida quella browser + un menu aperto e chiuso sopra la cornice: la webview non
deve mai ridisegnarsi sopra la cornice). La seconda e' il fluttuante acceso
(larghezza e fondo della banda, spigoli della card). La terza sono le due chord
col fuoco DENTRO una pane browser nativa: ⌘E ingrandisce, ⌥⌘E ingrandisce la sola
cella, e nessuna delle due si trasforma nell'altra. Nessuna delle tre gira in
Playwright: li' `isTauri` e' falso, `liveSlotRect` torna null, l'observer non
parte, `.floating-splits` non viene mai applicata e il monitor NSEvent non
esiste. La terza e' anche l'unica prova possibile del campo `native`, visto che i
cancelli del generatore restano verdi anche quando manca.

### Cosa provano gli unit

- `paneZoom.test.ts`: pesi azzerati solo fuori set; righe intere azzerate;
  `node.id` conservati; **stessa ref** a set vuoto; potatura contro le chiavi vive.
- `zoomScope.test.ts`: `browser:<T>` entra; il `browserState.contextId` entra; i
  sotto-agenti per `parentSessionKey`; spawner vuoto -> insieme = la sola chat
  (degradazione, non errore); tab non-chat -> ancora = quella pane sola.
- I due ambiti sullo stesso ancoraggio: `derived` porta con se' la cella della
  browser della chat, `cell` no. E la degradazione di D4 provata dove si decide,
  cioe' al gesto: set derivato = tutte le celle vive -> il record nasce con
  `scope: 'cell'`; set derivato che ne lascia fuori almeno una -> `'derived'`; una
  cella viva sola -> nessun record, il gesto non si offre. Nello store: due
  `toggle` con scope diverso lasciano un record solo, `exitTop()` torna falso a
  mani vuote.
- Il chiavistello: dopo un park, `applyBounds` e' un no-op su tutte e cinque le
  vie che NATIVEPARK-01 nomina, e `evaluateOcclusion` riceve `slot = null`.
- I due contratti negativi: il contenitore di zoom e lo scrim NON soddisfano ne'
  `OVERLAY_SELECTOR` ne' `MODAL_SURFACE_SELECTOR`, attributi di ruolo compresi.
- I tre in Rust, che stanno sotto `cargo test --lib` e non sotto `bun test`, e
  vanno letti come unit a tutti gli effetti: la tabella Windows inoltra e ingoia
  Ctrl+E (`app_chords_from_the_registry_are_forwarded`), lascia Ctrl+Alt+E alla
  pagina (`alt_is_never_ours`), e sul Mac `app_chord_dispatch_js` col parametro
  `alt` emette `altKey:true` con ⌥ e `altKey:false` senza, cioe' ⌥⌘E non puo'
  arrivare come ⌘E. Provano, non dichiarano: il cancello non cammina su
  `desktop-tauri/`, e l'id lo porta il `@covers` di `shared/shortcuts.test.ts`.

### Cosa prova l'E2E, e come

La prova del NON-rimontaggio e' **strutturale**, non uno screenshot: `[data-split-leaf]`
e `[data-pane-shell]` confrontati prima e dopo (i `[data-resize-axis]` cambiano
DURANTE, perche' i divisori accanto alle celle a peso 0 spariscono, quindi si
confronta prima contro dopo con `countColDividers`/`countRowDividers` di
`helpers/layout.ts`, che sono per ATTRIBUTO proprio per questa classe di rossi),
piu' un marcatore scritto in un terminale ancora leggibile e una bozza ancora nel
campo. Il clic sulla cornice si calcola leggendo `--pane-zoom-inset`, non a occhio.
Locator su `data-testid`, mai su copy tradotta; `reload({ waitUntil: 'load' })`;
niente `waitForTimeout` non dichiarato.

Il modificatore e la degradazione (LAYOUT-40) vogliono due casi che nessun unit
puo' dare, perche' sono sul gesto e non sulla funzione: ⌥ + doppio clic su una
chat che ha una browser accanto lascia viva UNA sola cella, e il doppio clic
semplice su una chat il cui set copre gia' tutte le celle vive lascia viva UNA
sola cella invece di non fare niente. Il canale di dichiarazione e' doppio, come
per tutti gli altri: `@covers` in testa al file per la forza probatoria per file,
e l'annotazione `spec` su ogni singolo `test()` per l'esito per requisito.

## Bivi

Uno solo resta aperto. Due dei chiusi erano scritti come aperti mentre `tasks.md`
li implementava gia' come decisi: la doppia lettura non puo' restare, e qui si
chiudono. Il terzo non e' mai stato un bivio, e' un COSTO, e sta qui perche' vada
letto prima dell'approvazione invece che scoperto dopo.

### Aperto: aprire una pane NUOVA mentre lo zoom e' attivo

**Lo zoom si chiude (consigliato), oppure la pane entra nel set?** La spec scritta
qui dice USCIRE, e il consigliato e' quello, per una ragione sola: «una pane nasce
visibile» e' una regola unica che copre ⌘T, ⌘N, l'add-menu, ⇧⌘T e il
`browser:force-open` del server senza casistica, inclusi gli inneschi che non
toccano `focusedPaneId`. L'alternativa fa crescere un insieme che l'utente non ha
modo di vedere, visto che non esiste nessuna banda di chip, e obbliga a decidere
caso per caso quali aperture appartengono all'ancora. Confermare o invertire in
approvazione: e' l'unico bivio che cambia il lavoro.

### Chiusi

- **In fluttuante gli spigoli sono QUADRI**, non raggio 10, in tutte e due le
  modalita': la maschera nativa non arrotonda nessun angolo che non sia a filo
  finestra, quindi una card tonda mostrerebbe una pagina squadrata dentro
  l'angolo. Deciso in D5, implementato in T3.6, scritto in LAYOUT-35. Chi
  preferisse la coerenza col fluttuante deve accettare quel bordo.
- **`hasBox` viene alimentato anche da `mobileVisibleKey`.** E' un difetto vivo
  che precede la change (sotto i 768px una vista nativa con box zero resta viva
  ed e' per giunta pavimento del tetto di residenza, sul dispositivo con meno
  memoria), costa due righe, e senza di esso la spec dichiarerebbe un invariante
  falso. Deciso in D11, implementato in T4.1, scritto in LAYOUT-39.
- **Su Windows Ctrl+E ingrandisce, e si paga volentieri.** L'allowlist inoltrata
  e' generata da una lista sola e senza `cfg`, quindi la riga nuova cambia anche
  la tabella di decisione Windows: da li' in avanti Ctrl+E su una pagina a fuoco
  viene inoltrato e WebView2 perde la propria azione di default per
  quell'acceleratore, mentre il keydown DOM la pagina continua a riceverlo. Non
  e' una regressione da evitare, e' la parita' che si vuole; l'asimmetria che
  resta e' solo quella di Alt, ammessa in LAYOUT-40 e nell'Impact. Deciso in D3,
  scritto in LAYOUT-41, implementato in T3.5 coi DUE test Rust estesi perche' lo
  affermino (`app_chords_from_the_registry_are_forwarded` e `alt_is_never_ours`),
  e senza toccare `page_chords_stay_with_the_page`.

## Ordine e stima

0. La verifica del chiavistello su Tauri, PRIMA di scrivere il resto: e' l'unica
   cosa che puo' invalidare il disegno, e costa mezz'ora.
1. Spec approvata, delta su `layout` e su `remote-browser`.
2. Moduli puri + test + i due contratti negativi riscritti. I due ambiti e la
   degradazione nascono qui, provati dove si decidono e non a colpi di e2e.
3. Chiavistello nativo + il suo test.
4. Innesto in `PanelGrid`, `StandaloneChatGroup`, `RemoteBrowserPanel`, i due
   inneschi di mouse col modificatore, CSS.
5. Le chord: ⌘E e ⌥⌘E nel registro, tutte e due col campo `native` (LAYOUT-41), il
   `.rs` rigenerato e committato, il bit di Option letto e propagato fino ad
   `app_chord_dispatch_js`, che guadagna il parametro `alt`, dopo il confronto fra
   i char inoltrati e i rami che leggono `altKey`. Poi i test, che sono tre: i due
   della tabella Windows estesi al caso 'e' perche' affermino cosa succede li' da
   quel momento, e quello macOS sulla funzione pura, che e' la meta' mancante
   dello SHALL di LAYOUT-40.
6. `hasBox` anche su `mobileVisibleKey`.
7. Parita' su `GroupLayout` dietro `enableZoom`.
8. E2E, seed a >= 3 gruppi per la residenza, e le tre passate a mano su Tauri.

**4-5 giorni**, spec comprese. La prima stesura diceva 2,5-3 e non contava il
chiavistello nativo, il ramo mobile, il cassetto del task e la regola CSS a
specificita' alzata; la seconda diceva 3,5-4 e non contava il modificatore con la
sua voce di menu e il suo requisito (LAYOUT-40), il campo `native` sulle due chord
col bit di Option da propagare nel monitor macOS, ne' il delta su
`specs/remote-browser/`.

La terza contava il bit di Option ma non il parametro `alt` su
`app_chord_dispatch_js` col suo test, cioe' il lavoro che rende vero lo SHALL di
LAYOUT-40 invece di lasciarlo a un video: due righe nuove nel monitor, tre
toccate, un modulo di test. **La stima resta 4-5 giorni**, e il perche' va scritto
invece di lasciar credere che nessuno l'abbia riguardata: mezza giornata scarsa
dentro una banda ampia un giorno non la sposta, e il tempo vero di T3.5 sta nella
falsificazione (il rosso prima e il verde dopo, su tre test e due sponde), non
nelle righe.
