# Proposal: chat-strips-in-transcript

## Why

Attilio, 08/10 ~02:20, guardando la chat Prince of Persia: «si apre un nuovo accordion sopra invece
di sfruttare quello già dell'agente. inoltre il goal e tutte le cose sopra l'input in realtà
dovrebbero restare a fondo chat, meglio.»

Poi, nel pomeriggio, con la riga che portava alla card d'origine: «i server si stanno aprendo dove
si sono aperti. In realtà si devono aprire direttamente dal pannellino a fondo chat, ad
accordion». Per un server partito il 07/10 quella card sta in cima alla storia.

Sul codice:

- Il clic su una riga comando della striscia (`SubAgentsStrip.tsx`) apriva un secondo log
  (`ProcessLogPane`) agganciato sopra le righe. Il trascritto ha già la card della tool call
  `run_command` che ha lanciato quel comando, ma la card mostrava solo la risposta
  («started · processId=…»), non il log.
- GoalBar/TodoStrip, SubAgentsStrip, CheckpointTimeline e ChangedFilesStrip stavano nel blocco
  agganciato sopra l'input (`ChatPane.tsx`), fuori dal trascritto.

## What Changes

1. **Una riga comando apre il suo log lì, ad accordion.** Il clic apre sopra la riga, dentro la
   striscia, la coda dal vivo del processo con lo stesso componente e lo stesso stato della card
   del `run_command` (`ProcessTail` → `LiveShellTail`, `useLaunchedProcess`, dal registro dei
   processi), e la riga tiene Apri e Ferma. Un secondo clic la chiude; se ne apre una alla volta.
   La trascrizione non va più alla card d'origine, che resta chiusa; la card nel trascritto
   continua a mostrare lo stesso log dal vivo.
2. **Le strisce sono la fine del trascritto.** Goal o todo, lavoro vivo, checkpoint e file
   modificati stanno dentro lo scroll dopo l'ultimo messaggio, sulla colonna del composer. Sopra
   l'input restano solo le cose dell'invio: PlanApprovalBar, SwapFreezeLabel, UnsentStrip,
   CommandAnswerCard. Chi è in fondo ci resta quando le strisce cambiano; chi legge più su non si
   muove.

## Barra

`specs/acceptance.md`: unit test, due scenari Playwright filmati su WebKit (`--repeat-each=3`) e
Chromium contro il server isolato :13334, la mutazione che rimette il salto alla card d'origine
fa fallire lo scenario 2, e le spec che toccano queste strisce restano verdi.

## Fuori

Le righe dei sotto-agenti · il layout mobile, oltre a non romperlo · il server (nessun file sotto
`server/` e `shared/`) · la board.

## Deciso da me

- Le righe dei sotto-agenti restano come sono: aprono la chat del figlio o il suo terminale, che
  è il loro «accordion». La card `spawn_agent` nel trascritto ha solo il prompt.
- La card di un `run_command` (e di un `run_script`) mostra il log dal vivo, stesso registro e
  stesso polling della shell in background, e la riga della striscia ne apre la stessa coda.
- Il log si apre SOPRA la riga, come la lista del todo e i checkpoint (`DockedStripPanel`): la riga
  resta sotto il puntatore e la trascrizione sopra sale dell'altezza del log. Aperto sotto, in
  fondo al trascritto, finirebbe sotto il composer. Per questo `scrollTop` non resta fermo: cresce
  esattamente quanto la striscia, e lo scenario 2 misura quello, con la riga ferma entro 1 px e
  chi è in fondo ancora in fondo.
- Un comando che finisce col log aperto tiene la sua riga, al suo posto (i comandi sono in ordine
  di avvio) e senza Apri e Ferma, finché non lo chiudi: la sua fine è ciò che lo avevi aperto a
  leggere, come col log agganciato di prima. Ferma sulla riga aperta chiude il log, così la riga
  se ne va come prima.
- Le righe non hanno più un tetto. Sopra il composer si fermavano a 7,5 rem e scorrevano dentro;
  nel trascritto la striscia scorre con la chat, e il tetto era uno scroll dentro lo scroll.
  Tolto per aprire un log, mostrava le righe che nascondeva sotto quella cliccata: sulla chat
  Prince of Persia (08/10, sei comandi) chi era in fondo finiva 27 px sopra, e la chat smetteva
  di seguire i messaggi nuovi. Per questo lo scenario 2 ha sei comandi.
- Nessun log agganciato per i comandi senza card: ogni riga comando ha lo stesso accordion.
- La presa di un toggle (`useDisclosureAnchor`) finisce quando la riga è ferma entro il pixel, non
  entro il mezzo: lo scroll si muove a pixel interi, la riga sotto un log di 321,5 px restava a
  0,5 px per sempre, e ogni clic sulla striscia fermava i pin per 3 s, fino al tetto. E un pin che
  la presa ha respinto si recupera quando lei finisce (`MessageList`), chiedendo all'autorità come
  ogni pin: una riga arrivata in quei 3 s restava 24 px sotto chi era in fondo (Chromium, 2 volte
  su 6). Chi apre una piega sotto la sua testata resta padrone della vista come prima.
- Tolti `revealToolCall`, il fuoco `reveal` della ricerca, il suo effetto in `ToolCallRow` e
  `findLaunchCard`: senza il salto non li usa nessuno. `liveWorkCard.ts` diventa
  `launchedProcess.ts`, con il solo `launchedProcessId`.
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
