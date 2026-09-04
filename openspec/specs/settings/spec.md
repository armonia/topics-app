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

### Requirement: APPSET-03 — Due voci, due contenuti, e ogni porta arriva alla propria

«Chi sei» e «che macchine hai» SHALL essere DUE voci distinte del pannello, e
SHALL mostrare contenuti DIVERSI. Erano una sola: l'identificativo diceva
`devices` mentre l'etichetta diceva «Profilo».

Ogni collegamento diretto SHALL atterrare sulla PROPRIA voce. È il pezzo che era
rotto — due gesti diversi puntavano entrambi alla stessa — ed è invisibile a
chiunque non apra tutte e due le porte di fila.

La voce attiva SHALL essere leggibile dalla marcatura di accessibilità che il
pannello già scrive. Un identificativo aggiunto apposta per la prova
misurerebbe la prova.

#### Scenario: le due porte
- **GIVEN** i due collegamenti diretti alle due voci
- **THEN** ciascuno SHALL attivare la propria, e i due contenuti SHALL differire

### Requirement: APPSET-04 — Lo stato dell'interfaccia è chiave→valore, non chiave→oggetto

La scrittura di una singola chiave dello stato dell'interfaccia SHALL accettare
qualunque valore rappresentabile — un booleano, una stringa, un numero, un elenco
— e SHALL rileggerlo IDENTICO. La guardia «deve essere un oggetto», ereditata da
una fase precedente, le rifiutava: il tema non è MAI stato conservato lato
server, e una preferenza booleana era ferma all'ultima scrittura precedente al
vincolo — in silenzio, perché chi scrive ignora l'errore.

Il valore diffuso agli altri SHALL essere il valore PRIMITIVO, non un
involucro.

Un valore NULLO SHALL essere rifiutato: non sarebbe rileggibile. Un corpo non
interpretabile SHALL restare un rifiuto.

La scrittura MASSIVA SHALL mantenere il vincolo di oggetto: è il canale di
un'altra cosa.

#### Scenario: una preferenza booleana
- **GIVEN** una scrittura di un booleano
- **THEN** SHALL essere riletta identica

#### Scenario: un valore nullo
- **GIVEN** una scrittura di nulla
- **THEN** SHALL essere rifiutata

### Requirement: APPSET-05 — Le voci delle impostazioni sono voci di PRIMO livello, tradotte davvero

Le pagine dell'identità — profilo, chi segue, riservatezza, organizzazione —
SHALL essere voci di PRIMO livello. C'erano già tutte, dentro una voce chiamata
altrimenti, come riquadri di una colonna che si scorre: chi le cercava non le
trovava, e «non le trovo» si racconta come «non ci sono».

La pagina del profilo NON SHALL più portare l'organizzazione.

Nessuna voce SHALL essere ripetuta, e ognuna SHALL avere la propria etichetta.

Nella seconda lingua le voci SHALL essere TRADOTTE DAVVERO, non ripiegate sulla
prima, e la verifica SHALL usare il criterio che sa distinguere «assente»
da «uguale».

L'interruttore a TRE stati — automatico, acceso, spento — SHALL fare andata e
ritorno senza collassare: scegliere «spento» SHALL scrivere un valore esplicito
che batte l'ambiente, e scegliere «automatico» SHALL CANCELLARE la scelta, non
scriverne una.

#### Scenario: la seconda lingua
- **GIVEN** le voci nella seconda lingua
- **THEN** NON SHALL essere ripiegate sulla prima

#### Scenario: «automatico»
- **GIVEN** la scelta automatica
- **THEN** SHALL cancellare la scelta, non scriverne una

### Requirement: APPSET-06 — Ogni codice di rifiuto ha una frase VERA, in entrambe le lingue

OGNI codice che il server può mandare SHALL avere una frase nel dizionario, in
ENTRAMBE le lingue, e la verifica SHALL usare il criterio che rileva l'ASSENZA —
non la funzione di traduzione, che su una chiave presente nella prima lingua e
assente nella seconda non può dire niente.

Un codice che l'interfaccia NON conosce, o assente, NON SHALL lasciare il
pannello muto: SHALL cadere su una frase generica.

Ogni motivo SHALL avere una chiave PROPRIA: nessuno SHALL cadere su quella di un
altro.

Un rifiuto ARRIVATO NON SHALL diventare «non riesco a contattare»: sono due
diagnosi opposte, e la seconda manda a controllare la rete quando il problema è
una regola. Una richiesta che NON torna SHALL restare «non riesco a contattare».
Un corpo senza codice, o illeggibile, SHALL cadere sulla frase generica: la
prosa da sola NON è un codice.

Le attese fra un tentativo e l'altro SHALL crescere, SHALL avere un TETTO, e
NESSUNA SHALL essere zero.

#### Scenario: un rifiuto del servizio
- **GIVEN** una risposta di rifiuto arrivata
- **THEN** NON SHALL essere raccontata come irraggiungibilità

#### Scenario: un codice sconosciuto
- **GIVEN** un codice che l'interfaccia non conosce
- **THEN** SHALL comparire la frase generica

### Requirement: ENVALIAS-01 — Il nome canonico vince, e l'alias avvisa UNA volta

Il valore CANONICO SHALL vincere sull'alias, e in quel caso NON SHALL essere
avvisato niente: chi ha già la forma nuova non ha nulla da correggere.

L'alias SHALL essere onorato come RIPIEGO, e SHALL avvisare ESATTAMENTE una
volta: un avviso a ogni lettura diventa rumore e smette di essere letto.

Una stringa VUOTA SHALL valere «non impostato»: una variabile svuotata è un modo
di toglierla.

L'avviso SHALL essere deduplicato per NOME di alias, non globalmente: due alias
diversi hanno due cose diverse da dire.

#### Scenario: canonico e alias entrambi presenti
- **GIVEN** entrambe le forme impostate
- **THEN** SHALL vincere la canonica, senza avvisi

#### Scenario: lo stesso alias letto dieci volte
- **GIVEN** più letture consecutive
- **THEN** SHALL essere avvisato una volta sola

### Requirement: EFFORTUI-01 — L'impegno si cambia in UN posto solo, ed è un cursore

L'impegno viveva in DUE superfici — il pannello del modello e quello di sessione
— con due grafiche e due idee di «predefinito».

Il pannello del MODELLO NON SHALL più offrire quei comandi. Il pannello di
sessione SHALL avere un CURSORE che scrive l'impegno.

Cambiare l'impegno NON SHALL spostare di un pixel la barra del campo di
scrittura: un valore che cambia la geometria fa saltare la riga sotto le mani.

La finestra del modello SHALL leggersi in un DISTINTIVO, non in un suffisso
tagliato a metà.

#### Scenario: il pannello del modello
- **GIVEN** il pannello aperto
- **THEN** NON SHALL contenere i comandi dell'impegno

#### Scenario: cambiare l'impegno
- **GIVEN** un movimento del cursore
- **THEN** la barra del campo di scrittura NON SHALL spostarsi

### Requirement: SETORG-01 — Le impostazioni parlano italiano, e i gruppi si trovano da lì

Segnalato: le impostazioni non erano ben divise, i gruppi non si vedevano, e nel
profilo era accorpata la possibilità di aggiungere altre persone — che lì non ha
senso, perché il profilo è di una persona sola.

Il menu delle impostazioni SHALL essere nella lingua dell'interfaccia.

Il banner da mettere in un documento condiviso SHALL essere copiabile da lì, già
pronto.

I GRUPPI SHALL trovarsi dalle impostazioni, non dal profilo.

#### Scenario: il menu delle impostazioni
- **GIVEN** la lingua predefinita
- **THEN** le voci SHALL leggersi in quella lingua

#### Scenario: i gruppi
- **GIVEN** le impostazioni aperte
- **THEN** i gruppi SHALL essere raggiungibili da lì

### Requirement: SETMOB-01 — Sul telefono le impostazioni ci stanno, e non offrono ciò che lì non esiste

Due segnalazioni dal telefono sulla stessa superficie: le impostazioni non erano
adatte allo schermo, e mostravano voci che su un telefono non servono.

A larghezza di telefono il pannello SHALL stare nello schermo e NON SHALL avere
bersagli sotto la misura del dito.

NON SHALL comparire nessun elenco a discesa DI SISTEMA nella pagina, e la lingua
SHALL cambiarsi col menu proprio dell'app: un elenco di sistema apre una
superficie che non è nostra e non si può misurare.

I comandi sui riquadri NON SHALL comparire dove i riquadri non ci sono.

#### Scenario: a larghezza di telefono
- **GIVEN** uno schermo stretto
- **THEN** nessun bersaglio SHALL essere sotto la misura del dito

#### Scenario: i comandi sui riquadri
- **GIVEN** una superficie senza riquadri
- **THEN** NON SHALL comparire i loro comandi

### Requirement: ORG-PROJECTS-NO-HARDCODE-01 — Il pannello dei progetti dell'organizzazione non spedisce i progetti di UNA macchina a tutti

Il pannello «progetti consigliati» delle impostazioni SHALL mostrare solo ciò
che arriva dai dati dell'installazione. Le stringhe dell'interfaccia e il
componente NON SHALL contenere nomi che esistono solo sulla macchina dove il
pannello è stato scritto: il nome di un'azienda, i repository personali di
qualcuno, questo stesso progetto.

#### Scenario: i cataloghi e il componente
- **GIVEN** i cataloghi delle due lingue e il componente del pannello
- **THEN** nessuno dei nomi locali SHALL comparire

#### Scenario: nessun consiglio senza dati
- **GIVEN** un'installazione senza progetti dell'organizzazione
- **THEN** il pannello NON SHALL inventare suggerimenti
