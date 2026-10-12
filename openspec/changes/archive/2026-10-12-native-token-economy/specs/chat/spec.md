## ADDED Requirements

### Requirement: CHAT-COMPACT-05 — La compattazione compra margine, non pochi giri

Sul motore nativo una compattazione SHALL riportare la conversazione abbastanza
sotto la soglia da durare: ogni compattazione cambia il prefisso della richiesta e
fa riscrivere in cache l'intera storia, quindi compattare spesso costa più di
compattare di più. La soglia SHALL essere 0,85 della finestra quando la stima è
calibrata sui conteggi dell'API e 0,75 finché non lo è; l'obiettivo SHALL essere
0,40. Ogni giro SHALL lasciare una riga di log con la chat, i token in ingresso,
letti e scritti in cache, in uscita, e se ha compattato.

#### Scenario: una sessione lunga compatta meno e riscrive meno

- **GIVEN** una storia che cresce di 8k token a giro per 120 giri su 200k
- **WHEN** si confrontano le costanti nuove con 0,75 / 0,55
- **THEN** le compattazioni sono al massimo la metà e i token riscritti in cache
  almeno il 40% in meno
