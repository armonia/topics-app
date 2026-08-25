## Purpose

Chi sei su questa installazione, a quale gruppo appartieni, e chi può
amministrarlo. Sono tre domande che si somigliano e hanno tre risposte diverse,
e confonderle produce due «te».

## Background

L'ATTIVAZIONE DI UN ACCOUNT NON CREA UNA PERSONA. Se lo facesse, chi ha già una
riga in rubrica se ne ritroverebbe due — quella locale e quella «dell'account» —
e nessuna delle due sarebbe sbagliata abbastanza da poterla cancellare.

IL GRUPPO DI QUESTA INSTALLAZIONE NON È «LA RIGA PIÙ VECCHIA». È stato un difetto
vero: con due gruppi sul disco, la risposta cambiava identità in silenzio.

DUE DEFINIZIONI DI «MEMBRO» ERANO GIÀ STATE SCRITTE DUE VOLTE, e due definizioni
producono due numeri per la domanda «quanti siete».

## Requirements

### Requirement: ACCOUNT-01 — Agganciare un account non crea nessuno, e non sostituisce niente in silenzio

L'attivazione di un account SHALL agganciarsi a una persona che ESISTE GIÀ, e NON
SHALL inserirne una nuova in nessun ramo.

Il bersaglio SHALL essere sempre la persona che sta agendo, MAI la riga trovata
cercando per indirizzo: cercare e agganciare sono due cose diverse, e agganciare
sulla riga trovata è come nasce il doppione.

SHALL essere rifiutato, con un motivo DISTINTO per ciascun caso: un identificativo
remoto già di un'altra riga, un indirizzo già di un'altra riga, e una riga che
porta già un ALTRO account — quest'ultimo NON SHALL essere sostituito in silenzio.

Un indirizzo o un account appartenenti a una persona REVOCATA SHALL essere
DICHIARATI tali, non aggirati: la revoca non si scavalca cambiando strada.

Senza nessuna persona a cui agganciarsi SHALL essere rifiutato — e questo è anche
ciò che impedisce di far resuscitare una persona revocata.

Riattivare lo STESSO account SHALL essere idempotente. Il nome scelto localmente
NON SHALL essere sovrascritto da quello remoto: il remoto riempie solo il vuoto.

Scollegare SHALL togliere l'account e LASCIARE l'indirizzo, e il secondo gesto
NON SHALL essere un errore.

Un carico senza account o senza indirizzo NON SHALL essere interpretato.

#### Scenario: chi è già in rubrica con quell'indirizzo
- **GIVEN** una persona già presente con lo stesso indirizzo
- **THEN** SHALL essere riconosciuta, non duplicata

#### Scenario: due installazioni, un solo account
- **GIVEN** due database con due righe locali che portano lo stesso identificativo remoto
- **THEN** NON SHALL essere creata nessuna persona

### Requirement: ACCOUNT-02 — Il servizio giù non declassa nessuno, e i modi di fallire non collassano

Il servizio dell'account NON SHALL avere nessun percorso che, per irraggiungibilità,
riduca ciò che l'installazione può fare. Per costruzione NON SHALL esistere una
rivalidazione periodica che possa fallire.

L'assenza della configurazione SHALL valere «non c'è servizio», e NON SHALL essere
un errore né produrre un valore predefinito. Senza servizio configurato NON SHALL
essere tentata nessuna chiamata.

I modi di fallire SHALL restare DISTINTI: rete caduta, errore del servizio,
troppe richieste, e codice sbagliato sono quattro risposte diverse. Un codice
sbagliato è un errore di CHI SCRIVE, non un guasto del servizio, e confonderli
manda a cercare un problema che non c'è.

Una risposta positiva che non ha la forma attesa NON SHALL essere interpretata:
altrimenti si aggancia un'identità inventata.

L'indirizzo SHALL essere normalizzato prima di essere confrontato o scritto.

#### Scenario: il servizio non risponde
- **GIVEN** il servizio dell'account irraggiungibile
- **THEN** ciò che l'installazione può fare NON SHALL cambiare

#### Scenario: risposta positiva ma di forma ignota
- **GIVEN** una risposta con esito positivo e un corpo inatteso
- **THEN** NON SHALL essere ricavata nessuna identità

### Requirement: ORG-INST-01 — Il gruppo dell'installazione è quello DICHIARATO, e «membro» ha UNA definizione

Il gruppo di questa installazione SHALL essere letto dal PUNTATORE dichiarato, e
NON SHALL essere «la riga più vecchia della tabella»: con due gruppi sul disco
quella scelta cambia identità in silenzio.

Se il puntatore indica un gruppo non più vivo, SHALL essere usato il gruppo vivo
del proprietario predefinito — ma un gruppo di cui quel proprietario NON è membro
NON SHALL essere un ripiego: consegnerebbe l'identità di un gruppo altrui.

«Membro vivo» SHALL avere UNA definizione sola, e SHALL guardare ENTRAMBE le
forme di revoca. Due definizioni producono due numeri per «quanti siete», ed è
già successo due volte.

Un'appartenenza revocata NON SHALL essere un ruolo più debole: è ASSENZA.

La revoca di un GRUPPO NON SHALL toccare le sue appartenenze: sapere che qualcuno
può amministrare NON basta a sapere che il gruppo è vivo, e le due domande vanno
fatte entrambe.

L'insieme dei ruoli riconosciuti dal codice SHALL coincidere con quello che il
database impone.

Un dispositivo SHALL portare alla propria persona; un dispositivo REVOCATO NON
SHALL più portare a nessuno. L'assenza di dispositivo — la macchina stessa — SHALL
ricadere sul proprietario predefinito, mai su nessuno.

Uno schema più vecchio delle colonne che servono SHALL produrre «non lo so», e
questo SHALL essere distinguibile da «non esiste»: rispondere «non esiste» a un
database non migrato manda a cercare la cosa sbagliata.

#### Scenario: due gruppi sul disco
- **GIVEN** più gruppi di cui uno dichiarato come quello dell'installazione
- **THEN** SHALL essere restituito quello dichiarato

#### Scenario: schema non migrato
- **GIVEN** un database privo delle colonne necessarie
- **THEN** SHALL essere restituito «non lo so», distinto da «non esiste»

### Requirement: FOLLOW-01 — Il conteggio corrisponde alla lista, e l'email cade CHIUSA

Il legame «seguo» SHALL essere ASIMMETRICO e IDEMPOTENTE: seguire due volte è
seguire una volta e NON SHALL muovere l'istante. Seguire sé stessi SHALL essere
rifiutato senza lasciare traccia. Smettere di seguire SHALL togliere UN verso
solo.

**Il conteggio NON SHALL contare righe che la lista non mostra.** Una persona
revocata SHALL sparire dal contatore, non solo dall'elenco: un numero che non
corrisponde alla lista sotto è un numero che nessuno può verificare. Chi guarda
SHALL vedere sempre sé stesso.

Cancellare una persona SHALL portare via i suoi legami, senza lasciare contatori
appesi.

Gli interruttori di visibilità SHALL avere per difetto tutto aperto TRANNE
l'indirizzo di posta. Su uno schema mancante o una persona sconosciuta i valori
SHALL cadere sui difetti, e **l'indirizzo SHALL cadere CHIUSO**: è l'unico dato
che raggiunge una persona fuori di qui.

Una modifica parziale NON SHALL riaprire interruttori che non nomina. Un valore
che non è un booleano SHALL essere IGNORATO, non convertito. Una modifica vuota
NON SHALL scrivere niente e SHALL restituire lo stato che c'è.

Una scrittura SHALL far avanzare il contatore di revisione, o il cambio resta
invisibile a chi è collegato.

Nessuna di queste funzioni SHALL sollevare: la schermata dei profili NON SHALL
cadere per uno schema vecchio. E una scrittura fallita NON SHALL promettere di
essere riuscita.

#### Scenario: una persona revocata
- **GIVEN** un legame verso una persona revocata
- **THEN** SHALL sparire dal conteggio come dalla lista

#### Scenario: uno schema senza le colonne della visibilità
- **GIVEN** un database privo di quelle colonne
- **THEN** SHALL valere i difetti, e l'indirizzo SHALL essere chiuso

### Requirement: ACCOUNT-03 — La porta dell'account NON risponde MAI con un guasto del server

NESSUN ramo di questa porta SHALL rispondere con un errore del server. Il modo in
cui una porta del genere si guasta è sempre lo stesso: qualcuno decide che «il
servizio non risponde» è un errore NOSTRO, e da lì chi legge va a cercare il
problema dove non c'è.

I codici SHALL essere: sempre positivo in LETTURA — con lo stato dichiarato,
compreso «non c'è servizio» — un CONFLITTO quando lo stato non permette
l'operazione, e un rifiuto di RICHIESTA solo per un corpo malformato.

La lettura NON SHALL chiamare NESSUNO, nemmeno con il servizio configurato.

L'attivazione SHALL agganciare l'account alla persona CHE STA AGENDO. Agganciarlo
alla riga trovata cercando per INDIRIZZO — mentre lettura e scollegamento parlano
di chi agisce — è come l'attivazione rispondeva bene e il pannello continuava a
dire che non c'era nessun account. L'indirizzo di UN'ALTRA riga SHALL essere
RIFIUTATO, non agganciato lì.

Un servizio irraggiungibile OGGI NON SHALL scollegare chi si è collegato IERI: si
resta collegati, e il tentativo nuovo LO DICE.

Uno schema più vecchio delle colonne necessarie NON SHALL rompere la porta: SHALL
rispondere «non collegato».

Le due porte che dichiarano l'identità SHALL parlare della STESSA persona.

#### Scenario: il servizio non risponde
- **GIVEN** un account collegato e il servizio irraggiungibile
- **THEN** SHALL restare collegato, e il tentativo SHALL dichiarare il problema

#### Scenario: l'indirizzo di un'altra persona
- **GIVEN** una verifica su un indirizzo che appartiene a un'altra riga
- **THEN** SHALL essere rifiutata, senza agganciarsi lì


### Requirement: ORG-INST-02 — La rubrica e il CANCELLO non possono divergere, e i membri si contano allo stesso modo

Le due porte che dichiarano quante persone ci sono SHALL dare lo STESSO numero:
erano due definizioni diverse sulla stessa organizzazione, e dopo aver tolto
qualcuno una delle due continuava a contarlo.

La rubrica e il cancello che decide chi può SHALL accettare e rifiutare allo
STESSO modo: se divergono, si vede una persona che non si può raggiungere, o si
raggiunge una che non si vede.

L'instradamento di una richiesta NON SHALL essere deciso da un confronto per
PREFISSO: non sa dove finisce un identificativo, e una modifica ai membri cadeva
nel ramo della rinomina.

Revocare un GRUPPO SHALL togliere anche la capacità di amministrarlo: le sue
appartenenze restavano intatte, e chi poteva amministrare continuava a poterlo.

La revoca di una PERSONA SHALL essere SCRIVIBILE da qualche schermata: quella
colonna era letta in otto punti e scritta in nessuno.

#### Scenario: una persona tolta dal gruppo
- **GIVEN** un membro rimosso
- **THEN** entrambe le porte SHALL dichiarare lo stesso numero

#### Scenario: un gruppo revocato
- **GIVEN** la revoca del gruppo
- **THEN** NON SHALL restare la capacità di amministrarlo
