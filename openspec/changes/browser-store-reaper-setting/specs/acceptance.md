# Acceptance — browser-store-reaper-setting

## Barra eseguibile

Ogni corsa è un file solo, sotto il tetto di memoria:
`OFFLOAD=local TOPICS_GATE_SLOTS=0 ~/bin/capped 2048 300 -- bun test <file>`. Il Rust gira in CI
(`cargo check` e `cargo test --lib` su macOS, Windows, Linux).

1. `client/src/lib/browserDataStoreReaper.test.ts` esce 0 (26 test, BROWSER-STORE-REAP-01..04, 07..09):
   il livello 1 non chiama MAI `browser_reap_data_stores` in nessun percorso (riuscito, comando che
   lancia, keep list rotta in tre modi, impostazione non arrivata); il livello 2 è spento di default
   (null, assente, `false`, `0`, `1`, `'true'`, `'on'` restano sul livello 1); livello 2 acceso con
   livello 1 spento non chiama niente.
2. `shared/browser-store-reap.test.ts` esce 0 (6 test): la risoluzione in `off | cache | all`.
3. `server/routes/app-settings.test.ts` esce 0 (32 test, BROWSER-STORE-REAP-02/03/05/08): entrambi gli
   interruttori fanno andata e ritorno, `true` e `false`, ciascuno senza spostare l'altro, dal PUT, dal
   GET e dalla colonna; la migration gira su una riga con valori e le tre colonne nuove restano NULL.
4. `client/src/components/Sidebar/BrowserStoreReapRows.test.tsx` esce 0 (23 test, BROWSER-STORE-REAP-06):
   le due righe con le etichette esatte, la seconda disabilitata a livello 1 spento, ciascun interruttore
   salva solo il suo campo; il contenitore monta con `test/reactHarness` e `appSettingsApi` finto in
   memoria, nessuna richiesta esce dal processo.
5. `tests/unit/browser-platform-parity.test.ts` esce 0 (8 test): il comando nuovo dichiara i tre motori,
   e i due buchi (`webview2`, `webkitgtk`: livello 1 senza webview viva) sono fissati in `PINNED_GAPS`.
6. `server/db/migration-registry-integrity.test.ts` e `server/db/migrations-embedded.test.ts` escono 0.
7. Rust, modulo `cache_data_types` di `desktop-tauri/src-tauri/src/lib.rs`, su macOS: la lista dei tipi
   cache non ha chiavi in comune con l'identità (cookies, localStorage, sessionStorage, indexedDB,
   webSql), nomina solo chiavi note, non è vuota, e la tabella WebKit ha esattamente le chiavi note.
8. Rossi prima: i quattro file JS dei punti 1..4 contro il codice di prima dei due livelli
   (`8c6e9efc47`, solo i sorgenti rimessi indietro, i test nuovi) escono 1: reaper 16 pass 8 fail,
   righe 3 pass 20 fail, risoluzione condivisa 1 pass 5 fail, rotta 28 pass 4 fail. Corsa:
   <https://github.com/armonia/topics-app/actions/runs/40109126954>.
9. Mutanti, applicati alla testa su Linux e rimessi a posto dopo ogni giro; la testa intatta esce verde
   sui quattro file (24 + 23 + 6 + 32 test). Corsa: <https://github.com/armonia/topics-app/actions/runs/40109422145>.
   Ognuno esce rosso nel file che lo riguarda:

   | Mutante | Dove | Rosso in |
   |---|---|---|
   | M1 il livello 1 chiama la rimozione intera | reaper | reaper 8 fail |
   | M2 il livello 1 ripiega sulla rimozione intera se il comando nuovo lancia | reaper | reaper 2 fail |
   | M3 il livello 2 di default risulta acceso (`!== false`) | `shared/browser-store-reap.ts` | reaper 5, righe 3, condiviso 3 |
   | M4 la UI salva il livello 2 quando si preme il livello 1 | `BrowserStoreReapRows.tsx` | righe 6 fail |
   | M5 il livello 2 vale anche a livello 1 spento | `shared/browser-store-reap.ts` | reaper 1, condiviso 1 |
   | M6 il secondo interruttore non si disabilita mai | `BrowserStoreReapRows.tsx` | righe 3 fail |
   | M7 la rotta legge il livello 1 con `=== 2` | `server/services/app-settings.ts` | rotta 1 fail |
   | M8 il livello 1 spento si legge come livello 1 | `shared/browser-store-reap.ts` | reaper 3, condiviso 2 |
   | M9 il livello 1 di default spento (`=== true`) | `shared/browser-store-reap.ts` | reaper 5, righe 4, condiviso 3 |
   | M10 la UI salva il livello 1 quando si preme il livello 2 | `BrowserStoreReapRows.tsx` | righe 3 fail |
   | M11 la lista cache del Rust contiene `cookies` | `lib.rs`, macOS | 2 test su 10 |

   M11 è su macOS (`cargo test --lib -- cache_data_types reaper_degli_store`: testa verde 10 su 10, con
   il mutante 8 pass 2 fail). Corsa: <https://github.com/armonia/topics-app/actions/runs/40108835337>.
   I test della barra di #425 prima dei due livelli (riporto in 7..365 nel reaper e nella rotta,
   arrotondamento, GET e PUT che rispondono 503, riaccendere, i `DEFAULT` nella migration, scrittura dopo
   gli hook, campo dei giorni) restano nei file e verdi; i loro mutanti non sono stati rigiocati in
   questo giro.
10. Cancelli a 0 dopo `git add -A`: `check:comment-language`, `check:identifier-language`, `check:emdash`,
    `check:bloat`, `check:untraced-tests`, `check:test-skips`, `check:eslint-disable`, `check:any`,
    `check:any-budget`, `check:deadcode`, `check:deadcode-blindspots`, `check:route-shadowing`,
    `check:migrations`, `check:ui-language`, `check:typography`, `check:spec-coverage`, `check:sleeps`,
    `check:api-door`, `check:nul`; `typecheck:client`, `typecheck:tests:client`, `typecheck:server`.
11. Ciò che giudica l'occhio: il livello Prestazioni in chiaro e in scuro, con la seconda riga rientrata,
    attiva e disabilitata, lo conferma Attilio guardandolo. La barra verde prova che non è rotto, non
    che è giusto.
12. Client vecchio e liste vuote (BROWSER-STORE-REAP-09), sulla testa `69ec4a5131`, un file per corsa;
    i mutanti sono applicati a quella testa e rimessi a posto dopo ogni giro.
    - `server/routes/browser-info-probe-quiet.test.ts` esce 0 (5 test): senza `levels=2` (nudo,
      `levels=1`, `levels=`, `level=2`) la rotta risponde 404 `Browser context not found` senza warning;
      con `levels=2`, la lista.
    - `client/src/lib/browserDataStoreReaper.test.ts` esce 0 (26 test): il reaper chiede con `levels=2`;
      una lista `[]`, o di soli id vuoti o non stringhe, torna -1 senza nessun comando, ai due livelli.
    - `client/src/components/Sidebar/BrowserStoreReapRows.test.tsx` esce 0 (23 test): il suggerimento del
      livello 1 dice «Accessi e cookie restano», non più «dati dei siti».
    - Rust, `cargo test --lib reaper_degli_store` su macOS: 8 su 8. Lista vuota: nessuno store, all'età
      che con un'altra lista lo toglie. Store di cui non si leggono i figli (permessi 000, utente non
      root): nessuno store.
    - Rossi prima, gli stessi test sul codice di `72699abc6e`: rotta 4 pass 1 fail, reaper 13 pass 13
      fail, righe 22 pass 1 fail; per il Rust i mutanti R1 e R2 qui sotto sono il codice di prima.

    | Mutante | Dove | Rosso in |
    |---|---|---|
    | N1 la rotta risponde a tutti, senza guardare `levels` | `server/routes/browser.ts` | rotta 1 fail |
    | N2 basta un `levels` qualunque | `server/routes/browser.ts` | rotta 1 fail |
    | N3 il reaper chiede senza `levels=2` | reaper | reaper 13 fail |
    | N4 una lista vuota arriva a Tauri | reaper | reaper 1 fail |
    | N5 il suggerimento di prima | `i18n-it.ts` | righe 1 fail |
    | R1 nessuna guardia sulla lista vuota | `stale_store_uuids` | Rust 1 fail |
    | R2 un elenco dei figli che non si legge vale «nessun figlio» | `newest_mtime_shallow` | Rust 1 fail |

    Non coperti da un test, e perché: la cartella dello store la cui `metadata` fallisce si ferma prima,
    su `path.is_dir()`, che usa la stessa chiamata; un figlio la cui `metadata` fallisce succede solo se
    sparisce fra l'elenco e la lettura. Il `?` di `newest_mtime_shallow` copre tutti e due.

## Scenari

Quelli di `specs/remote-browser/spec.md`, uno per requisito.
