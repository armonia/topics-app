# D2a, in background si dorme

**Barra prima.** Bun `1.4.2`. Baseline e2e Chromium: non misurata sul Mac; conteggio iniziale `n.d.`.
**Barra dopo.** `bun test` mirati: 34/34, exit 0. `bun run typecheck`: exit 0. `bun run typecheck:e2e`: exit 0. `bun run lint`: exit 0, 4 warning preesistenti. E2e Chromium, conteggio dopo e mutazione: non eseguiti.

## Fatto

- Aggiunto `state/documentVisibility.ts`: un listener `visibilitychange` condiviso, timer periodici sospesi quando `document.hidden` e callback immediato al ritorno visibile.
- Collegati al punto condiviso i poll di sistema, presenza, amicizie, identità, metriche, dashboard, git, board e output dei comandi, più i ticker UI e la rete di sicurezza della vibrancy (poll da 700 ms). WebSocket, flush e azioni esplicite restano attivi.
- Aggiunti test unitari del ciclo visibile/nascosto e l’e2e `background-callback-budget.spec.ts`. L’e2e crea topic, board e inventario sessioni; mette in foreground una seconda tab via CDP `Page.bringToFront`, verifica `document.visibilityState === 'hidden'`, conta i callback per 10 s e verifica il refresh della presenza entro 1 s al ritorno.
- `bun test client/src/state/documentVisibility.test.ts client/src/hooks/useAnimationPause.test.ts client/src/hooks/useSystemStatus.test.ts client/src/hooks/useGitStatus.test.ts client/src/hooks/usePerfMetrics.test.ts client/src/hooks/useGlobalBoard.test.ts`: 34 pass, 0 fail, exit 0.
- `bun run typecheck`: exit 0. `bun run typecheck:e2e`: exit 0. `bun run lint`: exit 0; 4 warning in `App.tsx`, `useProjectBrowserPanes.ts`, `useRemoteBrowser.ts` e `useSpeech.ts`.

## Trovato e non fatto

- Mancano baseline pre-fix, conteggio post-fix e prova che la soglia sia rossa prima e verde dopo. Il brief vieta Chromium sul Mac e non consente push/commit; serve la CI dopo la consegna del ramo.
- `MAX_HIDDEN_CALLBACKS = 12` è una soglia provvisoria, non ancora fissata dalla misura post-fix richiesta. Va sostituita col valore misurato più margine.
- Mutazione in copia non verificata: va forzato `isDocumentVisible()` a `true`; l’e2e deve fallire. Manca anche il video e2e della CI.

## Rifiutato

- `Emulation.setFocusEmulationEnabled` non prova `document.hidden`. La spec porta una seconda tab davanti con CDP e controlla lo stato reale, poi misura la callback window.
- I warning lint sono in file non modificati e restano invariati; il comando esce 0.

## Giro 2 (CI)

- La prima e2e non poteva nascondere la pagina: in Chromium senza finestra una seconda tab portata davanti con CDP lascia la prima `visible` (clip rossa, run 38670958942, `visibilityState` mai `hidden`). Ora la spec pilota `document.visibilityState` e `document.hidden` come `idle-frame-budget` e lancia `visibilitychange`. Chrome così non rallenta niente: il conto è solo la disciplina dell'app.
- Misura a finestra nascosta: **12 callback in 10 s** (clip verde, run 38671941978). Mutante con `isDocumentVisible()` sempre vero: **620** (run 38671981581, rossa sulla soglia). `MAX_HIDDEN_CALLBACKS = 16`: un solo poller nuovo a 1 Hz lasciato sveglio ne aggiunge 10 e la sfora.
- 20 cancelli statici: 0 rossi.
