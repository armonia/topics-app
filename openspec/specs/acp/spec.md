## Purpose

Parlare con un agente di qualcun altro attraverso un protocollo comune: come si
trasporta un messaggio, come si negozia la versione, e perché N agenti diversi
non possono chiamarsi tutti allo stesso modo.

## Background

OGNI GUASTO DI UN'INTEGRAZIONE SU FLUSSO STANDARD MUORE SENZA DARE ERRORE. Una
riga tagliata a metà da un frammento, una stampa di diagnostica finita sull'uscita
buona, una richiesta che non riceve risposta, un processo che muore con una
promessa ancora in volo: nessuno di questi produce un errore: producono una chat
che resta ferma.

E N AGENTI CONDIVIDONO UN TIPO SOLO. Finché l'agente era uno, «nome» e «tipo»
coincidevano e nessuno se n'era accorto. Con più agenti, un registro che
deduplica sul TIPO spegne il primo nel momento in cui registri il secondo — in
silenzio, perché fermare un provider non fa rumore.

## Requirements

### Requirement: ACP-01 — Una riga illeggibile non uccide la connessione, e niente resta appeso

Il trasporto SHALL ricomporre un messaggio TAGLIATO fra più frammenti, e SHALL
consegnare in ORDINE più messaggi arrivati nello stesso frammento.

Del RUMORE sull'uscita — una riga che non è un messaggio — NON SHALL uccidere la
sessione: SHALL essere scartata e il messaggio successivo SHALL passare.
Altrimenti una stampa di diagnostica di troppo dell'agente fa cadere tutto. Le
righe VUOTE SHALL essere ignorate senza segnalare niente.

Una richiesta SHALL portare un identificativo CRESCENTE e SHALL risolversi con
la propria risposta; un errore dell'altro capo SHALL diventare un errore TIPIZZATO
che conserva codice e messaggio. Una notifica NON SHALL avere identificativo e
NON SHALL lasciare niente in volo.

Un metodo IGNOTO SHALL ricevere COMUNQUE una risposta con il codice previsto,
mai silenzio. Un gestore che SOLLEVA SHALL diventare un errore interno, non un
turno appeso. Una notifica ignota SHALL essere ignorata in silenzio — è il suo
contratto — e un gestore di notifica che solleva NON SHALL propagare fuori.

La chiusura SHALL RIGETTARE tutto ciò che è in volo: senza, la morte del
processo si manifesta come una promessa che non si risolve MAI. Dopo la chiusura
una richiesta SHALL rigettare SUBITO, la chiusura SHALL essere IDEMPOTENTE — la
morte del processo e la fine del flusso arrivano entrambe — e non SHALL essere
scritto più niente.

Una risposta SENZA una richiesta ad attenderla SHALL essere segnalata e NON SHALL
esplodere.

#### Scenario: rumore sull'uscita
- **GIVEN** righe non interpretabili seguite da un messaggio valido
- **THEN** il messaggio valido SHALL arrivare

#### Scenario: il processo muore
- **GIVEN** richieste in volo alla chiusura
- **THEN** SHALL essere tutte rigettate

### Requirement: ACP-02 — La versione del protocollo si NEGOZIA, e il rifiuto ha un nome

La versione dichiarata dall'altro capo SHALL essere LETTA e CONFRONTATA, non
buttata via: continuare a parlare la nostra versione con un interlocutore che ne
parla un'altra fa arrivare il guasto più tardi e SENZA NOME.

Una versione PIÙ ALTA della nostra SHALL CHIUDERE la connessione con un motivo
che PORTA IL NUMERO. Dopo il rifiuto NON SHALL esserci ritentativi automatici, e
lo stato SHALL essere dichiarato non disponibile.

La DIAGNOSI SHALL dirlo: requisito non soddisfatto, stato non disponibile, e la
versione dentro l'ultimo errore.

Una versione PIÙ BASSA o ASSENTE NON SHALL bloccare niente: è
retro-compatibilità.

Un nuovo avvio SHALL riaprire la porta: è la strada per riprovare dopo un
aggiornamento.

#### Scenario: una versione più alta
- **GIVEN** un agente che dichiara una versione superiore
- **THEN** la connessione SHALL chiudersi con un motivo che porta il numero

#### Scenario: una versione più bassa
- **GIVEN** un agente che dichiara una versione inferiore
- **THEN** NON SHALL essere bloccato niente

### Requirement: ACP-03 — Una configurazione di agenti malformata non impedisce l'AVVIO

Una configurazione di agenti ILLEGGIBILE NON SHALL impedire al server di
partire: il costo di un agente in meno è un fornitore assente, il costo di
un'eccezione all'avvio è l'applicazione che non si apre.

Una configurazione ASSENTE o VUOTA SHALL dare NIENTE, senza scarti. Un testo
ROTTO SHALL dare nessun agente e UNO SCARTO CONTATO, mai un'eccezione. Le voci
prive del comando SHALL essere scartate CONTANDOLE: uno scarto silenzioso è
indistinguibile da una configurazione vuota.

Un OGGETTO singolo SHALL valere come elenco da uno. Senza nome SHALL essere usato
il nome del file del comando.

Argomenti e ambiente SPORCHI SHALL essere RIPULITI invece di far cadere la voce
intera; un elenco di argomenti che non è un elenco SHALL diventare vuoto, non un
guasto.

Le voci DICHIARATE SHALL VINCERE su quelle note a parità di nome — chi le scrive
sta correggendo la tabella — e i nomi nuovi SHALL aggiungersi in coda. Senza
dichiarazioni SHALL restare la tabella nota, COPIATA e non l'originale.

#### Scenario: configurazione rotta
- **GIVEN** un testo di configurazione non interpretabile
- **THEN** SHALL dare nessun agente e uno scarto contato, senza sollevare

#### Scenario: una voce che corregge un agente noto
- **GIVEN** una voce dichiarata con lo stesso nome di uno noto
- **THEN** SHALL vincere quella dichiarata

### Requirement: ACP-04 — La sessione sopravvive al riavvio, e la CARTELLA fa parte dell'identità

L'identificativo della sessione dell'agente SHALL essere PERSISTITO e riletto
dopo un riavvio. L'errore che questo evita NON DÀ ERRORE: la chat mostra tutti i
messaggi di prima e il modello non ne ricorda nessuno.

La chiave SHALL comprendere il fornitore E il discorso: due agenti sulla STESSA
chat NON SHALL pestarsi. Riscrivere SHALL aggiornare, non duplicare. Dimenticare
SHALL cancellare, e dimenticare due volte NON SHALL essere un errore.

Una chat SENZA memoria SHALL dare «niente», non un errore. Uno schema PRIVO della
tabella SHALL dare «niente» — assenza di memoria, non guasto.

La CARTELLA DI LAVORO SHALL far parte dell'identità: il protocollo la fissa alla
creazione e non si cambia più, quindi ricaricare una sessione nata altrove
significa far lavorare l'agente nella cartella SBAGLIATA. Una cartella DIVERSA
SHALL impedire il riuso; un'assenza da una delle due parti NON SHALL invalidare
niente.

#### Scenario: cartella diversa
- **GIVEN** una sessione salvata con un'altra cartella di lavoro
- **THEN** NON SHALL essere riusata

#### Scenario: schema senza la tabella
- **GIVEN** un database privo della tabella
- **THEN** SHALL dare «niente», non un errore

### Requirement: ACP-05 — Il registro indicizza per NOME, non per tipo

Il registro dei fornitori SHALL essere indicizzato per NOME. Per i fornitori
storici nome e tipo COINCIDONO e niente cambia; per gli agenti esterni il nome è
quello dell'AGENTE, e un registro che deduplica sul tipo spegne il primo nel
momento in cui si registra il secondo — in silenzio.

Due agenti SHALL convivere: registrare il secondo NON SHALL spegnere il primo.
Ri-registrare lo STESSO nome SHALL sostituire, senza doppioni nell'elenco.

Un agente esterno SHALL registrarsi sotto il PROPRIO nome, e il tipo comune NON
SHALL essere raggiungibile come se fosse un fornitore.

Le etichette dei fornitori NOTI SHALL restare quelle scritte a mano; un agente
esterno SHALL presentarsi CAPITALIZZATO, non tutto minuscolo. Un nome che
COLLIDE con una proprietà ereditata SHALL dare una STRINGA, non una funzione.

#### Scenario: due agenti esterni
- **GIVEN** due agenti registrati uno dopo l'altro
- **THEN** entrambi SHALL restare raggiungibili

#### Scenario: un nome che collide con una proprietà ereditata
- **GIVEN** un agente che si chiama come un membro del prototipo
- **THEN** l'etichetta SHALL essere una stringa
