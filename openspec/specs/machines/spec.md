## Purpose

Le macchine che partecipano a un'installazione: come si registrano, come si
rinominano, e cosa succede a ciò che le nominava quando spariscono.

## Requirements

### Requirement: MACHINE-01 — Registrarsi è IDEMPOTENTE, e cancellare non porta via ciò che la nominava

La registrazione della macchina locale SHALL essere IDEMPOTENTE: il primo giro
inserisce, i successivi AGGIORNANO. Un solo record per macchina.

Una macchina SHALL potersi RINOMINARE.

Cancellare una macchina ancora NOMINATA da un discorso SHALL essere un CONFLITTO
dichiarato; una volta sciolto il legame SHALL riuscire, e il riferimento SHALL
diventare ASSENTE — mai puntare a una macchina che non c'è.

Le macchine ferme da più di una soglia SHALL passare a NON DISPONIBILI, e questa
SHALL essere la macchina REMOTA vecchia, non quella LOCALE che sta rispondendo
adesso.

#### Scenario: una macchina ancora nominata
- **GIVEN** un discorso legato a quella macchina
- **THEN** la cancellazione SHALL essere un conflitto dichiarato

#### Scenario: la macchina locale
- **GIVEN** la spazzata delle macchine ferme
- **THEN** quella locale NON SHALL passare a non disponibile
