# Tasks: history-panel-filters

Prima del codice: `grep -qx 'status: approved' openspec/changes/history-panel-filters/.openspec.yaml`.

## 1. Test rossi sul tree di oggi

- [ ] 1.1 `client/src/lib/historyRows.test.ts`: i cinque scenari di HISTORY-02
      (tipo, ieri a mezzanotte, filtro prima del tetto, futuro, cambio d'ora con
      `process.env.TZ = 'Europe/Rome'` in `beforeAll` e in `afterAll` la
      riassegnazione del fuso letto prima con
      `Intl.DateTimeFormat().resolvedOptions().timeZone`, mai `delete`: design
      §2). Header `@covers HISTORY-01, HISTORY-02`. Rosso oggi: `kind`, `range`
      e `historyRangeOf` non esistono.
- [ ] 1.2 `tests/e2e/history-filters.spec.ts` (nuovo) su `:13334`, uno scenario
      per test con `test.info().annotations.push({ type: "spec", description: "HISTORY-0N" })`:
      HISTORY-03 (5), HISTORY-04 (5), HISTORY-05 (2). Semina: pagine con
      `page.addInitScript` su `localStorage['topics:browser-pages:v1']`
      (formato `PageVisit[]`, `client/src/state/browserSiteHistory.ts:55-64`);
      tab chiuse con `seedPaneStore` (`tests/e2e/helpers/api-fixtures.ts:334`)
      e un `closedStack` non vuoto, in `beforeEach` come
      `tests/e2e/pane-undo.spec.ts:80-105`. Apertura dal menu utente con
      `openProfileMenu` (`tests/e2e/helpers/open-perf-panel.ts:24`), poi
      `topics-menu-history` e `topics-menu-history-all`. Orologio con
      `page.clock.setFixedTime` dove conta il giorno.

## 2. Funzione pura (HISTORY-02)

- [ ] 2.1 `client/src/lib/historyRows.ts`: tipo `HistoryRange`,
      `historyRangeOf(at, now)` coi confini del design §2, input `kind`,
      `range`, `now` in `buildHistoryRows`; ordine tipo, giorno, ricerca,
      ordinamento, tetto.
- [ ] 2.2 Il commento di `historyRows.ts:53-55` («la regola che la palette già
      segue») torna vero dopo il §3: rileggerlo e correggerlo se serve.

## 3. Palette (HISTORY-03, HISTORY-04, HISTORY-05)

- [ ] 3.1 `client/src/components/Shared/HistoryFilters.tsx` (nuovo),
      controllato, forma di `FileSearch.tsx:252-281`, colonna su telefono.
- [ ] 3.2 `CommandPalette.tsx`: stato `historyKind`/`historyRange`, azzerato
      nell'effetto di apertura (`:518-525`); barra montata fra `:636` e `:641`
      solo con `scope === 'history'`; fuoco al campo dopo `onChange`; effetto
      della selezione (`:510-513`) esteso ai due filtri.
- [ ] 3.3 `recentItems` (`:306-346`) da `buildHistoryRows` con `query`, filtri e
      tetto come nel design §3; `recentFiltered` (`:474`) senza
      `filterByQuery`; `testId` `history-row-tab`/`history-row-page`.
- [ ] 3.4 Suggerimento ⇧⌘T per id (`:334-337`, design §5).
- [ ] 3.5 Vuoto con filtri: `EmptyState` con `action` e `history-filter-reset`.
- [ ] 3.6 `highlightQuery` (`:923-932`) a parole, dalla più lunga (design §6).
- [ ] 3.7 Chiavi i18n in `i18n-it.ts` e `i18n-en.ts` accanto a
      `palette.searchHistory`: etichette dei 7 bottoni, dei 2 gruppi,
      «Niente con questi filtri», «Mostra tutto».

## 4. Verifica

- [ ] 4.1 `bun test client/src/lib/historyRows.test.ts`, `bun run typecheck`,
      `bun run check:emdash`, `bun run check:ui-language`,
      `bun run check:spec-coverage`. La suite unit intera e l'E2E li fa la CI.
- [ ] 4.2 Prova video: `E2E_VIDEO=1 npx playwright test tests/e2e/history-filters.spec.ts`,
      il `.webm` dello scenario «solo le pagine» e di «filtri che svuotano la
      lista».
