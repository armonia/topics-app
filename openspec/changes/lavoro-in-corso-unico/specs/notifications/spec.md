## ADDED Requirements

### Requirement: ATTN-17 — Un turno è di una card solo se lo manda la board

Misurato il 23/11: 10 chat su 11 col turno aperto non avevano nessuna riga nello stato di
attenzione. Il server si ricarica ogni pochi minuti e riadotta i turni vivi; la richiesta di
riattacco portava `dispatched: true` anche per le chat della persona, e la regola 2 di
`attention/compose.ts` («una card è il soggetto») le teneva `idle`: niente loader dal
server, una domanda senza ambra, la fine senza «finita».

`dispatched` SHALL viaggiare solo sui turni che il dispatcher della board manda o riadotta
per le sue card. Un turno riadottato al boot (`boot/reattach.ts`) e il turno con cui una card
sveglia la chat che l'ha mandata (`services/card-outcome-wake.ts`) NON SHALL portarlo: sono
turni di quella chat, e il suo stato SHALL essere `working` col turno aperto, `needs-you` su
una domanda, `finished` alla fine. La chat di una card resta della card comunque, perché la
rotta chiede anche `runningTaskOwnsTopic`. La riga con cui l'esito di una card sveglia la
chat SHALL restare segnata come non scritta dalla persona (`dispatched-envelope`, col segno
`cardOutcome` della richiesta) e NON SHALL chiudere le domande aperte della chat.

#### Scenario: un turno riadottato dopo un riavvio resta della chat
- **GIVEN** una chat della persona col turno aperto
- **WHEN** il server si ricarica e riadotta il turno
- **THEN** la richiesta di riattacco NON SHALL avere `dispatched`
- **AND** quella del dispatcher per una sua card SHALL averlo
  (`server/boot/headless-turns.reattach.test.ts`)

#### Scenario: l'esito di una card sveglia la chat come turno suo
- **WHEN** una card mandata da una chat arriva in review
- **THEN** la chat SHALL essere svegliata con `cardOutcome: true` e senza `dispatched`
- **AND** la riga SHALL avere il segno `dispatched-envelope`
  (`server/services/card-outcome-wake.test.ts`, `server/lib/user-row-marks.test.ts`)
