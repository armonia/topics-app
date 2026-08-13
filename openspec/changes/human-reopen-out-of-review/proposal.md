# Proposal — human-reopen-out-of-review

## Why

Il 13/08 alle 09:05:50 il sistema ha chiuso la card `d6baaf5e` con la frase «il
lavoro consegnato (`f123bccc`) è già dentro main: niente da rifare». `f123bccc`
era la consegna di CINQUE GIORNI prima. Sei secondi prima quella card era
tornata in `todo`, e quattordici ore prima Attilio aveva scritto «mah l'amicizia
non serve al momento, più la parte di organizzazione e profili» e trascinato la
card da `review` a `in corso`. La richiesta è finita archiviata dentro una card
`done`.

**La guardia c'era, e guardava la porta sbagliata.** La chiusura automatica
(`task-dispatcher.ts`) si ferma davanti a `reopenedActor === "human"`, con il
commento giusto accanto: «chi riapre una card atterrata sta chiedendo un
SEGUITO». Ma quel campo lo scrive un solo ramo (`tasks.ts`, `else if (current
=== "done")`): si accende uscendo da `done`, e da nessun altro posto. Attilio è
passato da `review` a `in corso`. Per il campo, nessuno aveva mai riaperto
niente.

Il segnale dipendeva da quale casella aveva attraversato il dito.

**La metà sulla consegna vecchia è già riparata.** `a945baa3` (12/08 22:23,
quattro ore DOPO quel trascinamento) azzera `delivery_branch` /
`delivery_commit` / `landing_state` anche uscendo da `review`: oggi lo stesso
trascinamento porterebbe via con sé lo scatto della consegna, e la chiusura non
avrebbe più il commit da guardare. Resta scoperto il segnale di riapertura, che
è quello che protegge le card DOPO una riconsegna.

**E c'è una quarta porta che nessuno aveva contato:** il rifiuto in review
(`reviewDecision`, decisione `reject`) scrive lo status a SQL grezzo. Non lascia
il segno della riapertura *e* non azzera la consegna: una card rifiutata da una
persona resta con `delivery_commit` pieno e senza marchio, cioè esattamente
nella condizione che ha chiuso `d6baaf5e`, in attesa di rientrare in `todo` (per
esempio come orfana rilasciata).

**Raggio misurato** sul DB vivo il 13/08: 3 card chiuse in tutto dalla chiusura
automatica, di cui **1 sola** con un commento umano nelle 24 ore prima
(`d6baaf5e`, già riparata a mano). Non è un incendio: è una guardia che copre
una porta su quattro.

## What

Una regola sola, al posto di quattro rami che si contraddicono: **una card che
esce da `review` o da `done` verso la coda è RIAPERTA, e chi l'ha tirata fuori
resta scritto sulla card.** Non conta la colonna d'arrivo, non conta la porta di
codice.

- `update()` marca la riapertura anche quando si parte da `review`, non solo da
  `done` (copre `review → in_progress`, `review → todo`, `review → backlog`).
- `markReopened()` — la funzione delle porte che scrivono a SQL grezzo — accetta
  `review` come stato di partenza allo stesso titolo di `done`.
- Il rifiuto in review lascia il marchio (`human`) **e** azzera lo scatto della
  consegna, come già fa `update()` per lo stesso salto.
- Il chip «riaperta» smette di dire «Era in Done»: adesso può venire anche da
  review, e il tooltip lo dice.

## Non-goals

- La chiusura automatica non cambia: la sua guardia è già quella giusta, le
  arrivava solo un campo spento.
- Nessuna migrazione retroattiva: le card già chiuse non si riaprono da sole (la
  sola colpita è già stata riparata a mano).
- Il rifiuto in review continua a mandare la card in `in_progress` e a essere
  ripreso dal dispatcher: qui cambia solo ciò che resta scritto sulla card.
