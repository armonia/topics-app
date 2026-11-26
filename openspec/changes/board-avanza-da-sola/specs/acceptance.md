# Barra eseguibile

Ogni comando esce non-zero se la regola non regge. Un test alla volta, in locale solo questi.

| Traccia | Comando |
|---|---|
| T1 auto-land | `bun test ./server/services/auto-land.test.ts` |
| T2 card senza foto | `bun test ./server/services/tasks.system-delivery.test.ts` |
| T3 niente doppioni | `bun test ./server/routes/tasks.dedupe.test.ts` |
| T4 sblocco | `bun test ./server/services/stuck-card.test.ts` |
| T5 giri a vuoto | `bun test ./server/services/task-dispatcher.test.ts -t "giri a vuoto"` |
| T6 canale giusto | `bun test ./server/services/card-outcome-wake.test.ts` |
| T7 riavvii | `bun test ./server/services/auto-land.test.ts ./server/lib/quiescence.test.ts` |

## Scenari
- **T3**: stesso titolo (maiuscole e spazi diversi) su una card aperta, 200 `deduped:true` e un solo commento di servizio anche se la chiamata si ripete; titolo solo simile, 409; card done o archiviata, nessun assorbimento; `allow_duplicate: true`, nuova card; altra board, nuova card; coordinatore e agente di sessione passano dallo stesso helper.
- **T4**: sotto i 60 minuti nulla; con un motivo già sulla card nulla; macchina piena, nota con i posti; macchina muta, card rimessa in coda lontano da quella macchina; due passaggi, una nota sola; rimessa in coda fallita, nessuna nota e nuovo tentativo al giro dopo.
- **T5**: tre tentativi spesi, card in todo con chip `failed` e testo «3 tentativi senza esito», due giri del tick, una nota sola, nessun turno lanciato.
- **T6**: review con domanda, il messaggio di risveglio della chat di origine contiene la domanda; done o review senza domanda, nessuna riga; domanda lunga tagliata e non può chiudere il tag.

## Mutazioni (verificate a mano)
T3 a T6 verificate a mano in questa tornata (tolta la cura il test è rosso, ripristinata verde); T1 e T2 erano già committate, la loro mutazione è solo suggerita in `tasks.md`; T7 senza codice.

## Resta verde
`bun run typecheck`, `bun run lint`, `bun run check:deadcode`, `bun run check:emdash`, `bun run check:comment-language`, `bun run check:identifier-language`, `bun run test:touched`.
