# D7e — identità delle viste singleton di progetto

**Barra prima:** mutazione UUID nella copia scratchpad, 4/4 test identità rossi, exit 1.
**Barra dopo:** `bun test ...projectPaneIdentity.test.ts ...useProjectLayout.closeIndex.test.tsx ...useProjectChatSync.test.tsx`, 16 pass / 0 fail, exit 0; `./scripts/qa-gate.sh --veloce`, typecheck, lint e tutti i `check:*` verdi, 0 rossi.

**Barra prima, giro 2:** CI run 38688830677, 3 e2e rossi anche ai retry (una spec archive e due split); `preview-guard-headers` ha fallito una volta ma è passata al retry.
**Barra dopo, giro 2:** `bun run typecheck`, `bun run typecheck:e2e`, `bun run lint`: exit 0 ciascuno; lint 0 errori e 4 warning già esistenti. E2E non eseguite sul Mac, come richiesto.

## Fatto

- **0.1:** `createProjectSingletonPaneId(projectPath, type)` dà lo stesso id al medesimo progetto e tipo, e id distinti a progetti diversi. Test mirati: exit 0.
- **0.2:** rimosso `localSingletonTypes`; la sync migra l’id remoto prima dell’unione per id. Testa l’id canonico nel callback remoto, l’unione per id senza duplicati e l’apertura di Git in un altro gruppo: exit 0.
- **0.3:** seed iniziale e liste remote convertono gli id legacy, preservano `stableKey ?? id` e tengono la prima copia nell’ordine dei gruppi. Test migrazione: exit 0.
- **0.4:** il presidio fallisce se il generatore torna casuale. Mutazione in copia: 4 fail, exit 1; codice ripristinato. Test mirati: 16/16, exit 0.
- Typecheck, lint e cancelli `check:*` della barra veloce: exit 0.
- Revisione indipendente read-only di `/root/review_d7e`: nessun finding; checklist e prove coerenti.

## Trovato e non fatto

- Nessun blocco nello scope stadio 0. Browser, terminale, chat, singleton standalone e stadi 2–3 restano fuori scope.

## Rifiutato

- Conteggio dei processi WebContent non applicabile: nessuna singleton di progetto ospita una WKWebView; il browser usa l’id del contesto ed è escluso.

## Revisione, e cosa ho cambiato del giro di Codex

- **Il dedup per tipo copriva più delle singleton.** Valeva per ogni tipo tranne chat e terminale.
  Toglierlo del tutto avrebbe fatto entrare sempre le pane remote di `file`, `plan`, `process-log`
  e `browser`, i cui id nascono ancora sul dispositivo che apre: lo stesso file aperto su due
  dispositivi diventava due schede. Ora vale solo per quei tipi; le singleton si uniscono per id.
  Lo scope che avevo scritto chiedeva di toglierlo tutto: l'errore era mio.
- **Il presidio non mordeva sulla creazione.** Confrontava la funzione con sé stessa; il test
  «già aperta» passava dalla migrazione. Ora `useProjectLayout.singleton.test.tsx` apre Git da
  entrambe le porte (`addToGroup` e `addWhenEmpty`), e ciascuna è rossa se torna a
  `createPaneId(type)`.
- **`handleAddPaneWhenEmpty` leggeva `panes` e `groups` senza averli tra le dipendenze**, cioè
  valori vecchi. Il blocco ripetuto nelle due porte è diventato `focusOpenSingleton`, nelle
  dipendenze di entrambe. Una singleton aperta ma non ancora in un gruppo si riusa invece di
  crearne una seconda con lo stesso id; nella seconda porta il controllo viene dopo la rimozione
  del tombstone, come nella prima.
- **La migrazione riordinava l'array delle pane** secondo i gruppi: ora sceglie la copia che
  resta con l'ordine dei gruppi e lascia l'ordine delle pane com'era.
- Commento in `paneConfig.ts` che diceva casuali gli id di `git`, `files` e `kanban`: riscritto.
- **Mutanti**, in una worktree usa e getta, ognuno rosso sul suo test e solo lì: porta 1 casuale,
  porta 2 casuale, niente fuoco sulla singleton aperta, niente migrazione al mount (2 test),
  niente migrazione della lista remota (2), niente dedup per i tipi per dispositivo, sopravvive
  l'ultima copia invece della prima. Test dopo: 21 pass, 0 fail.

## Trovato e non fatto, dopo la revisione

- Finché una pane `browser`, `file`, `plan` o `process-log` è aperta qui, una seconda dello stesso
  tipo aperta su un altro dispositivo non compare. È il comportamento di prima, ora scritto; lo
  toglie lo stadio 2, quando le pane le possiede il server.

## Giro 2: gli e2e della PR

### Fatto

- In `project-archive-layout.spec.ts:53` e `project-tabs.spec.ts:680`, i test seminano ancora un id Git legacy, ma locator, snapshot e asserzioni usano `createProjectSingletonPaneId(PROJECT_PATH, "git")`. Le verifiche di anteprima e riapertura restano intatte.
- In `split-reorg-budget.spec.ts:289` e `:529`, i seed Git/Files restano legacy e tutti i lookup usano gli id canonici ottenuti dalla funzione di prodotto. I controlli che ogni pane resti montata durante i gesti non sono stati indeboliti.
- La migrazione sostituisce `id` ma preserva `stableKey ?? id`; `GroupLayout` usa quella chiave React. In `split-reorg-budget`, il probe comincia dopo `goToApp`, dunque non misura il caricamento iniziale. Revisione indipendente read-only: nessun finding.
- Barra locale: `bun run typecheck` exit 0; `bun run typecheck:e2e` exit 0; `bun run lint` exit 0, 0 errori e 4 warning in file non toccati.

### Trovato e non fatto

- `right-click-menus.spec.ts:333` semina `files:rclick` e `task-model-labels.spec.ts:90` semina `kanban:leftover-from-a-previous-run`; nessuna delle due cerca la pane per quell'id, quindi non spiega i rossi indicati e resta invariata.
- Le tre spec e2e non sono state eseguite in locale per il divieto esplicito. Serve il job e2e della CI per provarle; nessun test unitario è stato modificato.

### Rifiutato

- `preview-guard-headers.spec.ts:30`: rosso singolo che passa al retry, escluso da questo giro come indicato nel brief.
