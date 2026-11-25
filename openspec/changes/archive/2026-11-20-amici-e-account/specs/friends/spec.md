# Delta: friends — l'amicizia fra due installazioni

## ADDED Requirements

### Requirement: FRIEND-01 — Essere amici NON apre nessuna porta

Un'amicizia SHALL conferire esattamente: un nome, una faccia e la possibilità di
comparire negli elenchi dell'altro. NIENTE altro.

Un'amicizia NON SHALL creare nessuna concessione su una risorsa, NON SHALL
appaiare nessun dispositivo, NON SHALL aprire nessuna sessione ospite e NON SHALL
comparire in nessun ramo del cancello di autenticazione. Il percorso che decide
se una richiesta entra SHALL restare INDIFFERENTE all'esistenza di un'amicizia:
con e senza, la stessa richiesta SHALL ricevere la stessa risposta.

Questa è la prima regola e non l'ultima perché è ciò che rende accettabile tutto
il resto: l'invito viaggia su un canale che nessuno controlla, quindi chi lo
intercetta deve poter ottenere al massimo una riga in una lista.

Un'amicizia NON SHALL creare un legame di «seguo», in nessuna delle due
direzioni. Sono due relazioni con due domande diverse, e crearne una in silenzio
scrive righe che nessuno ha chiesto nella tabella che governa cosa si vede.

#### Scenario: la stessa richiesta, con e senza amicizia
- **GIVEN** una richiesta su una risorsa non condivisa, rifiutata dal cancello
- **WHEN** chi la fa diventa amico del proprietario
- **THEN** SHALL essere rifiutata identicamente

#### Scenario: accettare non fa seguire
- **GIVEN** due persone che diventano amiche
- **THEN** nessun legame di «seguo» SHALL essere stato creato

### Requirement: FRIEND-02 — Si chiede, si accetta, e il fatto vive in DUE righe

Un'amicizia SHALL esistere come una riga PER LATO, sul database di ciascuna
installazione, e ogni lato SHALL essere padrone della propria. NON SHALL esistere
un lato autorevole di cui l'altro sia una copia.

Lo stato SHALL distinguere l'invito in uscita, quello in arrivo, l'amicizia
accettata e quella sciolta. Uno stato che dice «amici» quando l'altra
installazione non lo sa ancora NON SHALL essere mostrato come tale.

L'identità dell'altro SHALL essere conservata in CACHE al momento del contatto
— installazione, persona, nome, faccia — e gli elenchi SHALL essere disegnabili
SENZA nessuna chiamata di rete. Una lista di amici che ha bisogno della rete per
comparire è una lista che sparisce in aereo.

Lo stato SHALL SOPRAVVIVERE al riavvio di ENTRAMBE le installazioni: è una riga
su disco, mai una connessione viva.

#### Scenario: l'altra installazione è spenta
- **GIVEN** un invito riscattato mentre l'altra installazione non risponde
- **THEN** SHALL restare in attesa, e NON SHALL comparire fra gli amici

#### Scenario: dopo il riavvio di entrambe
- **GIVEN** un'amicizia accettata e le due installazioni riavviate
- **THEN** SHALL essere ancora accettata su entrambe, senza nessun nuovo scambio

### Requirement: FRIEND-03 — L'invito è una capacità MONOUSO, e ogni modo di fallire dà lo stesso nulla

Un invito SHALL valere per UNA sola amicizia, SHALL SCADERE, e SHALL essere
consumato al primo riscatto andato a buon fine.

Un invito scaduto, uno già consumato da un'altra installazione e uno inventato di
sana pianta SHALL produrre la STESSA risposta: chi prova non SHALL poter
distinguere «non esiste» da «non è più valido», o l'errore diventa un modo per
sapere quali codici sono esistiti.

Il riscatto SHALL essere IDEMPOTENTE per la coppia: ripetuto dalla STESSA
installazione con lo stesso invito già consumato SHALL riconsegnare lo stesso
esito, perché la risposta persa per strada è il caso normale e non un guasto.

Il carico del riscatto SHALL contenere SOLO l'identità di chi riscatta e il
segreto dell'invito. Nessun cookie, nessun token di sessione, nessuna concessione.

#### Scenario: tre modi di fallire
- **GIVEN** un invito scaduto, uno consumato da un terzo e uno inesistente
- **THEN** le tre risposte SHALL essere indistinguibili

#### Scenario: la risposta persa
- **GIVEN** un riscatto riuscito la cui risposta non è arrivata
- **WHEN** la stessa installazione ripete il riscatto
- **THEN** SHALL ricevere lo stesso esito, e NON SHALL essere creata una seconda riga

### Requirement: FRIEND-04 — Sciogliere è LOCALE, unilaterale e funziona senza rete

Togliere un'amicizia SHALL riuscire SEMPRE sul lato di chi lo chiede, anche con
l'altra installazione irraggiungibile, anche per sempre.

L'altro lato NON SHALL poter rifiutare, ritardare o annullare lo scioglimento.
Nessuno SHALL restare intrappolato in una relazione che non può sciogliere, e
questa è la stessa regola che vale già per il legame di «seguo» verso un profilo
chiuso.

Uno scioglimento SHALL essere idempotente: il secondo gesto NON SHALL essere un
errore.

Un invito ancora in attesa SHALL potersi ANNULLARE, e l'annullamento SHALL
rendere il codice inservibile anche per chi lo ha già in mano.

#### Scenario: senza rete
- **GIVEN** l'altra installazione irraggiungibile
- **THEN** lo scioglimento SHALL riuscire e SHALL essere visibile subito

#### Scenario: l'invito annullato
- **GIVEN** un invito annullato da chi lo ha emesso
- **THEN** il riscatto SHALL dare lo stesso nulla di un invito inesistente

### Requirement: FRIEND-05 — Il chip conta gli AMICI, e senza amici porta al gesto

La pastiglia in fondo alla barra laterale SHALL chiamarsi «Amici» in italiano e
«Friends» in inglese, e SHALL contare gli amici accettati: NON SHALL contare
tutte le persone che la rubrica conosce, che è un insieme diverso e più grande.

Con nessun amico lo stato vuoto SHALL portare al gesto che ne aggiunge uno.
Dire che non conosci nessuno senza dire come si rimedia lascia lo schermo in un
vicolo cieco.

Gli inviti in ARRIVO SHALL essere visibili nella stessa superficie, distinti
dagli amici: una richiesta che aspetta e non si vede è una richiesta rifiutata
per stanchezza.

Le due lingue SHALL avere la stessa frase, e nessuna chiave SHALL restare senza
traduzione.

#### Scenario: rubrica popolata, zero amici
- **GIVEN** una rubrica con dei membri di gruppo e nessuna amicizia
- **THEN** il conteggio SHALL essere zero, e lo stato vuoto SHALL offrire il gesto

#### Scenario: un invito in arrivo
- **GIVEN** un invito in arrivo non ancora accettato
- **THEN** SHALL essere visibile, e NON SHALL essere contato fra gli amici

### Requirement: FRIEND-06 — La prova è su DUE macchine, e passa da uno spegnimento

L'amicizia SHALL essere verificata da uno scenario che usa DUE installazioni
distinte con due identità distinte, e NON SHALL essere considerata provata da una
simulazione dentro un solo processo.

Lo scenario SHALL comprendere lo spegnimento e il riavvio di ENTRAMBE le
installazioni fra l'accettazione e la verifica finale: è l'unico passaggio che
distingue uno stato salvato da uno tenuto in memoria.

Lo scenario SHALL rispettare le invarianti del banco: la porta di test è protetta
da un lock, e una run respinta NON SHALL uccidere i processi di un'altra
(E2E-LOCK-01). Due server nella stessa run SHALL avere due directory dati
distinte.

#### Scenario: due installazioni, un invito
- **GIVEN** due installazioni con due identità distinte
- **WHEN** una invita e l'altra accetta
- **THEN** ognuna SHALL vedere l'altra fra i propri amici

#### Scenario: dopo lo spegnimento
- **GIVEN** entrambe le installazioni riavviate
- **THEN** l'amicizia SHALL essere ancora lì su entrambe
