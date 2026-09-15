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

- La riga dei commenti nel kickoff diventa: prima riga = l'esito o il blocco; una cosa per riga;
  una domanda che ti ferma va per ultima, con le opzioni e la consigliata in cima; niente log.
- Nessun cambio a `topicsAgentSystemPrompt`, a `args.ts` né al limite di lunghezza dei commenti.

## Dove cambiarla

| Scelta | Requisito |
|---|---|
| 1 | `server/providers/claude/args.ts` (nessuna modifica se consigliata) |
| 2, 3 | riga «Comments SHORT» in `buildKickoff`, `server/services/task-dispatcher.ts` |
| 4 | idem, blocco di consegna |
