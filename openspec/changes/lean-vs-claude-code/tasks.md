# Tracce: lean-vs-claude-code

- T1 one-shot magri (CCLI-13). Barra: `bun test server/providers/claude/args.test.ts`.
- T2 feed rivalidato (KANBAN-98): ETag e 304 sul server, client che rimanda l'ETag
  anche all'avvio, esposizione CORS per `tauri://localhost`. Barra:
  `bun test server/routes/tasks.feed-etag.test.ts` e
  `(cd client && bun test src/lib/board.feed-revalidation.test.ts)`.
- T3 scenario BOARD-21 con video (dipende da T2). Barra: `clip-consegna.yml` verde
  con il `.webm`. Scritto e tipizzato; gira solo dopo il push (repo pubblico).
- T4 parità con la CLI 2.1.299. Barra: un turno vero in stream-json classificato
  con `classifyStreamLine` dà 0 eventi `unknown` (14/10: noise 3, partial 29,
  content 3, rate_limit 1, result 1).
- T5 misura dopo il deploy (dipende dal land). Barra: nel log del server le letture
  del feed da ~155 KB scendono a una per cambio; G3 di `topics-bar` verde quando i
  transcript vecchi escono dalla finestra di 14 giorni.
