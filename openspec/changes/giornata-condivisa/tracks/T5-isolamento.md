# T5 - Il verdetto di un test non dipende dai vicini

**GOAL.** I file unit girano isolati: lo stesso file da' lo stesso esito in
qualunque ordine, e i tre cancelli che esistono solo per contenere la
contaminazione si possono togliere.

## Perche' ora

`bun test` esegue tutti i file **nello stesso processo**: DOM globals, `DATA_DIR`,
`mock.module`, `SOCKET_PATH` e i timer di `terminal.ts` passano da un file al
successivo. Misurato: 1.932 file unit, 22.181 test, **1.331 s in un unico
processo seriale**, perche' i due tentativi di shard in-process documentati in
`ci.yml:41-66` erano piu' veloci (4,7 e 6,8 min) ma rossi su test «mai gli
stessi» (run 36487615331, 36489705731).

Prova dell'effetto: i run di `main` 39685801141 e 39693954116 sono rossi mentre
la PR 39689562044, con due fette diverse, e' verde **sullo stesso test**
`hooks-settings`. `main` e' stata rossa dal 21/10 22:20 al 22/10 10:29. Il rosso
era una race vera in `server/routes/terminal.ts`: `ensureBridge` rilegge
`SOCKET_PATH`, spostato solo dai test. Il fix sta su `fix/hooks-test-flake`
(1798e50c69), non ancora in main.

Le difese sono tutte a valle e una per classe: `check:module-mock-restore` in
CI, `test-data-dir-restore`, e `check:test-globals` che **non e' in CI perche'
costa 18 min** (`scripts/check-test-globals.ts:25-35`).

## Cosa cambia

1. **Prima la misura**: quanto costa davvero un processo per file. Il 05/09
   erano 78 s su 1.149 file con 6 processi, non 18 min. Il numero decide la
   forma (processo per file o per gruppo piccolo).
2. Tmp, `DATA_DIR` e porte allocati per processo dal preload.
3. Poi si eliminano i tre cancelli: il difetto non e' piu' rappresentabile.
4. L'isolamento portera' alla luce le dipendenze **inverse**, come
   `terminal-roster-boot-bridge-late.test.ts`, che e' rosso se manca lo stato
   lasciato dai test server. Vanno corrette, non aggirate.

## Barra

- Suite con ordine dei file randomizzato, 20 giri: 0 rossi.
- 4 shard in-process verdi 20/20, p50 sotto 300 s.
- I tre cancelli di contaminazione rimossi, e la CI resta verde senza di essi.

## Fuori

Toccare le e2e. Hanno 80 `describe.serial` in 77 file e un worker per shard: e'
un altro problema, con un'altra barra.
