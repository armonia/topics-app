# Tracce — browser-store-reaper-setting

Lo stato di una traccia lo dà il suo test, non una casella.

- **T1 colonne e rotta.** Migration con tre colonne nullable (livello 1, livello 2, giorni),
  `services/app-settings.ts`, `FIELD_RULES` (due booleani, i giorni riportati in 7..365), GET e PUT che
  rispondono 503 quando la riga non si legge. Barra: `server/routes/app-settings.test.ts`,
  `server/db/migration-registry-integrity.test.ts`, `server/db/migrations-embedded.test.ts`.
- **T2 significato condiviso e reaper.** `shared/browser-store-reap.ts` (modo `off | cache | all`) e il
  reaper che sceglie UN comando per modo, senza ripiego. Barra: `shared/browser-store-reap.test.ts`,
  `client/src/lib/browserDataStoreReaper.test.ts` e i mutanti M1..M3 del punto 8 di `specs/acceptance.md`.
  Dipende da T1 per la forma dei campi.
- **T3 Rust.** Comando `browser_reap_store_caches`, `empty_store_cache` condiviso con
  `browser_purge_cache`, costanti dei tipi cache e test puro, registrazione nel gestore, buchi
  dichiarati per webview2 e webkitgtk. Barra: `cargo test --lib` e `cargo check` in CI,
  `tests/unit/browser-platform-parity.test.ts`. Indipendente da T1 e T2.
- **T4 le righe nelle impostazioni.** `BrowserStoreReapRows.tsx` con due interruttori sotto quello della
  memoria in `PerfSection.tsx`, testi in `i18n-it.ts` e `i18n-en.ts`. Barra: `BrowserStoreReapRows.test.tsx`
  e il mutante M4, `typecheck:client`, `check:ui-language`, `check:typography`; screenshot chiaro e scuro
  per Attilio. Dipende da T1 e T2.
- **T6 client vecchio e liste vuote.** La rotta della keep list risponde solo a `?levels=2` e il reaper lo
  manda; lista vuota = -1 nel reaper e nessuno store in `stale_store_uuids`; `newest_mtime_shallow` torna
  `None` quando un'età non si legge. Barra: il punto 12 di `specs/acceptance.md`.
- **T5 spec e cancelli.** Questa cartella, `docs/browser-inventario.md`. Barra: il punto 9 di
  `specs/acceptance.md`.
