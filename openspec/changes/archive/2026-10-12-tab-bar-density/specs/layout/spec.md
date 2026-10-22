## ADDED Requirements

### Requirement: LAYOUT-42 — La barra delle tab si stringe prima di scorrere

La larghezza di una tab SHALL dipendere dallo spazio della sua barra, e la barra
NON SHALL scorrere di lato finché le tab ci possono stare strette. Tre densità,
ricalcolate solo quando cambiano lo spazio o il numero di tab, mai al passaggio
del puntatore: piena (150 / 200 / 300 px come prima), compatta (fino a 76 px,
la attiva mai sotto 120), quadratino (le non attive alte quanto larghe, con
l'icona o l'iniziale della chat sul suo colore e il segnale di attenzione
sull'angolo; la attiva almeno 96 px col nome). Una tab sola NON SHALL mai
scorrere. Chiusa una tab col puntatore nella barra, le altre SHALL restare ferme
finché il puntatore non esce. Il nome intero SHALL stare nel tooltip e
nell'`aria-label` di ogni tab.

#### Scenario: un gruppo stretto mostra tutte le sue tab

- **GIVEN** un gruppo con sei tab largo 340 px
- **WHEN** la barra si ridisegna
- **THEN** le tab non attive sono quadrati con un'icona o un'iniziale, la attiva
  è larga almeno 96 px col nome visibile, e la barra non scorre
