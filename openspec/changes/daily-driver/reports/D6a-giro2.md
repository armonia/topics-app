# D6a, giro 2

## Barra prima

- `bun test client/src/lib/floatingSurfaces.test.ts`: exit 1, 2 pass e 1 fail. MOTION-04 segnala la superficie fatta a mano in `FirstRunHost.tsx`.
- La barra completa non è stata eseguita prima delle correzioni.

## Barra dopo

- `bun test client/src`: exit 0, 7.048 pass, 0 fail, 206.349 asserzioni su 665 file.
- `bun test client/src/lib/floatingSurfaces.test.ts client/src/components/FirstRun/firstRunModel.test.ts`: exit 0, 7 pass.
- `bun run typecheck`: exit 0, tutti i cinque target verdi, server con 0 errori.
- `bun run typecheck:e2e`: exit 0.
- `bun run lint`: exit 0, 0 errori e 4 warning in file non toccati.
- Mutazione in copia di `firstRunModel.ts`, rimossa la condizione sul nome segnaposto: il test è uscito 1, 3 pass e 1 fail sul caso `Ada`; la copia è stata eliminata.

## Fatto

- MOTION-04: `FirstRunHost` usa `MODAL_OVERLAY`, `MODAL_PANEL` e `useExitGhost`; la suite client passa.
- Riquadro provider: funzione pura e test per provider assente, non pronto e pronto. Mostra stato, requisito mancante e hint; offre la chiave Anthropic se nessun provider è pronto.
- «Fatto» salva il nome modificato prima di chiudere. Il campo accetta 80 caratteri.
- L’effetto di caricamento legge la traduzione da un ref e non riparte quando cambia identità `t`.
- La rinomina usa `PATCH /api/auth/people/:id`; rimossa da `PATCH /api/people/:id` e aggiornato il setup e2e. Testo verificato dall’API dopo «Salva il nome» e dopo «Fatto».
- La decisione di mostrare il primo avvio è pura; il test copre flag vuoto e proprietario `Proprietario`, con mutazione rossa.

## Trovato e non fatto

- Le e2e non sono state eseguite sul Mac, come vieta il brief. `first-run.spec.ts` è aggiornato e `typecheck:e2e` passa; servono la clip e il video della CI.
- Non esiste un file di test unitario per `server/routes/people.ts`; la route passa `typecheck` e lint. La prova runtime della nuova chiamata resta nell’e2e CI.

## Rifiutato

- I 4 warning lint appartengono a `App.tsx`, `useProjectBrowserPanes.ts`, `useRemoteBrowser.ts` e `useSpeech.ts`, tutti non modificati; il comando esce 0 e non indicano regressioni di questa traccia.
