## Purpose

Le impostazioni dell'applicazione: dove vivono, chi le può scrivere, e la
distinzione che questa capability esiste per tenere ferma — fra una PREFERENZA
di una persona, che va con lei da un dispositivo all'altro, e la GEOMETRIA di un
dispositivo, che non deve seguirla da nessuna parte.

## Requirements

### Requirement: APPSET-01 — Impostazione, ambiente, default: in quest'ordine, e ogni ripiego è una scelta

Ogni impostazione SHALL essere risolta nell'ordine: quello che è stato SCRITTO,
poi l'ambiente, poi il default. Una scrittura SHALL vincere sempre sull'ambiente.

Un patch SHALL toccare SOLO le chiavi che nomina, e un valore nullo esplicito
SHALL riportare quella chiave al ripiego invece di scriverci sopra un vuoto. Le
chiavi ignote SHALL essere ignorate.

Un database che non è pronto SHALL dare impostazioni tutte vuote e MAI un
errore: l'applicazione parte comunque, sui default.

QUALI impostazioni ammettono un ripiego d'ambiente SHALL essere una decisione
dichiarata caso per caso, non una regola uniforme: la lingua di uscita è una
preferenza di una PERSONA e NON SHALL avere un ripiego d'ambiente; il motore di
esecuzione è una proprietà della MACCHINA e ce l'ha.

Un valore fuori scala SHALL essere rifiutato alla scrittura invece di essere
scritto e poi disatteso. E dove un valore illeggibile arriva comunque, il ripiego
SHALL cadere dal lato più prudente: il livello di dettaglio della presenza
pubblica ricade su quello più riservato, mai su quello che dice di più.

Un valore illeggibile SHALL essere distinto da un valore ASSENTE: il primo è un
refuso e ricade sul comportamento storico, il secondo prende il default corrente.

L'elenco dei fornitori accettabili SHALL venire dal registro dei fornitori VIVI e
non da una lista scritta a mano.

#### Scenario: un refuso e un'assenza
- **GIVEN** un valore scritto a mano che non corrisponde a niente
- **THEN** SHALL ricadere sul comportamento storico
- **AND** una colonna VUOTA con ambiente assente SHALL invece prendere il default corrente

#### Scenario: un livello di dettaglio illeggibile
- **GIVEN** un livello di presenza pubblica fuori scala
- **THEN** SHALL ricadere su quello più riservato

### Requirement: APPSET-02 — La geometria di un dispositivo non viaggia

Lo stato dell'interfaccia che si sincronizza fra dispositivi SHALL essere
RIPULITO dei campi che descrivono la geometria del dispositivo — la larghezza
della barra laterale e il fatto che sia chiusa.

Duecentocinquantasei pixel sono mezzo schermo su un telefono, e «chiusa» è una
condizione che il telefono e le finestre staccate impongono da sé: se quei campi
viaggiassero, l'ultimo dispositivo che salva imporrebbe la propria forma a tutti
gli altri.

La ripulitura SHALL essere per CHIAVE e non per nome di campo: la stessa forma
sotto un'altra chiave SHALL restare intatta.

L'oggetto passato dal chiamante NON SHALL essere modificato.

Un valore che non è un oggetto SHALL essere restituito identico.

#### Scenario: la stessa forma sotto un'altra chiave
- **GIVEN** un campo con lo stesso nome sotto una chiave diversa da quella delle impostazioni
- **THEN** SHALL restare
