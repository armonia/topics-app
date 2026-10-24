# Tracce — browser-store-reaper-setting

Lo stato di una traccia lo dà il suo test, non una casella.

- **T1 colonne e rotta.** Migration con due colonne nullable, `services/app-settings.ts`,
  `FIELD_RULES` con il riporto in 7..365. Barra: `server/routes/app-settings.test.ts`,
  `server/db/migration-registry-integrity.test.ts`, `server/db/migrations-embedded.test.ts`.
- **T2 significato condiviso e reaper.** `shared/browser-store-reap.ts` (default, riporto) e il reaper
  che legge l'impostazione prima di tutto. Barra: `client/src/lib/browserDataStoreReaper.test.ts` e i
  mutanti del punto 5 di `specs/acceptance.md`. Dipende da T1 per la forma dei campi.
- **T3 la riga nelle impostazioni.** `client/src/components/Sidebar/BrowserStoreReapRows.tsx` sotto
  l'interruttore della memoria in `PerfSection.tsx`, testi in `i18n-it.ts` e `i18n-en.ts`. Barra:
  `typecheck:client`, `check:ui-language`, `check:typography`; screenshot chiaro e scuro per Attilio.
  Dipende da T1 e T2.
- **T4 spec e cancelli.** Questa cartella, `docs/browser-inventario.md`. Barra: il punto 6 di
  `specs/acceptance.md`.
