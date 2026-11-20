# Delta: profile — la rubrica guadagna una terza fonte

## MODIFIED Requirements

### Requirement: PROFILE-04 — La rubrica non è l'elenco di tutti

L'elenco delle persone SHALL contenere SOLO chi condivide un'organizzazione con
chi guarda, più chi lo segue, chi è seguito da lui, e i suoi AMICI. NON SHALL mai
essere la tabella intera.

L'amicizia SHALL essere la TERZA fonte dell'insieme raggiungibile, accanto
all'organizzazione e al legame di «seguo», e SHALL bastare da sola: due persone
amiche SHALL vedersi anche senza nessuna organizzazione in comune e senza che
nessuna delle due segua l'altra.

Le tre fonti NON SHALL essere distinguibili da fuori. Questa interfaccia NON
SHALL dire per quale delle tre una persona è raggiungibile: il motivo per cui una
faccia compare su uno schermo non è un dato di quella persona.

Un legame di «seguo» SHALL rendere raggiungibile un profilo anche senza
organizzazione in comune, nelle DUE direzioni. Il legame SHALL essere
ASIMMETRICO: seguire qualcuno non fa risultare che quel qualcuno segua te.
L'amicizia SHALL invece essere MUTUA, e NON SHALL creare un legame di «seguo».

Il conteggio di chi segue SHALL essere calcolato PER CHI GUARDA, non letto grezzo
dalla tabella: un numero che comprende persone che il lettore non può vedere è un
numero che non corrisponde all'elenco sotto. La stessa regola SHALL valere per il
conteggio degli amici.

Seguire sé stessi SHALL essere rifiutato ESPLICITAMENTE, non ignorato in
silenzio. Lo stesso SHALL valere per un invito di amicizia rivolto a sé stessi.

L'elenco delle persone NON SHALL toccare la rete: un profilo agganciato a un
servizio esterno senza dati in cache SHALL comunque comparire, senza nessuna
chiamata in uscita. Un amico su un'altra installazione SHALL comparire dalla
propria copia in cache, anche quando quell'installazione è spenta.

#### Scenario: nessuna organizzazione in comune, un legame sì
- **GIVEN** due persone senza organizzazioni condivise, una segue l'altra
- **THEN** entrambe SHALL comparire nella rubrica dell'altra

#### Scenario: nessuna organizzazione, nessun follow, un'amicizia
- **GIVEN** due persone amiche e nient'altro in comune
- **THEN** ognuna SHALL comparire nella rubrica dell'altra

#### Scenario: la rubrica non chiama fuori
- **GIVEN** una richiesta dell'elenco persone
- **THEN** SHALL essere fatte ZERO chiamate di rete
