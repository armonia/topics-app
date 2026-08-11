# Proposal — agent-inline-browser

## Why

Oggi ogni apertura di browser fatta da un agent è un'apertura **per l'utente**: il
tool `open_browser_pane` (MCP) e la sua controparte SDK finiscono sempre su
`POST /api/topics/:id/browser/open-pane`, che broadcasta `browser:navigate` e fa
**montare una pane vera** accanto alla chat (`server/routes/topics.ts:1786-1795`).
La pane entra in `pane-store-v2`, cambia il layout del progetto, ruba spazio e
fuoco, e resta lì finché qualcuno la chiude.

Ma la maggior parte delle aperture dell'agent **non serve all'utente**: leggere una
pagina di documentazione, controllare un JSON, verificare che un endpoint risponda,
estrarre un titolo. Sono passi di lavoro, non superfici da guardare. Il costo attuale
di quei passi è tutto a carico dell'umano:

- il layout si riorganizza da solo mentre l'umano sta leggendo altro (una pane nuova
  in un gruppo esistente restringe tutto ciò che c'era);
- una sequenza di 5 letture lascia una pane sopravvissuta su un URL a caso, senza
  alcuna traccia di *perché* era stata aperta;
- l'unico modo per non disturbare oggi è **non aprire niente** — e allora il lavoro
  dell'agent diventa invisibile: nel thread resta un `open_browser_pane` senza corpo.

Il paradosso è che il pezzo mancante è solo la **superficie**: il motore di
navigazione headless per-topic esiste già (`browserService`, contesti CDP/Playwright),
i tool `browser_*` sanno già guidare **qualsiasi** contesto via `contextId`
(`browser-tab-inventory.ts`, memory `mcp-browser-any-tab`), e l'endpoint open-pane ha
già **tre fork** (topic → pane globale, terminale → `browser:open-near-pane`, task →
`browser:open-task-tab`, `topics.ts:1723-1783`). Manca il quarto: *nessuna pane*.

## What Changes

Una quarta superficie di apertura, **inline nella chat**, che diventa il default per
l'agent — e un percorso esplicito, a un click, per promuoverla a pane vera quando
l'umano deve davvero guardare.

- **`open_browser_pane` prende `surface: "inline" | "pane"`, default `"inline"`.**
  L'agent passa `"pane"` solo quando l'URL serve *all'umano* (OAuth, login, un dev
  server o un'anteprima da revisionare). Tutto il resto (leggere, verificare,
  estrarre) resta inline. La descrizione del tool diventa la regola.
- **Contesto inline `agent-<topic8>-<seq>`**, coniato server-side sul modello del
  fork task (`task-<id8>-<seq>`): opaco per routing e inventario, quindi tutti i
  `browser_*` lo guidano già oggi senza modifiche. **Non entra mai in `pane-store-v2`**
  (nessun `OPEN_PANE`, nessun tombstone, nessun LWW di pane) — la stessa invariante
  che ha tenuto pulite le tab del task.
- **Card inline nella chat**: il tool call `open_browser_pane` non renderizza più una
  riga muta ma una card browser — favicon + titolo + host + i passi che l'agent ha
  fatto su quel contesto (navigate/click/extract) + **l'ultimo fotogramma** della
  pagina. A fine utilizzo la card **resta lì, collassata**, come traccia permanente
  del thread.
- **Mai una webview nativa dentro la chat.** La card mostra un **fotogramma fermo**,
  non un motore vivo: una WKWebView ancorata a un messaggio che scorre è la classe di
  bug occlusione già pagata altrove (memory `native-webview-occlusion`). Il vivo
  esiste **solo** dopo la promozione, dove le pane vivono già.
- **Riprendere = promuovere.** Un click su "Apri" (nella card o nella riga di sidebar)
  apre una pane vera su quel `contextId` con l'URL corrente: da lì in poi è una pane
  normale, e l'agent che continua a guidare lo stesso `contextId` la guida dal vivo.
  Lato agent la promozione ha già il suo verbo: **`browser_focus_tab`** su un contesto
  inline significa "adesso guardalo tu" e lo promuove.
- **Sotto-elemento in sidebar**: ogni contesto inline vivo o parcheggiato di un topic
  compare come riga annidata sotto il topic (l'albero ha già `depth`/`nested`,
  `TopicItem.tsx:97-100,264`), con titolo pagina e la stessa azione "Apri".
- **Sospensione invece di accumulo**: un contesto inline inattivo (fine turno + idle)
  viene **sospeso** — motore distrutto, URL + ultimo fotogramma + log conservati.
  Riprenderlo ricarica dall'URL. Nessun Chromium/WKWebView orfano che sopravvive al
  lavoro che l'aveva aperto.

## Non-Goals

- **Vista live dentro la chat.** Niente stream continuo, niente webview nel messaggio:
  solo fotogramma + log. Rivalutabile in seguito, solo per il build web (dove
  `RemoteBrowserPanel` ha già lo stream headless) e comunque mai su motore nativo.
- **Toccare `pane-store-v2`, i suoi reducer/middleware o i fork esistenti**
  (terminale, task): il comportamento di `browser:open-near-pane` e
  `browser:open-task-tab` è invariato.
- **Euristiche di auto-promozione** ("sembra una pagina di login → apri la pane").
  La promozione è un atto esplicito: dell'agent (`browser_focus_tab` / `surface:"pane"`)
  o dell'umano (click). Indovinare qui è esattamente la schifezza da evitare.
- **Sostituire il browser di proprietà del task.** Un agent di board che lavora un
  task continua a finire nel gruppo del task; la superficie inline è quella della
  **chat** (memory `task-owned-browser-tabs`).
- **Rifare `browser_*`.** Nessun tool nuovo: il `contextId` inline passa dai canali
  esistenti.

## Impact

- `server/mcp/topics-mcp-server.ts` — arg `surface` su `open_browser_pane` (+ descrizione).
- `server/routes/topics.ts` — quarto fork in open-pane: conia/riusa `agent-<topic8>-<seq>`,
  naviga il contesto headless, broadcasta `browser:inline-tab`; `browser_focus_tab` su un
  contesto inline → promozione.
- `shared/ws-outbound.ts` + `client/src/types/index.ts` — nuovi frame WS
  (contract-lock: aggiornare **anche** `tests/unit/ws-outbound-schema.test.ts`, memory
  `mcp-browser-any-tab`).
- `client/src/state/agentInlineBrowsers.ts` (NUOVO, puro + test) — sessioni inline
  per-topic, persistite via ui-state LWW debounced (`agent-inline-browser:<topicId>`).
- `client/src/components/Chat/toolDetail.ts` + `ToolCards.tsx` — nuovo dettaglio
  `browser` e `BrowserCard`.
- `client/src/components/Sidebar/TopicTree.tsx` — righe annidate per i contesti inline.
- Spec: ADDED `CHAT-TOOL-05` (card inline) e `BROWSER-03` (superficie di apertura,
  promozione, sospensione).
- Nessuna migration (ui-state). Flag `TOPICS_INLINE_BROWSER` / `localStorage
  ['chat:inlineBrowser']` per il rollout; il default `surface:"inline"` si accende
  con il flag, così un rollback è una variabile e non un revert.
