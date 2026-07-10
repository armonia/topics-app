# Tasks — chat-ux-reliability

Convenzione: `[ ]` da fare, `[x]` fatto+verificato.

> STATO: **implementata e verificata** (2026-07-10). tsc client+server verdi; unit
> reducer 4/4; chat.spec 13 passed + "aborts streaming" env-dependent (skippa senza
> gateway, non correlato); message-action toolbar 2/2 verdi con CLICK REALI; strip
> errore nav verificata live (frame WS `phase:'error'` + render + Riprova); New Chat
> mobile verificata live su client freddo 375px (composer renderizzato, prima
> no-op/blank); toast ACL updater assente nei pane col bundle nuovo.
> Nota path nativo (Rust did-fail): FOLLOW-UP dedicato, fuori scope qui.

## Phase A — Toolbar azioni messaggio (CHAT-REL-01)
- [x] A.1 `MessageBubble.tsx` — rimosso `overflow-hidden` dal wrapper (il clipping del
  contenuto resta sulla bubble interna); toolbar `bottom-full` visibile e cliccabile.
- [x] A.2 `MessageBubble.tsx` — `pointer-events-none` sulla riga del separatore data.
- [x] A.3 `tests/e2e/chat.spec.ts` — message-action test con hover+click REALI
  (rimossi force/dispatchEvent sui bottoni toolbar). 2/2 verdi = regression guard.

## Phase B — Render self-healing standalone (CHAT-REL-02)
- [x] B.1 `PanelGrid.tsx` — memo `effectiveGridRows` (gridRows ∪ riga sintetica per
  chiavi itemMap mancanti); consumer di render switchati (keyPos, treeRoot,
  renderTreeLeaf cellStacks, topicPositions, splitRowWidths, ramo mobile).
- [x] B.2 Verifica live: client freddo 375px, CTA "New Chat" → composer draft
  renderizzato subito (prima: draft nello store, UI no-op/blank).

## Phase C — /browser ownership + feedback (CHAT-REL-03)
- [x] C.1 `usePaneOrdering.ts` — bail `hasProjectPaneRef` ristretto agli eventi SENZA
  topicId; con topicId decide la membership (già nel reducer). Seed URL spostato nel
  ramo claimed (niente leak nei gruppi che bailano).
- [x] C.2 `ChatPane.tsx` — feedback "Opening browser → <url>" GIÀ presente (verificato).
- [x] C.3 Copertura logica: topic di progetto non in orderedIds standalone → nessun
  hijack; topic standalone gestito anche con tab progetto aperte.

## Phase D — No-steal browser singleton (BRW-REL-01)
- [x] D.1 `usePaneOrdering.ts` `browserSingletonReducer` — con contextId esplicito e
  nessun match crea `browser:<ctx>`; rebind eliminato; legacy senza ctx invariato.
- [x] D.2 `usePaneOrdering.browserSingleton.test.ts` — 4 test verdi (riuso esatto,
  no-steal/crea nuovo, legacy reuse, legacy create).

## Phase E — Nav error surfacing web-path (BRW-REL-02)
- [x] E.1 `server/browser-ws-messages.ts` + mirror client — fase `error` + campo
  `error?` (additivo).
- [x] E.2 `server/browser-service.ts` — goto fallita risolve con `error` (shape);
  `server.ts` — request nav: resolve-with-error E reject (launch fail) → frame
  `phase:'error'` sul WS.
- [x] E.3 `useRemoteBrowser.ts` — nav error → `error`+`errorUrl`; navigate() li
  azzera; watchdog timeout ora messaggia ("Navigation timed out"); tolto il reset
  di `error` su ws.onopen (il churn di reconnect cancellava la strip).
- [x] E.4 `RemoteBrowserPanel.tsx` — strip `data-testid="browser-nav-error"`
  (role=alert) con motivo + Riprova (re-invia errorUrl).
- [x] E.5 Verifica live: URL remota fallita → strip "Chromium executable not found …
  Riprova" (env senza Chromium = launch-fail path); frame WS verificati raw.
  NOTA: URL locali (localhost/127.0.0.1/*.local) usano il ramo IFRAME, non lo
  screencast — fuori da questo canale by design.

## Phase F — UpdaterToast (BRW-REL-03)
- [x] F.1 `UpdaterToast.tsx` — clamp `right` nel viewport (worst-case 320px) +
  fallback corner per anchor <40px (rail collassata).
- [x] F.2 `lib/updater.ts` — reject ACL (/not allowed|acl/i) su updater_check →
  updater non disponibile per la webview (idle, no-retry), mai toast.
- [x] F.3 Verifica live: client nel pane webview col bundle nuovo → nessun toast ACL.

## Phase G — Gate finale
- [x] G.1 `tsc` client + typecheck server verdi (baseline 0); unit 4/4.
- [x] G.2 E2E: chat.spec 13 passed (+1 env-skip); toolbar 2/2 con click reali.
- [x] G.3 Commit per-fase con pathspec esplicito (no trailer, no push).
