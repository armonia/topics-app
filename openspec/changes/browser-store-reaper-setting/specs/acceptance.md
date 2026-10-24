# Acceptance — browser-store-reaper-setting

## Barra eseguibile

Ogni corsa è un file solo, sotto il tetto di memoria:
`OFFLOAD=local TOPICS_GATE_SLOTS=0 ~/bin/capped 2048 120 -- bun test <file>`.

1. `client/src/lib/browserDataStoreReaper.test.ts` esce 0 (9 test, BROWSER-STORE-REAP-01..04).
2. `server/routes/app-settings.test.ts` esce 0 (20 test, i 6 nuovi su BROWSER-STORE-REAP-02/03).
3. `server/db/migration-registry-integrity.test.ts` e `server/db/migrations-embedded.test.ts` escono 0:
   la migration è nel registro e nel manifest.
4. Gli stessi due file del punto 1 e 2 escono ROSSI sul codice del commit dei test (`test(browser): …`):
   7 su 9 nel reaper (ignora l'impostazione, 60 fisso), 6 su 6 nuovi nella rotta (campi assenti).
5. Mutanti, scritti a mano su copie e rimessi con `git checkout --`, ognuno rosso:
   - il reaper ignora l'impostazione (non la legge, o legge e non guarda `enabled`);
   - 60 scritto come costante al posto di `choice.afterDays`;
   - default spento (`enabled: === true`) o default diverso da 60 in `shared/browser-store-reap.ts`;
   - nessun riporto in 7..365, nel reaper e nella rotta (due mutanti separati).
6. Cancelli a 0 dopo `git add -A`: `check:comment-language`, `check:identifier-language`,
   `check:emdash`, `check:bloat`, `check:untraced-tests`, `check:test-skips`, `check:eslint-disable`,
   `check:any`, `check:any-budget`, `check:deadcode`, `check:route-shadowing`, `check:migrations`,
   `check:ui-language`, `check:typography`, `check:spec-coverage`; `typecheck:client`,
   `typecheck:tests:client`, `typecheck:server`.
7. Ciò che giudica l'occhio: il livello Prestazioni in chiaro e in scuro, acceso e spento, lo conferma
   Attilio guardandolo. La barra verde prova che non è rotto, non che è giusto.

## Scenari

Quelli di `specs/remote-browser/spec.md`, uno per requisito.
