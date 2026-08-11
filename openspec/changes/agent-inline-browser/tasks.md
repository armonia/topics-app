# Tasks — agent-inline-browser

Convenzione: ogni fase chiude con `tsc` client+server verde + i test della fase verdi.
Nessuna modifica a `pane-store-v2`, ai suoi reducer/middleware, né ai fork esistenti
(terminale / task) — se una fase ti ci porta, fermati: il design è sbagliato, non il codice.

## Phase 1 — Contesto inline server-side
- [ ] `isInlineContextId(ctx)` + conio `agent-<topic8>-<seq>` accanto a
      `resolveTaskBrowserContext` (`server/routes/topics.ts`), con test puro.
- [ ] Quarto fork in `POST …/browser/open-pane`: `surface:"inline"` → conia/riusa il ctx,
      lega `topic.browserState.contextId`, naviga il **contesto headless**
      (`dispatchBrowserToolCallByContext('browser_open', …)`), risponde `{url,title,contextId}`.
      Nessun `browser:navigate`, nessuna pane.
- [ ] `browser-tab-inventory.ts`: etichetta `Agent: <titolo|host>` per i ctx `agent-…`
      (kind `other`), così `browser_list_tabs` li mostra. Test co-locato.
- [ ] Flag `TOPICS_INLINE_BROWSER` (default OFF in questa fase): spento ⇒ `surface`
      ignorato e comportamento identico a oggi.

## Phase 2 — Contratto tool + WS
- [ ] `open_browser_pane`: arg `surface: "inline"|"pane"` (default `"inline"` a flag ON,
      `"pane"` a flag OFF) + descrizione che detta la regola (quando `"pane"`).
- [ ] `browser_focus_tab` su un ctx inline ⇒ **promozione** (broadcast di apertura pane
      vera su quel contextId), non un focus a vuoto.
- [ ] Frame WS `browser:inline-tab` (open/step/suspend/close) in `shared/ws-outbound.ts`
      + union client in `client/src/types/index.ts`.
- [ ] **Contract-lock**: aggiornare `tests/unit/ws-outbound-schema.test.ts` (lista esatta
      + `toBe(N)`) nella STESSA change; girare `bun run test:unit`, non solo `bun test server/`.

## Phase 3 — Store client (puro, testato)
- [ ] `client/src/state/agentInlineBrowsers.ts`: sessioni per-topic
      (`contextId,url,title,toolUseId,state,steps[cap 20],framePath,lastActiveAt`),
      reducer open/step/suspend/promote/remove, persistenza ui-state
      `agent-inline-browser:<topicId>` con LWW debounced + `X-Client-Id`.
- [ ] Applicazione dei broadcast remoti (`ui-state:updated` per singola key +
      `ui-state:init` allo reconnect), copiando il pattern già corretto di
      `taskBrowserTabs` (niente store write-only: è il bug 78926d14).
- [ ] Test: append/dedup per contextId, cap dei passi, suspend→resume, promote spegne la
      rappresentazione inline viva, round-trip sanitize, eco del proprio client scartata.

## Phase 4 — Card inline in chat
- [ ] `toolDetail.ts`: `open_browser_pane` (e i `browser_*` con ctx inline) →
      `{type:'browser', contextId, url, title}`.
- [ ] `ToolCards.tsx`: `BrowserCard` — collassata = riga (favicon/titolo/host/n° passi/
      stato); espansa = fotogramma + passi + "Apri come pane" / "Chiudi".
      **Nessuna webview**: `<img>` del fotogramma, mai `RemoteBrowserPanel`.
- [ ] Degrado: sessione assente nello store ⇒ card = URL + titolo dal tool result (come oggi).
- [ ] Test render (collassata/espansa/degradata) + il click "Apri" chiama la promozione.

## Phase 5 — Fotogramma
- [ ] Cattura a fine passo/fine turno (throttled), ridimensionata, **salvata su disco**
      come gli altri media; nel documento ui-state va il path, mai il base64.
- [ ] Pulizia dei file alla rimozione della sessione + a GC del topic.

## Phase 6 — Sidebar
- [ ] Righe annidate sotto il topic per le sessioni inline (vive e sospese), riusando
      `depth`/`nested` di `TopicItem`; click = promuovi/foca; menu = Chiudi.
- [ ] Una sessione `promoted` NON produce una seconda riga (vince quella del pane store).

## Phase 7 — Sospensione e tetti
- [ ] Sospensione a fine turno + idle (default 5 min) → motore distrutto, stato conservato.
- [ ] Tetto di contesti inline VIVI per topic (default 3): oltre il tetto si sospende il
      meno recente, non lo si uccide.
- [ ] Resume = ricarica dall'URL (e la card lo dichiara prima del click).

## Phase 8 — Consegna
- [ ] `bun run test:unit` verde + `tsc` client/server 0.
- [ ] Video E2E: l'agent apre inline (nessuna pane compare), la card resta collassata a
      fine turno, click "Apri" → pane vera con la stessa pagina. È **la** prova: uno
      screenshot non dimostra un comportamento.
- [ ] Flag graduato a default-ON in un secondo passo, solo dopo la verifica live
      (client+server accoppiati: il deploy dev'essere atomico, lezione `task-owned-browser-tabs`).
