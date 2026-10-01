# Tasks: chat-browser-open-marker

Prima del codice: `grep -qx 'status: approved' openspec/changes/chat-browser-open-marker/.openspec.yaml`.
Barra di ogni fase: typecheck client+server 0, rails statiche verdi, test dei moduli toccati verdi.
Niente CLI vere contro modelli a pagamento nei test: provider finti / fixture del repo.

## 1. Test rossi sul tree di oggi

- [x] 1.1 `server/routes/browser-open-pane-flow.test.ts`: la risposta di `openPaneFlow` contiene `contextId` (BROWSER-CHAT-05, rami chat e task). Rosso oggi: `browser-open-pane-flow.ts:165-170` non lo mette.
- [x] 1.2 `server/mcp/topics-mcp-server.test.ts`: il testo di `open_browser_pane` comincia come oggi e termina con `[contextId: …]`, in entrambi i rami `visible`.
- [x] 1.3 `client/src/components/Chat/toolDetail.test.ts` + `server/providers/claude/tool-detail.test.ts`: `open_browser_pane` / `mcp__topics__open_browser_pane` / `browser_open` riusciti → `{type:'browser'}` con url, titolo e contextId parsati; in errore → `mcp`; una riga salvata con `detail.type === 'mcp'` si rideriva (CHAT-BROWSER-03, i due scenari).
- [x] 1.4 `client/src/components/Chat/browserOpens.test.ts` (nuovo, puro; il modulo è `browserOpens.ts` e non `browserOpenMarker.ts`: su un disco che non distingue le maiuscole collideva con `BrowserOpenMarker.tsx`): coalescenza per `contextId` dentro un messaggio (tre aperture → un segno «3 pagine» sull'ultima; due contesti → due segni).
- [x] 1.5 `toolGrouping.test.ts`: `partitionToolGroup` spezza il gruppo attorno a un dettaglio `browser` e non lo conta. `turnFold.test.ts`: il segno esce dal `work` e va in `shown` prima della risposta (scenario «12 tool → 11 azioni»).
- [x] 1.6 `client/src/lib/focusBrowserContext.test.ts` (nuovo, effetti iniettati): ordine layout › task › finestra › tab; `reopen:false` (il gestore di `browser:focus-pane`) non apre niente su un contesto chiuso.

## 2. Server (BROWSER-CHAT-05)

- [x] 2.1 `openPaneFlow` restituisce `contextId` (già in `opts`).
- [x] 2.2 `callOpenBrowserPane` legge `contextId` dalla risposta; il testo lo riporta in coda (`topics-mcp-server.ts:2693-2706`). Controlla i lettori del prefisso: `server/lib/pane-nav-outcome.ts`, `server/routes/browser-bridge.test.ts`, `tests/e2e/browser-open-pane-orphan.spec.ts`.
- [x] 2.3 Percorso SDK: il risultato di `browser_open` porta `contextId = resolveContextIdForTopic(topic)` (`server/routes/chat.ts:2690-2704`).
- [x] 2.4 `server/providers/claude/tool-detail.ts`: variante `browser`, con parser puro del risultato.

## 3. Shared + dettaglio client (CHAT-BROWSER-03)

- [x] 3.1 `shared/tool-call-detail.ts`: variante `browser` nello schema Zod e nel tipo; aggiorna i test di contratto dello schema se contano le varianti.
- [x] 3.2 `toolDetail.ts`: derivazione speculare + riderivazione in `resolveToolDetail` per le righe `mcp` di quei nomi; `buildToolDisplayLabel` e `toolIcons.ts` (`Globe`) per il caso `browser`; `toolCardBody.ts` / `ToolCards.tsx` per il corpo (URL intero, pagine del segno).

## 4. Il segno (CHAT-BROWSER-01)

- [x] 4.1 `BrowserOpenMarker.tsx`: favicon (`BrowserFavicon`), titolo, dominio, stato, «N pagine» apribile; tutta la riga cliccabile, ≥ 44 px su touch, `aria-label` con l'URL. i18n `chat.browserMarker.*` in `i18n-chat-it.ts` e `i18n-chat-en.ts`.
- [x] 4.2 `toolGrouping.ts` (segmento a sé), `turnFold.ts` (come i media), `MessageContent.tsx` (resa del segmento).
- [x] 4.3 `taskWorkFold.ts` `summarizeTools` raccoglie i segni; `TaskWorkAccordion.tsx` li mostra come chip nella riga di riepilogo.
- [ ] 4.4 Stato derivato (§5 del design) leggendo la finestra attraverso `topicBrowserWindowLazy`: nessun import diretto dello store nel chunk della chat (`check:bundle` verde).

## 5. Il clic (CHAT-BROWSER-02, BROWSER-CHAT-05)

- [x] 5.1 `client/src/lib/focusBrowserContext.ts`: layout (`openTabInApp`) › task (`taskBrowserTabs` → `openTaskInApp`) › finestra (`openInTopicWindow`) › `openLink`.
- [x] 5.2 Il segno lo chiama con `reopen:true`; `usePanelLifecycle.ts:1853-1866` (`browser:focus-pane`) con `reopen:false`.

## 6. Verifica

- [ ] 6.1 I test del §1 verdi; typecheck; rails statiche; `check:bundle`.
- [ ] 6.2 E2E su `:13334`, estendendo `tests/e2e/topic-browser-window.spec.ts` (o `tool-call-rendering.spec.ts` per iniettare i frame con `page.routeWebSocket`): segno visibile a turno finito; clic con finestra nascosta → finestra ridotta con la scheda attiva; scheda chiusa → «chiuso» → clic → riaperta. Mai contro `:3333`. Prima di ogni run Playwright: `memory_pressure | tail -1` con free ≥ 20%.
- [ ] 6.3 Prova: il `.webm` WebKit di 6.2 allegato alla card. È la prova del comportamento; uno screenshot non basta.
