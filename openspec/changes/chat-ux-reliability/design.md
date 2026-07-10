# Design — chat-ux-reliability

## A. Toolbar messaggi (MessageBubble)

Il containing block della toolbar è il wrapper `relative flex flex-col min-w-0
overflow-hidden` (`MessageBubble.tsx:161-164`). `overflow-hidden` lì serve solo a
contenere contenuto largo (code block/parole lunghe) dentro il maxWidth della bubble
— ma il clipping va applicato alla BUBBLE (il div `px-3 py-2 …` che ha già
`overflow-hidden` suo, riga 193), non al wrapper che ospita anche la toolbar
assoluta. Fix: rimuovere `overflow-hidden` dal wrapper (la bubble interna lo ha già;
`min-w-0` resta per il flex shrink). La toolbar `bottom-full` torna visibile e
hit-testabile; `z-10` la fa vincere sul flow statico circostante.

Separatori data (`MessageBubble.tsx:150-155`): la ROW resta interattiva-neutra —
`pointer-events-none` sull'intera riga del separatore (è puramente decorativa), così
anche in overlap con toolbar di altri messaggi non ruba mai click.

E2E: `chat.spec.ts` sostituisce `click({force:true})`/`dispatchEvent("click")` con
`hover()` sulla bubble + `click()` reale sul bottone. Se il clipping regredisce, il
click torna a fallire → il test lo cattura (prima non poteva).

## B. Render self-healing standalone (PanelGrid)

Non si tocca il modello di persistenza: la riconciliazione avviene alla LETTURA.
Al render, se `itemMap` contiene la chiave `standalone` ma nessuna riga di
`gridRows` la contiene (né come itemKey né dentro un cellStack), si renderizza una
riga sintetica `[standalone]` in coda (stesso `renderGroupForKey`). L'effetto di
sync esistente poi persiste la riga vera al tick successivo — la UI però non è mai
vuota. Vale per entrambi i rami (SplitTree desktop ha lo stesso derive: la guardia
si applica alla derivazione `gridRows → treeRoot`, quindi basta correggere la
sorgente: `effectiveGridRows = gridRows ∪ syntheticStandaloneRow`).

Scelta: correzione alla sorgente (`effectiveGridRows` memo) così desktop e mobile
condividono il fix e nessun ramo può renderizzare il nulla quando c'è almeno un
pane aperto.

## C. /browser ownership (usePaneOrdering)

Il bail `if (hasProjectPaneRef.current) return` (riga 440) è over-broad: nato per
"il project window possiede i suoi pane", ma il reducer sotto ha GIÀ la guardia di
membership (`!prev.includes(topicId) → return prev`). Un topic di progetto non è in
`orderedIds` del gruppo standalone, quindi rimuovere il bail non fa hijack: i topic
di progetto continuano a essere ignorati dal path standalone (membership check),
quelli standalone tornano gestiti anche con tab progetto aperte. In più il bail
resta per gli eventi SENZA topicId (producer ignoto → lascia al project window).

ChatPane `/browser`: `setCommandResult({type:'success', message:'Opening <url>…'})`
dopo il dispatch — feedback visibile sempre, coerente con gli altri slash.

## D. browserSingletonReducer no-steal

Firma invariata. Nuova semantica:
- `contextId` fornito: match esatto `browser:<contextId>` → riuso; nessun match →
  CREA `browser:<contextId>` (append), senza toccare pane browser esistenti di
  altri contesti.
- `contextId` assente (legacy): comportamento attuale (riusa il primo browser del
  gruppo o crea con uuid random).
Il chiamante WS (`browser:open-near-pane`) e quello DOM (`/browser`) passano già il
contextId; il singleton-per-gruppo smette di essere globale e diventa
singleton-per-contesto — coerente col path project già fixato
(`ensureBrowserPaneAndNavigate`).

## E. Nav error surfacing web-path

- `server/browser-service.ts`: il catch di `goto` ritorna `{ok:false, error}` e
  broadcasta l'evento nav con `phase:'error', error` (schema esteso in
  `browser-ws-messages.ts` — campo opzionale, back-compat: client vecchi lo
  ignorano via passthrough). Launch fallito (Chromium assente): stesso canale, così
  il pane esce da "Starting browser…".
- `useRemoteBrowser`: su frame nav con `phase==='error'` setta `state.error`
  (stringa breve); qualunque nav/refresh successivo la azzera.
- `RemoteBrowserPanel`: se `error`, strip compatta sopra la viewport (icona +
  messaggio + bottone Riprova = re-invia l'ultima URL). Lo spinner "Starting
  browser…" ha comunque un timeout di cortesia (>20s → stessa strip con errore
  generico), così nessun percorso resta muto.

## F. UpdaterToast

- Posizionamento: dopo il calcolo ancorato, clamp: `right = min(right,
  innerWidth - TOAST_MIN_WIDTH - 8)` e mai negativo il left implicito; se l'anchor
  rect ha `width < 40` (chip nella rail collassata, icona sola) si usa direttamente
  il fallback corner.
- ACL: in `lib/updater.ts`, un reject di `updater_check` il cui messaggio matcha
  /not allowed|ACL/i marca l'updater NON disponibile per la sessione (stato idle,
  nessun retry, nessun toast) — il check appartiene alla main window; le webview
  pane non devono mai mostrarne gli errori.

## Rischi / compatibilità

- A: rimuovere `overflow-hidden` dal wrapper può far sbordare contenuto largo se la
  bubble interna non clippa già — verificato che il div interno ha
  `overflow-hidden` + `overflowWrap/wordBreak` inline (riga 193,200): il clipping
  del contenuto resta.
- B: la riga sintetica usa la stessa chiave 'standalone' → nessun doppio render
  (dedup `seenGridKeys` già presente al render).
- D: pane browser multipli per gruppo diventano possibili in standalone (era il
  comportamento project): la tab bar li mostra come tab distinte — è il
  comportamento atteso post-fix del pinning per-contesto.
- E: schema WS additivo (campo opzionale + valore phase nuovo) — zod passthrough
  sui client vecchi.
