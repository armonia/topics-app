# Topics: il colore scelto si vede

## ADDED Requirements

### Requirement: TOPIC-COLOR-01 — Il colore scelto per una chat si vede sulla riga e sulla tab

Un colore scelto con «Cambia colore» o nelle impostazioni della chat SHALL vedersi
come un segno colorato prima del nome sulla riga della chat nella colonna e sulla
sua tab. Il colore che una chat ha senza che nessuno l'abbia scelto (il default
salvato alla creazione o dalla colonna del database) NON SHALL dipingersi, così la
colonna di chi non ha mai scelto un colore non cambia. È il «visual color indicator»
che TOPIC-02 chiede già.

#### Scenario: scegliere un colore
- **GIVEN** una chat senza colore scelto
- **THEN** la sua riga e la sua tab non hanno il segno colorato
- **WHEN** scelgo un colore con «Cambia colore»
- **THEN** la riga e la tab hanno il segno di quel colore
- **AND** dopo un ricarico il segno c'è ancora
