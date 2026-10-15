# D4b, B2: eco scroll ordinate per sequenza

**Barra prima:** `bun test client/src/lib/mirrorScroll.test.ts` exit 0, 10 pass, 0 fail. La regressione già documentata: Chromium 3/3 rossi (run 38680990091), WebKit instabile (run 38682958298). Gli altri cancelli non misurati prima della modifica.

**Barra dopo:** test mirati 12/12; typecheck 0; typecheck:e2e 0; lint 0; `./scripts/qa-gate.sh --veloce` 0, 25/25 cancelli verdi. `git diff --check` 0.

## Fatto

- `shared/browser-ws-messages.ts`, `DomCoBrowse.tsx`, `nativeDomHost.ts`: ogni relay porta `scrollSeq`; il recorder nativo la restituisce con l'eco. `createEchoHold` scarta le sequenze vecchie senza guardare il tempo e lascia passare subito la sequenza corrente, anche se posizione e relay differiscono. Gli host senza sequenza mantengono il percorso temporizzato legacy.
- `bun test client/src/lib/mirrorScroll.test.ts client/src/lib/nativeDomHost.page.test.ts client/src/lib/nativeDomHost.test.ts`: exit 0, 54 pass, 0 fail, 153 asserzioni.
- Mutazione in copia nello scratchpad: rimosso di fatto il confronto che scarta le sequenze vecchie; il test nuovo è rosso, 11 pass e 1 fail, exit 1. Copia rimossa.
- `bun run typecheck`: exit 0. `bun run typecheck:e2e`: exit 0.
- `bun run lint`: exit 0, 4 warning preesistenti in file non toccati.
- `./scripts/qa-gate.sh --veloce`: exit 0, barra verde; tutti i 25 cancelli elencati verdi.

## Trovato e non fatto

- Clip e2e `repeat=30`, `load=true`, Chromium e WebKit su `browser-mirror-scroll-lands.spec.ts`: non eseguita sul Mac come richiesto. Va lanciata in CI dopo il push; il brief vieta push e commit in questa worktree.
- Revisione indipendente, merge e porto in produzione restano successivi alla consegna locale.

## Rifiutato

- I 4 warning ESLint provengono da `App.tsx`, `useProjectBrowserPanes.ts`, `useRemoteBrowser.ts` e `useSpeech.ts`; lint esce 0 e nessuno dei file è stato toccato.
