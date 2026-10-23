# Report D3d

## Barra

**Prima:** checkout pulito su `daily/d3d-native-git-status`, `HEAD = origin/main` (`c2459342`), Bun 1.4.2. La prima `./scripts/qa-gate.sh --veloce`, già durante la prima bozza, uscì 1: 22 cancelli verdi, `check:deadcode-blindspots` rosso perché `git-relative-date.ts` non era ancora collegato.

**Dopo:** `./scripts/qa-gate.sh --veloce`, exit 0, 25/25 cancelli verdi; `bun run typecheck`, `bun run typecheck:e2e` e `bun run lint`, exit 0. I test mirati, eseguiti con `bun test --timeout 30000 server/lib/git-relative-date.test.ts server/lib/git-status.native.test.ts native/parity.test.ts server/lib/native-addon.test.ts`, exit 0: 36 pass, 103 assert.

## Fatto

- Con addon caricato e impostazione attiva, `computeGitStatus` usa lo status nativo e lascia i due numstat a Git: tre repo fixture (pulito, sottocartella modificata, HEAD staccata) danno lo stesso `ComputedGitStatus`; 2 spawn contro 5. Addon assente, rifiuto e switch spento usano Git; test del rifiuto: 5 spawn, `fallbacks +1` e `lastError` aggiornato. La mutazione in copia che ignora l'addon è rossa: attesi 2 spawn, osservati 5.
- `gitRelativeDate` coincide con `%ar` su 31 scarti, incluse le soglie richieste e il futuro. Il crate espone i secondi della data autore.
- `/api/system/status` espone `nativeGit`; l'interruttore Performance usa il `settings` sincronizzato in `ui_state`, acceso di default, con testi IT/EN per stato attivo, modulo assente e switch spento.
- Scenario Playwright aggiunto in `tests/e2e/perf-panel.spec.ts`, copre click, salvataggio server e reload; `typecheck:e2e` exit 0. Il video verrà prodotto dalla CI, gli E2E locali sono vietati dal brief.
- Addon di debug arm64 compilato e provato con la parità e i test del server. Nessuna misura di tempo: vale solo la build release.

## In revisione

- Il test con i repo di prova usa un modulo finto che chiama git: prova l'adattatore, non l'addon.
  Quello con l'addon vero c'era, ma passava in silenzio dove l'addon manca e in CI girava solo lì.
  Ora si salta dicendolo, copre i tre repo (pulito, sottocartella, HEAD staccata) e gira nel job
  `tauri`, che costruisce l'addon, accanto a `native/parity.test.ts`. Sul Mac, con l'addon di debug:
  3 su 3.

## Trovato e non fatto

- D3e (numstat nativo), build/test del server compilato sui tre sistemi CI, video E2E e misura release restano fuori da D3d o dalla verifica locale autorizzata. Servono la traccia successiva e la CI dopo il push del proprietario.
- Dopo l'avvio `origin/main` è avanzato di due commit (`93480b2c`, `4b6de8ff`), da `c2459342` a `4b6de8ff`. I file aggiornati non si sovrappongono al diff D3d; il ramo resta sul commit iniziale, senza fast-forward.

## Rifiutato

- L'assenza iniziale di `native/topics_native.node` è il caso di fallback previsto, non un guasto: il test del modulo assente e il fallback Git sono verdi.
