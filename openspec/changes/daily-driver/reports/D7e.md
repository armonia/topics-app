# D7e — identità delle viste singleton di progetto

**Barra prima:** mutazione UUID nella copia scratchpad, 4/4 test identità rossi, exit 1.
**Barra dopo:** `bun test ...projectPaneIdentity.test.ts ...useProjectLayout.closeIndex.test.tsx ...useProjectChatSync.test.tsx`, 16 pass / 0 fail, exit 0; `./scripts/qa-gate.sh --veloce`, typecheck, lint e tutti i `check:*` verdi, 0 rossi.

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
