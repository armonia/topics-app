# Acceptance — browser-store-reaper-setting

## Barra eseguibile

I test TypeScript girano su GitHub Actions (il Mac è sotto carico): la CI della PR e il banco dei
mutanti (`bench/…`, un giro per mutante, link nel corpo della PR). Un file solo, in locale, solo a
carico basso: `OFFLOAD=local TOPICS_GATE_SLOTS=0 taskpolicy -b ~/bin/capped 2048 300 -- bun test --timeout 60000 <file>`.

1. `client/src/lib/browserDataStoreReaper.test.ts` esce 0 (BROWSER-STORE-REAP-01..04, 07, 08): il
   livello 1 non chiama MAI `browser_reap_data_stores`, in nessun percorso, nemmeno quando il suo
   comando lancia; il livello 2 acceso su un livello 1 spento non rimuove niente.
2. `shared/browser-store-reap.test.ts` esce 0: livello 2 acceso solo da `true` esplicito (NULL, assente,
   stringa, numero = spento), livello 1 spento solo da `false` esplicito, `all` vuole entrambi.
3. `server/routes/app-settings.test.ts` esce 0 (BROWSER-STORE-REAP-02/03/05/08): entrambi gli
   interruttori fanno andata e ritorno con true e false, ciascuno senza muovere l'altro; la migration
   aggiunge tre NULL senza DEFAULT.
4. `client/src/components/Sidebar/BrowserStoreReapRows.test.tsx` esce 0 (BROWSER-STORE-REAP-06): le due
   righe, la seconda rientrata e disabilitata a livello 1 spento, ogni pressione salva il suo campo.
5. `cargo test --lib` (job «Cargo test (guscio Tauri, per OS)» della CI, macOS compresa) esce 0 col modulo
   `cache_data_types`: l'elenco cache non ha chiavi d'identità, ha solo chiavi note, e su macOS la tabella
   WebKit ha esattamente le chiavi note. `cargo check` esce 0 sulle tre OS.
6. `tests/unit/browser-platform-parity.test.ts` esce 0: `browser_reap_store_caches` dichiara i suoi due
   buchi (webview2, webkitgtk) e `PINNED_GAPS` li elenca.
7. `server/db/migration-registry-integrity.test.ts` e `server/db/migrations-embedded.test.ts` escono 0:
   la migration riscritta è nel registro e il manifest è rigenerato (`gen-migrations-manifest.ts`).
8. Mutanti, scritti come patch, applicati uno alla volta al capo della PR e rimessi; ognuno rosso nel
   file che lo riguarda:
   - **M1** il livello 1 chiama la rimozione intera (`cache` → `browser_reap_data_stores`): rosso nel reaper;
   - **M2** il livello 1 ripiega sulla rimozione intera quando il comando nuovo lancia: rosso nel reaper;
   - **M3** il livello 2 si legge acceso di default (`!== false`): rosso in `shared/browser-store-reap.test.ts`
     e nel reaper;
   - **M4** la UI salva il livello 2 quando si preme il livello 1: rosso in `BrowserStoreReapRows.test.tsx`.
9. Cancelli a 0 dopo `git add -A`: `check:comment-language`, `check:identifier-language`, `check:emdash`,
   `check:bloat`, `check:untraced-tests`, `check:test-skips`, `check:eslint-disable`, `check:any`,
   `check:any-budget`, `check:deadcode`, `check:deadcode-blindspots`, `check:route-shadowing`,
   `check:migrations`, `check:ui-language`, `check:typography`, `check:spec-coverage`, `check:sleeps`,
   `check:api-door`, `check:nul`; `typecheck:client`, `typecheck:tests:client`, `typecheck:server`: li
   esegue la CI della PR.
10. Ciò che giudica l'occhio: il livello Prestazioni in chiaro e in scuro, le due righe, con il livello 1
    spento e acceso, lo conferma Attilio guardandolo. La barra verde prova che non è rotto, non che è giusto.

## Scenari

Quelli di `specs/remote-browser/spec.md`, uno per requisito.
