# Acceptance: lean-vs-claude-code

Barra eseguibile (esce non-zero se rossa):

    bun test server/providers/claude/args.test.ts server/routes/tasks.feed-etag.test.ts
    (cd client && bun test src/lib/board.feed-revalidation.test.ts src/hooks/useGlobalBoard.test.ts src/lib/coalesceFetch.test.ts)
    bun run check:identifier-language && bun run check:comment-language && bun run check:untraced-tests
    bun run typecheck:e2e
    gh workflow run clip-consegna.yml --ref perf/lean-vs-claude-code -f spec=tests/e2e/board-feed-reads.spec.ts -f grep=BOARD-21

## CCLI-13: un lavoro interno non paga il contesto dell'utente
- GIVEN un one-shot interno (titolo, giudice, scelta del modello)
- WHEN parte la CLI
- THEN `--settings` porta `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `outputStyle: default`
  e `disableAllHooks: true`, e `--setting-sources` resta `user,project,local`
- AND una risposta che l'utente legge (`userFacing`) porta solo `CLAUDE_CODE_DISABLE_AUTO_MEMORY`
- Misura (14/10, CLI 2.1.299): prefisso da 14.879 a 1.722 token, da $0,0596 a $0,0069 a chiamata

## KANBAN-98: il feed globale si rivalida invece di riscaricarsi
- GIVEN la board aperta e nessuna card che cambia
- WHEN il client rilegge il feed
- THEN la richiesta porta `If-None-Match`, il server risponde 304 senza corpo, il
  client riusa le righe dell'ultimo 200 (lo stesso array)
- AND la lettura d'avvio salva l'ETag senza mandarlo (passa dal coalescer condiviso),
  quindi la prima rilettura è già un 304
- AND l'ETag è leggibile da `tauri://localhost` (`Access-Control-Expose-Headers: ETag`)
- AND dopo un 304 una card nuova arriva e resta: BOARD-21, con il video

## Mutazioni sul punto critico (14/10, su copia nello scratchpad)
Ognuna fa diventare rosso il banco; il file vero non è mai stato toccato.

- Tolto `CLAUDE_CODE_DISABLE_CLAUDE_MDS` dal lavoro interno → args: 47 verdi, 2 rossi.
- Tolto `outputStyle: "default"` → 47 verdi, 2 rossi.
- Tolto `disableAllHooks: true` → 47 verdi, 2 rossi.
- Ogni one-shot trattato come `userFacing` → 47 verdi, 2 rossi.
- Server che non risponde mai 304 → feed-etag: 3 verdi, 1 rosso.
- Tolto `Access-Control-Expose-Headers` → feed-etag: 3 verdi, 1 rosso.
- Client che su 304 copia le righe invece di riusarle → revalidation: 2 verdi, 3 rossi.
- Lettura d'avvio rimessa sul ramo che non salva l'ETag → revalidation: 4 verdi, 1 rosso.
- Lettura d'avvio che manda l'ETag dal coalescer → revalidation: 5 verdi, 1 rosso. Il
  caso l'ha trovato la verifica avversaria: un 304 condiviso letto contro righe vecchie.
