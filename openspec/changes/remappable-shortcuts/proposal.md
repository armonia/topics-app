# Proposal — remappable-shortcuts

Le scorciatoie di Topics sono **cablate**: la lettera vive dentro un `if` in
`client/src/hooks/useKeyboardShortcuts.ts`, la sua descrizione dentro
`shared/shortcuts.ts`, e l'allowlist che la shell nativa usa per inoltrare
l'accordo alla webview è **generata** da quel registro
(`desktop-tauri/src-tauri/src/shortcuts_generated.rs`, via `bun run gen:shortcuts`).

Richiesta: poterle rimappare dalle impostazioni, come fa Dia (Attilio, 06/08 —
«facciamo migrazione delle shortcut utili che ho su dia? … così ci assicuriamo
il sistema funzioni bene»).

## Why

### 1. La memoria muscolare è personale, e oggi non è negoziabile

Chi arriva da Dia, da Arc o da VS Code porta una mano già addestrata. Le nostre
scelte sono difendibili una per una (⌘⇧P per «trova un progetto», perché ⌘F in
ogni applicazione del mondo vuol dire «cerca QUI DENTRO») ma non sono le sue, e
oggi non c'è alcun modo di dissentire.

### 2. Il registro è già la fonte unica — ma solo in lettura

`shared/shortcuts.ts` è già dichiarato «The ONE source of truth», e alimenta due
consumatori: il pannello ⌘? e il forwarder nativo. Manca il terzo, cioè chi
*decide* — il gestore in `useKeyboardShortcuts` legge lettere scritte a mano,
quindi il registro descrive ciò che il codice fa senza governarlo. Un rebind
oggi vorrebbe dire modificare due file e rigenerare un terzo: è la definizione di
sorgente unica che non è unica.

Il difetto è già costato: `⌘⇧R` era «record voice» nel pannello e nel tooltip, ma
il ramo Tauri di `⌘R` lo prendeva prima (capture, su window) e **ricaricava
l'app**, portandosi via il testo non ancora inviato. Due liste scritte a mano che
dicevano cose diverse, e nessuna delle due era autorevole.

### 3. Un conflitto oggi si scopre usandolo

Non esiste niente che sappia dire «questo accordo è già di qualcun altro».
L'ordine degli `if` è l'unica risoluzione dei conflitti, e chi vince dipende da
chi è scritto sopra — un fatto invisibile a chi legge il pannello.

## What Changes

- **Le associazioni diventano dati.** `shared/shortcuts.ts` passa da elenco di
  didascalie a registro di **comandi**: ogni voce ha un `id` stabile
  (`command.palette.open`), un accordo di default, e la descrizione che il
  pannello mostra già. Il gestore smette di confrontare lettere e chiede al
  registro *quale comando* è questo accordo.
- **Un livello di override, persistito** in `ui-state` (quindi cross-device come
  i Fissati, non solo su questa macchina). Vuoto di default: chi non tocca
  niente ha esattamente la keymap di oggi.
- **I conflitti si vedono PRIMA.** Assegnare un accordo già preso lo mostra, dice
  di chi è, e chiede se rubarlo — invece di far vincere in silenzio chi sta più
  in alto nel file.
- **Il pannello ⌘? diventa il posto in cui si rimappa**, invece di una lista da
  leggere: è già l'unica superficie che le mostra tutte, e una seconda schermata
  nelle impostazioni sarebbe la terza lista.
- **L'allowlist nativa resta generata**, ma dal registro *più* gli override: una
  scorciatoia rimappata su una lettera che la shell non inoltra funzionerebbe
  solo con il fuoco nella webview principale — cioè a intermittenza, che è peggio
  di non funzionare. Serve un canale che aggiorni il forwarder a runtime, perché
  gli override sono per-utente e il binario è compilato una volta per tutti.

### Fuori dallo scope

- Sequenze a due tasti (`g` poi `d`) — nessuno le ha chieste, e cambiano il
  modello del gestore da «accordo» a «macchina a stati».
- Rimappare le scorciatoie **dentro** una pane (terminale, editor, browser):
  quelle appartengono al programma che ha il fuoco, e rubargliele è il bug che
  ⌘F evita già oggi di proposito.
- Profili preconfezionati («keymap Dia», «keymap VS Code»). Prima serve che il
  rimappaggio esista; un preset è un file di dati sopra a quello.

## Impact

- `shared/shortcuts.ts` — da didascalie a comandi con id
- `shared/shortcut-binding.ts` (nuovo) — normalizzazione di un accordo, confronto,
  rilevazione dei conflitti. Puro, testato con `bun:test`
- `client/src/hooks/useKeyboardShortcuts.ts` — da catena di `if` sulle lettere a
  dispatch per comando
- `client/src/components/Shared/KeyboardShortcuts.tsx` — la lista diventa
  modificabile
- `client/src/hooks/useShortcutBindings.ts` (nuovo) — override + persistenza
  `ui-state`, stesso pattern di `useSidebarState`
- `scripts/gen-shortcuts.ts` + `desktop-tauri/src-tauri/src/shortcuts_generated.rs`
  — l'allowlist di base resta generata; si aggiunge il canale runtime per gli
  override
- `openspec/specs/commands/spec.md` — nuovi requisiti

## Risks

- **Una scorciatoia rimappata male si toglie di mezzo da sola.** Se l'override
  rende il pannello ⌘? irraggiungibile, non c'è più una strada da tastiera per
  rimetterlo a posto. Serve un ripristino che non dipenda dalla tastiera (voce
  nelle impostazioni) e un accordo che non si possa riassegnare.
- **Il forwarder nativo è compilato.** Fino a quando il canale runtime non esiste,
  un override su una lettera fuori dall'allowlist funziona solo col fuoco nella
  webview principale. Va impedito in UI, non lasciato scoprire all'uso.
