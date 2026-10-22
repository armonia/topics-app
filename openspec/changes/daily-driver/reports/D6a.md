# D6a · Primo avvio

**Barra prima:** `bun run typecheck` exit 0; `bun run typecheck:e2e` exit 0; `bun run lint` exit 0, 4 warning preesistenti; test mirati non eseguiti.

**Barra dopo:** `bun run typecheck` exit 0; `bun run typecheck:e2e` exit 0; `bun run lint` exit 0, stessi 4 warning; test mirati 29 pass, 0 fail, 55 asserzioni; `bun run check:spec-coverage` exit 0, 1259/1259 requisiti; `bun run check:emdash` exit 0; `git diff --check` exit 0.

## Fatto

- Schermata iniziale saltabile con quattro riquadri IT/EN. Salva il nome sulla persona proprietaria esistente; mostra agenti trovati, percorsi e comandi da copiare; riusa `ApiKeyForm`; mostra provider e modello dichiarato; account remoto chiuso di default e apribile dalla schermata. La si riapre dal menu identità.
- `firstRunDoneAt` persiste su `app_settings`; la schermata lo scrive quando viene vista e quando si preme «Salta» o «Fatto». La baseline `TOPICS_E2E=1` lo semina prima del checkpoint, le e2e dedicate lo azzerano.
- Rimossi dalla proposta solo il banner di mancata approvazione e il cancello «vai»; le cinque raccomandazioni restano invariate.
- File toccati: `client/src/App.tsx`; `client/src/components/FirstRun/{FirstRunHost.tsx,agentSetupRows.ts,agentSetupRows.test.ts}`; `client/src/components/Sidebar/{IdentityMenuItems.tsx,useProfileIdentity.ts}`; `client/src/lib/{api.ts,openFirstRun.ts,i18n-en.ts,i18n-it.ts}`; `server/db/{test-schema.ts,migrations/20261015090000-first-run-done-at.sql}`; `server/routes/{app-settings.ts,people.ts}`; `server/services/{app-settings.ts,app-settings.test.ts}`; `tests/e2e/{global-setup.ts,first-run.spec.ts}`; `openspec/specs/first-run/spec.md`; `openspec/changes/primo-avvio/proposal.md`; questo REPORT.

## Trovato e non fatto

- E2E con video (Fatto, Salta e riapertura) e mutazione del flag non eseguiti: il brief locale vieta le e2e sul Mac e vieta push/commit; il workflow «Clip di consegna» li misura in CI dopo il push. Le spec sono state aggiunte e `bun run typecheck:e2e` è verde.

## Rifiutato

- Non serviva una nuova rotta per rilevare agenti: `GET /api/system/agents` esisteva già. Il PATCH persona esistente è stato esteso al solo nome del proprietario; non è stata aggiunta una rotta di rinomina.
