# Proposal: chat-strips-in-transcript

## Why

Attilio, 08/10 ~02:20, guardando la chat Prince of Persia: «si apre un nuovo accordion sopra invece
di sfruttare quello già dell'agente. inoltre il goal e tutte le cose sopra l'input in realtà
dovrebbero restare a fondo chat, meglio.»

Sul codice:

- Il clic su una riga comando della striscia (`SubAgentsStrip.tsx`) apriva un secondo log
  (`ProcessLogPane`) agganciato sopra le righe. Il trascritto ha già la card della tool call
  `run_command` che ha lanciato quel comando, ma la card mostrava solo la risposta
  («started · processId=…»), non il log.
- GoalBar/TodoStrip, SubAgentsStrip, CheckpointTimeline e ChangedFilesStrip stavano nel blocco
  agganciato sopra l'input (`ChatPane.tsx`), fuori dal trascritto.

## What Changes

1. **Una riga comando apre la card che l'ha lanciato.** La card si trova nei messaggi della chat:
   per il processId scritto nella risposta, e sulla storia (che arriva senza risposta) per
   comando e ora di avvio. Si apre con il meccanismo della ricerca (CHAT-FIND-02: turno, gruppo,
   riga) e scorre in vista sotto la barra delle tab. La card di un `run_command` mostra il log dal
   vivo del processo, dal registro dei processi. Se la card non c'è (comando lanciato da un'altra
   sessione o dalla sola route, storia non caricata) resta il log agganciato di oggi.
2. **Le strisce sono la fine del trascritto.** Goal o todo, lavoro vivo, checkpoint e file
   modificati stanno dentro lo scroll dopo l'ultimo messaggio, sulla colonna del composer. Sopra
   l'input restano solo le cose dell'invio: PlanApprovalBar, SwapFreezeLabel, UnsentStrip,
   CommandAnswerCard. Chi è in fondo ci resta quando le strisce cambiano; chi legge più su non si
   muove.

## Barra

`specs/acceptance.md`: unit test, due scenari Playwright filmati su WebKit contro il server
isolato :13334, una mutazione su una copia in scratch che li fa fallire, e le spec che toccano
queste strisce restano verdi.

## Fuori

Le righe dei sotto-agenti · il layout mobile, oltre a non romperlo · il server (nessun file sotto
`server/` e `shared/`) · la board.

## Deciso da me

- Le righe dei sotto-agenti restano come sono: aprono la chat del figlio o il suo terminale, che
  è il loro «accordion». La card `spawn_agent` nel trascritto ha solo il prompt.
- La card di un `run_command` (e di un `run_script`) mostra il log dal vivo, stesso registro e
  stesso polling della shell in background: senza, portare lì il clic avrebbe tolto il log che il
  pannello mostrava.
- Finché la chat non ha messaggi (vuota col composer al centro, o con la storia ancora in arrivo)
  le strisce restano nel blocco del composer: non c'è un trascritto che le contenga. Al primo
  messaggio passano in fondo al trascritto.
- Nessun pin nuovo per il fondo: la crescita delle strisce passa da `totalListHeightChanged` come
  quella di una riga, ed è misurata nello scenario 1.
- Il Footer di Virtuoso è un componente stabile che legge un context: costruito in un `useMemo`
  rimontava a ogni inizio e fine turno, e con lui le strisce (un pannello aperto, un goal in
  modifica).
- `aboveInputSlot` di ChatPane tolto: nessuno lo passava.
- Il caso «in mezzo» di CHAT-FOLD-01 non vale più per le strisce: due schermate più su non sono
  sullo schermo. Resta il caso in fondo.
