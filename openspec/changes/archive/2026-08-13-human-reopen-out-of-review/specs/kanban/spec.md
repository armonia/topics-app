## ADDED Requirements

### Requirement: KANBAN-11 — Uscire da review o da done è una riapertura, da qualunque porta

Quando una card lascia `review` o `done` verso uno stato di lavoro o di coda
(`todo`, `in_progress`, `backlog`), il sistema SHALL registrare sulla card CHI
l'ha tirata fuori (`reopened_at`, `reopened_by`, `reopened_actor`), con lo stesso
esito qualunque sia la colonna d'arrivo e qualunque sia la porta di codice
attraversata: il trascinamento sulla board, il rifiuto in review, il rilascio di
un orfano, il ritiro di un land fallito.

`reopened_actor` SHALL valere `human` quando la transizione porta la firma di una
persona, `system` quando la firma è del sistema o del dispatcher anche se il
permesso viaggia come umano, `agent` quando è un agente a rimettersi al lavoro.
La firma (`reopened_by`) e l'attore (`reopened_actor`) SHALL restare due assi
distinti: il permesso non è l'attribuzione.

Una card che RIENTRA in `review` o in `done` NON SHALL essere segnata come
riaperta: il ciclo si è chiuso, e il segno cade.

Una card che una PERSONA porta fuori da `review` o da `done` verso la coda SHALL
perdere lo scatto della consegna (`delivery_branch`, `delivery_commit`,
`landing_state`, `landing_checked_at`, `landing_witnessed`), incluso il rifiuto
in review che scrive lo status a SQL grezzo: quel lavoro non è più ciò che la
card sta chiedendo. Un rientro in coda deciso dalla MACCHINA (rilascio di un
orfano, attesa scaduta) SHALL invece conservarlo, perché è proprio lì che la
chiusura automatica deve poter riconoscere il lavoro già atterrato.

La chiusura automatica del dispatcher («il lavoro consegnato è già dentro main:
niente da rifare») SHALL continuare a fermarsi davanti a `reopened_actor ===
"human"`, e per effetto di questo requisito SHALL fermarsi su tutte e quattro le
uscite umane, non solo su `done → todo`.

#### Scenario: trascinare da review a in corso
- **GIVEN** una card in `review` con una consegna registrata (`delivery_commit` pieno)
- **WHEN** una persona la trascina in `in corso`
- **THEN** la card porta `reopened_actor = human` con la firma di quella persona, e `delivery_commit` è vuoto

#### Scenario: trascinare da review a todo
- **GIVEN** una card in `review` con una consegna registrata
- **WHEN** una persona la rimette in `todo`
- **THEN** la card porta `reopened_actor = human`, e la chiusura automatica del dispatcher non la chiude nemmeno se quel commit è dentro main

#### Scenario: il rifiuto in review lascia lo stesso segno
- **GIVEN** una card in `review` con una consegna registrata
- **WHEN** una persona la rifiuta dal pannello di review
- **THEN** la card torna in `in corso` con `reopened_actor = human` e senza scatto della consegna

#### Scenario: riaperta da done
- **GIVEN** una card in `done` chiusa da una persona
- **WHEN** quella persona la rimette in `todo`
- **THEN** `done_actor` si spegne, `reopened_actor` vale `human`, e la consegna registrata è azzerata

#### Scenario: la macchina non lascia il marchio dell'umano
- **GIVEN** una card in `review` il cui land è fallito, ritirata dal sistema con permesso umano
- **WHEN** la card torna in `in corso`
- **THEN** `reopened_actor` vale `system`, non `human`, e la chiusura automatica resta libera di agire

#### Scenario: tornare in review non è una riapertura
- **GIVEN** una card riaperta e poi riconsegnata
- **WHEN** la card rientra in `review` o viene approvata in `done`
- **THEN** il segno di riapertura è caduto e la card non mostra più il chip
