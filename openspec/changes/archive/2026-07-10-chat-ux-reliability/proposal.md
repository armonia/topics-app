# Proposal — chat-ux-reliability

## Why

Audit live del chat-topic surface (2026-07-10, sessione "Verifica UI/UX e completezza
chat topics", v2.1.7 + branch corrente). Sei difetti CONFERMATI riproducibili, tutti
della stessa famiglia: **interazioni core che falliscono in silenzio**. Evidenze
raccolte su superficie reale (pane WKWebView 335px = ramo mobile) e su Chromium
desktop (jarvis-browser) contro il test server isolato :13334.

1. **Azioni messaggio non raggiungibili al click.** La toolbar hover
   (Edit/Reply/Copy/Pin/Remember) è `absolute bottom-full z-10` dentro un wrapper
   `relative … overflow-hidden` (`MessageBubble.tsx:161-167`): il proprio containing
   block la CLIPPA — nella fascia di schermo dove appare, l'hit-test cade sul markup
   della riga precedente. Playwright fallisce il click su ogni bottone di ogni
   messaggio ("subtree intercepts pointer events", 15s di retry). Prova regina: gli
   E2E esistenti aggirano il difetto con `click({force:true})` e
   `dispatchEvent("click")` (`tests/e2e/chat.spec.ts:312,475`) — suite verde, UX
   rotta, in violazione del vincolo di progetto "interact with the real UI".
   Escluso il virtualizer come causa (react-virtuoso è flow-based, nessuno stacking
   context per-riga).

2. **New Chat intermittente: draft creato ma mai renderizzato.** Click su "New
   Chat": il draft entra nello store (`draft-meta` + pane-store in localStorage) ma
   né tab né composer appaiono; senza altre tab l'app resta BIANCA (3 repro; 1
   successo a client "caldo" → race). Causa: il ramo di render itera `gridRows`
   (stato persistito per-spazio, sincronizzato da `naturalGridItems` in un
   `useEffect` gated su `isServerHydrated` e one-tick-late) — quando la chiave
   `standalone` non è ancora stata assorbita, si renderizza il nulla e nessun
   fallback riconcilia.

3. **`/browser <url>` no-op silenzioso.** Con un topic standalone e QUALSIASI tab
   progetto aperta, entrambi i listener di `browser:open-and-navigate` fanno bail
   (`usePaneOrdering.ts:440` `hasProjectPaneRef` — over-broad — e
   `useProjectLayout.ts:613` `topicBelongsToThisProject`) → evento orfano, zero
   feedback. Smentisce il task 3.3 di `chat-subscription-default` ("tutte
   funzionali") nel caso standalone+progetto.

4. **Steal del browser pane in standalone.** `browserSingletonReducer`
   (`usePaneOrdering.ts:105-140`) senza match esatto di contextId ri-punta il pane
   browser ESISTENTE del gruppo: la seconda chat si appropria del browser della
   prima (il path project è già stato fixato per lo stesso bug; questo è il residuo).

5. **Navigazione browser web-path: fallimenti invisibili.** `page.goto()` fallita è
   loggata solo server-side con shape di successo (`browser-service.ts:587-607`); lo
   schema WS nav non ha una fase errore (`browser-ws-messages.ts:62-64`); il campo
   `error` di `useRemoteBrowser` non è mai popolato da nav né renderizzato. Un
   launch fallito lascia "Starting browser…" INFINITO (repro live con Chromium
   assente). (Il path nativo ha lo stesso problema — `.catch(()=>{})` + spinner
   cieco 700ms in `useTauriBrowser.ts:345-355` — ma richiede eventi did-fail nel
   Rust: fuori scope qui, tracciato come follow-up.)

6. **UpdaterToast invisibile + rumore ACL.** Il toast ancorato al version-chip
   finisce a x=−80 (fuori viewport) quando la sidebar è collassata
   (`UpdaterToast.tsx:163-168`: il fallback corner scatta solo se il chip NON è nel
   DOM, ma nella rail collassata c'è). E il bootCheck (`UpdaterToast.tsx:56`) gira
   in QUALSIASI webview col bridge Tauri raggiungibile: nei pane browser l'ACL nega
   `updater_check` e l'errore diventa un toast (pure invisibile, vedi sopra).

## What Changes

1. **Toolbar messaggi raggiungibile.** Il wrapper della bubble SHALL non clippare la
   toolbar (rimozione di `overflow-hidden` dal containing block, preservando il
   word-wrap con `min-w-0`/`overflow-wrap` sul nodo contenuto); i separatori data
   decorativi SHALL essere `pointer-events-none`. Gli E2E dei message-action SHALL
   usare click REALI (via hover), non `force:true`/`dispatchEvent` — diventano il
   guard di regressione del fix.

2. **Render self-healing del gruppo standalone.** Quando `naturalGridItems` contiene
   chiavi che `gridRows` non ha ancora assorbito, il render SHALL riconciliare
   subito (derivazione sincrona della riga mancante) invece di renderizzare il
   nulla: un draft appena creato è SEMPRE visibile, anche a client freddo.

3. **`/browser` sempre gestito + feedback.** Il listener standalone SHALL usare la
   membership del topic nel gruppo (`orderedIds.includes(topicId)`) al posto del
   bail globale `hasProjectPane`; `/browser` SHALL dare feedback visibile
   (commandResult "Opening <url>…").

4. **Niente steal:** con `contextId` esplicito e nessun match, il reducer SHALL
   creare un pane nuovo keyed su quel contextId; il rebind di un pane esistente
   resta SOLO per chiamate senza contextId (legacy).

5. **Errori di navigazione web-path visibili.** Il server SHALL propagare il
   fallimento di `goto`/launch (shape errore + fase `error` nello schema WS nav);
   il client SHALL renderizzare uno stato errore con retry al posto dello spinner
   infinito.

6. **UpdaterToast dentro il viewport e silenzioso dove non compete.** Posizione
   ancorata clampata nel viewport (o fallback corner quando l'anchor è nella rail
   collassata); errori ACL Tauri su `updater_check` SHALL essere trattati come
   "updater non disponibile" (idle), mai toast.

**Non-goal:** eventi did-fail di navigazione nel Rust nativo (follow-up dedicato);
parità rendering (syntax highlight/KaTeX/Mermaid) e conversation pack
(regenerate generale/delete/export/share/FTS) → change separate; nessun refactor dei
sistemi di layout o del protocollo WS oltre la fase errore nav.
