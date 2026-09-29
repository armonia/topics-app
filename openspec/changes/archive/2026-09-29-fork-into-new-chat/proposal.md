## Da decidere

«Dirama in una nuova chat» e `/fork`: 4 scelte prima del codice.
1. Si dirama dall'ultima risposta finita: lì sta la voce, e da lì parte `/fork`. Perché: la CLI riprende esattamente a quel punto (misurato) e il ramo ha anche gli esiti degli strumenti (o: da qualunque risposta, e per le vecchie il ramo riceve un riassunto dal database, senza gli esiti degli strumenti).
2. Il ramo si apre in una tab nuova e prende il fuoco, per la stessa strada di ogni chat aperta da un'altra superficie. Perché: è uguale su desktop e telefono, e l'originale resta a un clic (o: affiancato all'originale in una divisione a destra, solo da desktop).
3. Il ramo lavora nella stessa cartella dell'originale (progetto e worktree), come `--fork-session` in Claude Code. Perché: non costa niente e vede i file com'erano (o: una worktree nuova a ogni ramo, così due chat che scrivono non si pestano; costa una worktree e un ramo git da chiudere ogni volta).
4. Durante un turno non si dirama: la voce non c'è e `/fork` risponde «Aspetta la fine del turno», come Rigenera. Perché: il ramo nasce sempre da una risposta finita (o: si dirama anche durante il turno, dall'ultima risposta finita, e il turno in corso resta fuori dal ramo).
Compreso, senza scelta: il ramo eredita fornitore, modello, effort, autonomia, progetto, prompt e file di contesto, non i messaggi fissati né l'obiettivo; copia il ramo attivo con strumenti e allegati; si chiama «<nome> (ramo)» e sotto la storia copiata dice «Diramata da <nome>»; `/fork <testo>` manda il testo come primo messaggio del ramo; Codex dirama con `codex exec fork`, il nativo e gli endpoint diretti leggono la storia copiata; openclaw e gli agenti ACP non offrono la voce; Modifica e Rigenera non cambiano. Se la chat ha una risposta rigenerata o modificata nel ramo visibile, o un turno tagliato in coda, il ramo Claude Code o Codex parte dal riassunto del database, perché la CLI ricorderebbe altro da ciò che la chat mostra.
Col sì: una tabella nuova (`chat_forks`, una migration) e, al primo avvio di un ramo Claude Code, la bandiera `--resume-session-at`, che `claude --help` non elenca (come già `--permission-prompt-tool`): entra nella tabella delle bandiere critiche. Costo: se una release la toglie, i rami ripartono dal riassunto del database, senza gli esiti degli strumenti, finché non si aggiorna il codice.
«ok» = tutte le consigliate · «ok ma 2 no» = cambio la 2.

| # | Dove cambiarla |
|---|----------------|
| 1 | `CHAT-FORK-01` (punto del ramo) e `CHAT-FORK-04` (dove sta la voce); design §2 |
| 2 | `CHAT-FORK-04` (apertura del ramo); design §9 |
| 3 | `CHAT-FORK-01` (eredità di `projectPath` e `worktreeId`); design §5 |
| 4 | `CHAT-FORK-01` (il 409) e `CHAT-FORK-04` (voce e risposta di `/fork`); design §3 |

---

# Dirama in una nuova chat

Card `a298eb7b`, dalla matrice dei gap rispetto a Claude Code e jcode (card
`e6b76521`, gap 6 «Diramare la conversazione», valore 4, sforzo M). Aperta su
decisione di Attilio del 28/09.

## Why

Oggi un ramo resta dentro la stessa chat, uno alla volta, e senza mani.

1. **Stessa chat, un ramo solo.** Modifica e Rigenera
   (`server/routes/edit.ts:233-335`) creano un fratello nello stesso thread; le
   frecce di CHAT-03 ne mostrano uno attivo alla volta. Due direzioni non
   corrono insieme.
2. **Senza strumenti.** `streamEditResponse` chiama `streamHTTP` o `complete`
   (`edit.ts:131-135`), che sono stateless, e la CLI in quel passaggio gira con
   `--tools ""` (`server/providers/claude/args.ts:399`). Il commento di
   `edit.ts:85-104` lo dice, e CHAT-CONV-04 esiste perché il 18/08 un ramo ha
   scritto le chiamate come testo con gli esiti inventati.
3. **La CLI lo sa fare, noi no.** `--fork-session` compare 0 volte in
   `server/`, `client/src` e `shared/` (grep del 28/09). La sessione di una chat
   si conia con `--session-id` o si riprende con `--resume`
   (`args.ts:372-374`), e basta.

## Misurato il 28/09

Sonde con `haiku` in una cartella di prova, CLI `claude` 2.1.283 e
`codex-cli` 0.153.4 (gli id stanno nello scratchpad della sessione, non nel
repo).

- `claude -p --resume A --fork-session --session-id B`: il ramo nasce con
  l'uuid scelto da noi e ricorda la storia di A. `--session-id` insieme a
  `--resume` la CLI lo accetta solo con `--fork-session` (il messaggio d'errore
  sta nel binario). Dopo due turni di B il transcript di A è identico byte per
  byte (`shasum -c`).
- A tenuta viva in `--input-format stream-json`, come la tiene il broker: il
  fork parte lo stesso, A continua a rispondere al turno dopo, e il ramo vede
  fino all'ultimo turno finito di A.
- `--resume-session-at <uuid>`, bandiera che `--help` non elenca: un ramo preso
  alla risposta «LIVE-ONE» non conosce il turno «LIVE-TWO» che A ha fatto dopo.
  Il punto del ramo si fissa, anche se l'originale va avanti.
- Rifare lo stesso fork su un B che esiste già: `Error: Session ID … is already
  in use.`, exit 1.
- Fork lanciato da un'altra cartella: funziona, e il transcript del ramo va
  sotto la cartella nuova (serve all'alternativa della scelta 3).
- CLI 2.1.284: lo stesso fork rifatto sullo stesso id da un'altra cartella esce
  0 e scrive un secondo transcript. Per questo il fork è legato all'uuid che la
  rotta conia, e una sessione del ramo dimenticata non lo rifà (design §4).
- CLI 2.1.284: `--resume-session-at` con un uuid che il transcript della madre
  non ha risponde «No message found with message.uuid of: <uuid>», exit 1, su
  stderr e nella riga `result`: un rifiuto che il recupero deve riconoscere.
- `codex exec fork <thread>`: thread nuovo annunciato da `thread.started`,
  storia portata, rollout della madre identico. Senza `-` come prompt non legge
  stdin: crea il thread, non fa nessun turno ed esce 0. `codex exec resume`
  invece legge stdin anche senza `-`.

## What changes

- **Una rotta.** `POST /api/topics/:id/fork` (`server/routes/fork.ts`, nuovo)
  crea in una transazione il topic del ramo con le impostazioni ereditate, la
  copia del ramo attivo fino all'ultima risposta finita e una riga in
  `chat_forks`. L'originale non si tocca.
- **Claude Code.** Il primo avvio del ramo passa
  `--resume <madre> --resume-session-at <punto> --fork-session --session-id <ramo>`;
  dal secondo `--resume <ramo>`, come ogni chat. Se la madre non c'è più il ramo
  riparte fresco col riepilogo del database (CCLI-06), una volta sola. Il fork
  avviene al più una volta: `/clear`, il reap della worktree o una sessione
  persa non lo rifanno.
- **Codex.** Il primo turno del ramo è `codex exec fork <thread madre> -`, poi
  `codex exec resume` come oggi: CODEX-02 modificato.
- **Nativo e fornitori con la storia dal database.** Nessuna bandiera: la
  storia copiata è la loro memoria.
- **Client.** La voce «Dirama in una nuova chat» nella barra del messaggio,
  `/fork [testo]` nel composer, il ramo aperto in una tab nuova, la riga
  «Diramata da <nome>» sotto la storia copiata.
- **Dati.** Tabella `chat_forks`, una migration.

## Relazione con chat-claude-code-parity

`openspec/changes/chat-claude-code-parity/` è la change ombrello «la chat
rimpiazza la CLI» (del 21/07, senza `.openspec.yaml`, 18 task chiusi su 49).
Non parla di diramare, e nessuno dei suoi requisiti (`CHAT-SLASH-01`,
`CHAT-PERM-01`, `CHAT-OOT-01`, `CHAT-PROC-01`, …) si sovrappone a questi.
Tocca però gli stessi due punti: il comando `/fork` entra nella tabella unica
dei comandi che `CHAT-SLASH-01` chiede (`slashCommands.ts`, con la guardia di
`slashCommandRouting.test.ts`), e il suo `/clear` è l'operazione speculare:
un id di sessione nuovo SENZA storia, dove il ramo è un id nuovo CON la storia.
Questa change resta autonoma: si può fare prima, dopo o senza quella.

## Non-goals

- Diramare da una risposta vecchia: è l'alternativa della scelta 1. Per Claude
  Code servirebbe l'uuid del transcript di quella risposta, che il database non
  conserva.
- Modifica e Rigenera non cambiano: restano rami nella stessa chat e senza
  strumenti (CHAT-CONV-01, CHAT-CONV-04).
- Niente albero dei rami in sidebar, niente unione di rami, niente domanda a
  lato mentre la chat lavora (è `/btw`, card 2 della matrice).
- openclaw e gli agenti ACP tengono una sessione loro fuori da Topics: il ramo
  partirebbe vuoto mostrando la storia. Restano fuori (CHAT-FORK-03).
- **Trovato strada facendo, fuori scope:** il «messaggio iniziale» di una chat
  nuova (TOPIC-IM-01) non parte mai. `NewTopicModal.tsx:184-192` lo scrive,
  `server/routes/topics.ts:1291-1297` lo salva, e nessun file di `client/src`
  lo legge per spedirlo, mentre il modale promette «queued and delivered as
  soon as the agent connects» (`NewTopicModal.tsx:448-449`). `/fork <testo>` non
  ci si appoggia (design §10); il difetto merita una card sua.
- **Trovato strada facendo, fuori scope:** `/clear` su una chat Codex svuota solo
  la tabella. `clearActionFor` (`server/routes/clearPolicy.ts`) risponde `none`
  perché il provider Codex non ha né `resetSession` né `sendToSession`, il
  thread resta in `codex_sessions` e il turno dopo fa `codex exec resume`: il
  modello ricorda la chat svuotata. Qui si copre solo il ramo prima del suo
  primo turno (design §4); il resto merita una card sua.

## Impact

Server: `server/routes/fork.ts` (nuovo, montato accanto a `createEditRouter`,
`server/routes/topics.ts:881`), `server/lib/chat-fork.ts` (nuovo, puro),
`server/providers/claude-code.ts` (spawn del ramo e recupero),
`server/providers/claude/args.ts`, `server/providers/claude/cli-compat.ts`,
`server/providers/codex.ts`, `server/providers/codex/args.ts`,
`server/utils.ts` (proiezione `forkedFrom`), `server/routes/topics.ts` (il
`/clear` stacca il ramo dalla madre), migration
`server/db/migrations/<timestamp>-chat-forks.sql` e il manifest
`server/db/migrations-embedded.ts`.
Shared: `shared/chat-fork.ts` (nuovo, la tabella dei runtime), `shared/types.ts`
(`Topic.forkedFrom`).
Client: `components/Chat/MessageBubble.tsx`, `MessageList.tsx`, `ChatPane.tsx`,
`slashCommands.ts`, `ForkOriginDivider.tsx` (nuovo), `lib/api.ts`, i18n it/en.
Test: vedi `tasks.md`.
