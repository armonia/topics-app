# Proposal — board-comments-answer-first

## Da decidere

Misurato il 15/09 su 2.486 commenti di agenti (45 giorni, `data/topics.db`): delle 91 domande, 78
usano già il blocco ` ```question ` con le opzioni e 1 sola è sepolta a metà testo. Il problema
«domanda persa» non c'è. C'è l'altro: **solo 13 blocchi su 78 hanno un'opzione consigliata (17%)**.

1. Regola nel kickoff: ogni blocco ` ```question ` mette per prima l'opzione consigliata, marcata «(consigliata)», con una riga sul perché (consigliata) (o: niente)
2. Niente regola «esito in prima riga / domanda in fondo»: i dati non la giustificano (consigliata)
3. Stile ereditato da settings.json per le sessioni Claude della board, zero codice (consigliata)

ok / ok ma 1 no

## Why

Il 15/09/2026 attention-span è installato su tutti gli harness (Claude Code come output style di
default, Codex nel blocco di `~/.codex/AGENTS.md`, skill nell'hub `~/.agents/skills`). Le sessioni
Topics lo prendono già: Claude perché `server/providers/claude/args.ts` passa
`--setting-sources user,project,local`, Codex perché legge `~/.codex/AGENTS.md`.

Uno stile di output governa però le RISPOSTE in chat, non il testo che l'agente passa a
`comment_task`: il thread di una card si scrive dentro un argomento di tool. L'unica istruzione che
l'agente legge su come scriverlo è una riga del kickoff (`server/services/task-dispatcher.ts`,
«Comments SHORT and useful: 1-2 sentences»), che dice quanto ma non come. Il sintomo tipico: la
domanda che aspetta l'umano sta a metà commento, e lo stato `needs_input` la mostra senza che
l'occhio la trovi.

## What changes

- Nasce `RECOMMENDED_OPTION_RULE` in `shared/board.ts`, accanto a `PREVIEW_RULE`,
  `CODE_GATES_RULE` e `VERSION_BUMP_RULE`: una costante sola, interpolata da `buildKickoff`
  (`server/services/task-dispatcher.ts`, sotto «If you need a human decision to go on») e dalla
  descrizione di `options` in `comment_task` e `comment_global_task`
  (`server/mcp/topics-mcp-server.ts`). Dice: l'opzione che sceglieresti e' il PRIMO elemento di
  `options`, l'etichetta finisce con « (consigliata)» / « (recommended)», il perche' sta nella
  stessa riga della domanda, e se davvero non hai una preferenza lo dichiari.
- La stessa costante porta la DEROGA sulle etichette riservate («Landa su main», «Approva il
  piano», «Da rivedere», le quattro dei sottotask parcheggiati): quelle il server le confronta
  per valore, quindi si offrono verbatim e la propria scelta si dice con l'ORDINE. Senza, una
  consegna marcata smette di essere un'azione di board e un piano marcato non arma
  `tasks.plan_comment_id`.
- **Nessun cambio alla riga «Comments SHORT and useful»** del kickoff, nessuno a
  `topicsAgentSystemPrompt`, a `server/providers/claude/args.ts` ne' al limite di lunghezza dei
  commenti: la scelta 2 ha respinto la regola «esito in prima riga / domanda in fondo» e il
  codice non la implementa.
- `docs/board-protocol.md` (copia canonica per gli umani) guadagna la regola 5-bis e la quarta
  costante nell'elenco in testa; `server/services/board-protocol-parity.test.ts` la ancora
  all'envelope, e conta anche le regole `N-bis` — prima ne leggeva solo le cifre nude e una
  5-bis passava sotto il cancello senza accenderlo.

## Dove cambiarla

| Scelta | Requisito |
|---|---|
| 1 | `RECOMMENDED_OPTION_RULE` in `shared/board.ts`; interpolata in `buildKickoff` (`server/services/task-dispatcher.ts`) e nelle descrizioni di `options` in `server/mcp/topics-mcp-server.ts` |
| 2 | riga «Comments SHORT and useful» in `buildKickoff`: resta invariata, e' la scelta |
| 3 | `server/providers/claude/args.ts`: nessuna modifica, `--setting-sources user,project,local` passa gia' lo stile |
