# Notifications — una chat che ha finito

## ADDED Requirements

### Requirement: CHAT-DONE-01 — Una chat che ha finito resta segnata come un terminale che ha finito

Una chat il cui turno finisce pulito (`stream:end` che `isCleanChatTurnEnd`
accetta: `completed`, non `dispatched`, non annullato) SHALL accendere un segno
«finito», qualunque sia il runtime, con o senza hook Claude Code. Il segno SHALL
dipingersi sulla riga della sidebar e sulla tab con lo stesso tier `done`
(«turno finito») di un terminale che ha finito, e le due superfici SHALL
esporlo come `data-attention="done"`.

Il segno SHALL spegnersi quando la chat viene aperta (è la pane attiva col
fuoco), quando si clicca la sua riga (anche se la chat la tiene un'altra
finestra, dove il clic porta avanti quella finestra) o quando comincia un nuovo turno (`stream:start`). Se la chat è già
davanti quando il turno finisce, il segno NON SHALL restare acceso. Come quello
dei terminali, vive in memoria: un ricarico della pagina riparte senza.

#### Scenario: chat senza hook che finisce dietro un'altra tab
- **GIVEN** una chat senza hook aperta in una tab, e un'altra tab attiva
- **WHEN** il suo turno finisce pulito
- **THEN** la sua tab e la sua riga SHALL avere `data-attention="done"`

#### Scenario: aprire la chat spegne il segno
- **WHEN** la tab della chat segnata viene attivata
- **THEN** tab e riga NON SHALL avere più `data-attention`

#### Scenario: la riga di una chat tenuta da un'altra finestra si spegne al clic
- **GIVEN** una chat tenuta da un'altra finestra, segnata `done` sulla riga di questa
- **WHEN** si clicca la sua riga, che porta avanti l'altra finestra senza aprire niente qui
- **THEN** la riga NON SHALL avere più `data-attention`

#### Scenario: una chat con gli hook non perde il segno dopo 15 minuti
- **GIVEN** una chat con hook finita e mai aperta
- **WHEN** la fase passa da `awaiting-user` a `completed`
- **THEN** il segno SHALL restare finché la chat non viene aperta

#### Scenario: un turno fermato non è un turno finito
- **WHEN** arriva `stream:end` con `reason: user_abort` o `dispatched: true`
- **THEN** NON SHALL accendersi nessun segno

### Requirement: CHAT-DONE-02 — Una chat che ha finito suona una volta, qualunque runtime e quante che siano le finestre

Un `stream:end` pulito SHALL alzare un banner di sistema anche per una chat senza
hook e con la finestra visibile dietro un'altra app, con gli stessi cancelli
degli altri percorsi (interruttore, silenzio, archiviata, agente di board, chat
davanti con la finestra a fuoco). Il banner SHALL claimare la stessa chiave del
banner di `message:new` per la risposta dello stesso turno (il suo `messageId`),
così due finestre, una nascosta e una visibile, alzano UN banner.

#### Scenario: due finestre, un banner
- **GIVEN** la finestra B nascosta e la finestra A visibile dietro un'altra app
- **WHEN** B claima il banner su `message:new` e A su `stream:end` dello stesso turno
- **THEN** solo una delle due SHALL consegnarlo

#### Scenario: i turni che non sono una fine non suonano
- **WHEN** un'altra chat riceve `stream:end` con `dispatched: true` o `reason: user_abort`
- **THEN** NON SHALL alzarsi un banner per quella chat
