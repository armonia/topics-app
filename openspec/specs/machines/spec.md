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

### Requirement: CORES-01 — Una macchina non perde core perché una lettura è vuota

Il numero di core SHALL essere ALMENO uno, e SHALL essere quello VERO quando la
piattaforma sa dichiararlo.

**Una lettura VUOTA NON SHALL rimpicciolire la macchina.** È il difetto: un
ripiego che scatta su un'assenza di risposta trasforma una macchina da venti core
in una da uno, e ogni tetto che si dimensiona su quel numero si stringe insieme a
lui.

#### Scenario: una lettura vuota
- **GIVEN** la piattaforma non risponde
- **THEN** il numero NON SHALL scendere sotto quello reale già noto

#### Scenario: una piattaforma che dichiara i core
- **GIVEN** una risposta valida
- **THEN** SHALL essere quel numero
