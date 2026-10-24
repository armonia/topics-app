# Acceptance — browser-store-reaper-setting

## Barra eseguibile

Ogni corsa è un file solo, sotto il tetto di memoria:
`OFFLOAD=local TOPICS_GATE_SLOTS=0 ~/bin/capped 2048 120 -- bun test <file>`.

1. `client/src/lib/browserDataStoreReaper.test.ts` esce 0 (16 test, BROWSER-STORE-REAP-01..04).
2. `server/routes/app-settings.test.ts` esce 0 (28 test, BROWSER-STORE-REAP-02/03/05) e
   `client/src/components/Sidebar/BrowserStoreReapRows.test.tsx` esce 0 (14 test,
   BROWSER-STORE-REAP-06; quattro montano il contenitore con `test/reactHarness` e `appSettingsApi`
   finto in memoria, nessuna richiesta esce dal processo).
3. `server/db/migration-registry-integrity.test.ts` e `server/db/migrations-embedded.test.ts` escono 0:
   la migration è nel registro e nel manifest.
4. Rossi prima, misurati, un giro per riga (test del commit nominato contro il codice di prima):
   - giro 1, test di `29a9fb3ea6` sul codice di `1127bd7c11`: 7 su 9 nel reaper (ignora
     l'impostazione, 60 fisso), 6 su 6 nuovi nella rotta (campi assenti);
   - giro 2, test di `109645e3eb` sul codice di `c1f9368614`: rotta 23 pass 2 fail, i due 503 della
     GET («the SELECT throws», «the database is not open»); nel reaper il caso 503 è verde anche prima
     (rifiutava già ogni risposta non 2xx), è copertura e non correzione;
   - giro 3, test di `84a6ccb099` sul codice di `e7fd5668f6`: rotta 26 pass 1 fail, «PUT: the write
     lands and the re-read fails» (Expected 503, Received 200). Gli altri test nuovi coprono buchi:
     i mutanti S10, S11, U7, U8, R3 del punto 5 SOPRAVVIVONO ai test di `e7fd5668f6` (0 fail nei tre
     file) e MUOIONO con quelli di `84a6ccb099`;
   - giro 4, solo test: i mutanti N1, N9, N20 e R7 del punto 5 sopravvivevano ai test di `31588fa55f`
     (0 fail nei tre file) e muoiono con quelli nuovi; il codice non cambia.
5. Mutanti, scritti a mano su copie e rimessi con `git checkout --`, ognuno rosso:
   - il reaper ignora l'impostazione (non la legge, o legge e non guarda `enabled`);
   - 60 scritto come costante al posto di `choice.afterDays`;
   - default spento (`enabled: === true`) o default diverso da 60 in `shared/browser-store-reap.ts`;
   - nessun riporto in 7..365, nel reaper e nella rotta (due mutanti separati);
   - nessun arrotondamento all'intero in `clampBrowserStoreReapDays`;
   - la GET che torna al lettore indulgente (`getAppSettings`), o un `readAppSettings` che inghiotte
     l'errore: lettura fallita = 503, mai 200 con tutto NULL;
   - il PUT che risponde con la rilettura indulgente (P1): rosso nella rotta;
   - riaccendere: `rowToSettings` che legge `=== 2` (S10) o `updateAppSettings` che scrive 0 per
     `true` (S11): rossi nella rotta;
   - il reaper senza `if (!res.ok) return null` (R3): un 500 o un 401 con dentro delle impostazioni,
     rosso nel reaper; e senza `typeof body.settings !== 'object'` (R7): un 200 con `settings` stringa
     o numero, rosso nel reaper;
   - una stringa vuota o di soli spazi per i giorni accettata come 0, quindi 7 (N9): rosso nella rotta;
   - il PUT che rilegge e risponde 503 prima degli hook della scrittura (N20): rosso nella rotta;
   - nella UI: interruttore disegnato al contrario, interruttore che salva il valore di prima, giorni
     salvati senza riporto, salvataggio di un valore uguale a quello salvato, campo attivo da spento,
     default disegnato prima della GET; e nel contenitore: la risposta del PUT non presa (U7,
     `setSettings(next)` tolto), la toppa fusa nello stato al posto della risposta (N1: rosso quando
     un altro dispositivo ha cambiato i giorni fra la GET e il PUT) e il salvataggio fallito non mostrato
     (U8, `setSaveFailed(true)` tolto).
   Uno alla volta, ognuno contro i file di test che lo riguardano; l'esito di ognuno sta nel messaggio
   del commit che li ha introdotti.
6. Cancelli a 0 dopo `git add -A`: `check:comment-language`, `check:identifier-language`,
   `check:emdash`, `check:bloat`, `check:untraced-tests`, `check:test-skips`, `check:eslint-disable`,
   `check:any`, `check:any-budget`, `check:deadcode`, `check:deadcode-blindspots`,
   `check:route-shadowing`, `check:migrations`, `check:ui-language`, `check:typography`,
   `check:spec-coverage`, `check:sleeps`, `check:api-door`, `check:nul`; `typecheck:client`,
   `typecheck:tests:client`, `typecheck:server`.
7. Ciò che giudica l'occhio: il livello Prestazioni in chiaro e in scuro, acceso e spento, lo conferma
   Attilio guardandolo. La barra verde prova che non è rotto, non che è giusto.

## Scenari

Quelli di `specs/remote-browser/spec.md`, uno per requisito.
