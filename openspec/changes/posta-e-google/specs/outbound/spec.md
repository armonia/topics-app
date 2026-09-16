# Delta: outbound (posta-e-google)

## ADDED Requirements

### Requirement: OUTBOUND-01 — La configurazione vive solo nell'ambiente, e ciò che manca si dice per nome

Gli indirizzi, gli account e i percorsi delle CLI SHALL essere letti SOLO da
`process.env`, e NON SHALL comparire in nessun file tracciato: il repo è
pubblico e `tests/unit/no-third-party-emails.test.ts` (GATE-07) è rosso su un
indirizzo personale in un file tracciato.

Le variabili sono `TOPICS_MAIL_CLI`, `TOPICS_MAIL_ACCOUNT`, `TOPICS_MAIL_FROM`,
`TOPICS_MAIL_ACCOUNTS` (forma `conto:indirizzo,conto:indirizzo`),
`TOPICS_MAIL_EDM_CLI`, `TOPICS_MAIL_EDM_FROM`, `TOPICS_GOOGLE_CLI`,
`TOPICS_GOOGLE_CONFIG_DIR`, `TOPICS_GOOGLE_CLIENT_SECRET`, e si scrivono in
`~/.topics-server-env`, che `scripts/start-prod.sh` sorgia.

Una variabile mancante o malformata SHALL produrre un errore che NOMINA la
variabile e dice dove si scrive. NON SHALL esistere nessun ripiego silenzioso su
un account diverso da quello chiesto: un invio partito dall'indirizzo sbagliato
è peggio di un invio non partito.

Il lettore SHALL esporre i NOMI degli account disponibili e NON SHALL mai
scrivere un indirizzo in un log o in un errore: un errore su un account
sconosciuto elenca i nomi, non le caselle.

La casella Exchange SHALL essere riconosciuta per INDIRIZZO: la voce di
`TOPICS_MAIL_ACCOUNTS` il cui indirizzo è `TOPICS_MAIL_EDM_FROM` SHALL usare
`TOPICS_MAIL_EDM_CLI` come trasporto, le altre `TOPICS_MAIL_CLI`. Nessun nome di
account SHALL essere scritto nel codice.

#### Scenario: manca una variabile
- **GIVEN** un ambiente senza `TOPICS_MAIL_CLI`
- **THEN** l'errore SHALL nominare `TOPICS_MAIL_CLI` e il file dove si scrive
- **AND** NON SHALL partire nessun processo

#### Scenario: la lista degli account è malformata
- **GIVEN** `TOPICS_MAIL_ACCOUNTS` senza il carattere `:` in una voce
- **THEN** l'errore SHALL nominare la variabile e la forma attesa

#### Scenario: un account non dichiarato
- **GIVEN** una richiesta con un account che non è nella lista
- **THEN** SHALL essere rifiutata elencando i NOMI disponibili
- **AND** NON SHALL ripiegare sull'account predefinito

### Requirement: OUTBOUND-02 — Una CLI si chiama per ARGV, e il suo eseguibile si trova senza PATH

Destinatario, oggetto, corpo e parametri arrivano da un MODELLO. SHALL essere
passati alla CLI come ELEMENTI DI UN ARRAY di argomenti, e NON SHALL mai essere
composti in una stringa data a una shell: `; rm -rf`, `$(...)`, virgolette e a
capo SHALL arrivare al processo figlio come UN argomento, letterale.

Il percorso dell'eseguibile SHALL venire dalla variabile. Se non è assoluto
SHALL essere risolto su un elenco di cartelle DICHIARATO, perché sotto launchd
il `PATH` non contiene `/usr/local/bin` né `/opt/homebrew/bin`; un eseguibile
non trovato SHALL dare un errore che nomina la variabile e il valore cercato.

L'ambiente del figlio SHALL portare `TOPICS_GOOGLE_CONFIG_DIR` e
`TOPICS_GOOGLE_CLIENT_SECRET` quando la chiamata è per Google.

#### Scenario: un destinatario che sembra un comando
- **GIVEN** un destinatario `vittima@esempio.test; rm -rf /`
- **THEN** il figlio SHALL ricevere quella stringa come un solo `argv[n]`
- **AND** nessun comando SHALL essere eseguito

#### Scenario: eseguibile non assoluto
- **GIVEN** `TOPICS_MAIL_CLI` con un nome nudo e nessuna cartella dichiarata che lo contiene
- **THEN** l'errore SHALL nominare la variabile e il nome cercato

### Requirement: OUTBOUND-03 — Prima di ogni invio una persona dice sì, e il sì vale per QUEL messaggio

L'invio di un messaggio e ogni chiamata Google che SCRIVE SHALL essere precedute
da una conferma umana IMPOSTA DAL SERVER: NON SHALL dipendere dalla descrizione
dello strumento, e un agente NON SHALL poterla saltare chiamando direttamente la
rotta.

La conferma SHALL passare per il canale umano che la board già usa: la domanda
esce nel thread della card come commento con risposte rapide quando la sessione
appartiene a un task, e come pannello sulla riga dello strumento in attesa
quando la sessione è una chat.

La conferma SHALL essere legata al MESSAGGIO: la chiave della domanda SHALL
derivare dal contenuto (destinatario, oggetto, corpo, account, allegati), e una
risposta che non porta quella chiave NON SHALL valere come sì. Un sì dato una
volta NON SHALL valere per il messaggio successivo, e NESSUNA regola permanente
(«consenti sempre») SHALL poter coprire un invio.

IL SÌ VALE PER UNA RICHIESTA, IDENTIFICATA DA UN ID SUO. Sulla strada della
board la chiave non la porta chi risponde: la timbra il server leggendola dal
registro delle domande aperte, che è chiavato sul TASK. Due sessioni dello
stesso task esistono per costruzione — il coordinatore e le sue figlie ci
stanno apposta — quindi «la domanda aperta su questo task» non basta a
identificare un messaggio: riprodotto, la persona leggeva «Preventivo →
cliente@esempio.test», rispondeva «Conferma», e partiva un altro messaggio verso
un altro destinatario, mentre la prima domanda restava muta e inesigibile.
Quindi:

- ogni domanda instradata SHALL avere un ID, e quell'id SHALL essere quello
  della riga del thread che la porta: è l'unica cosa che chi risponde può
  NOMINARE, perché è la riga su cui clicca;
- una risposta che nomina un id diverso da quello della domanda aperta NON SHALL
  essere consegnata, NON SHALL far partire niente, e la card SHALL dirlo: il
  commento è già salvato, e senza quella riga la persona crede di aver
  confermato;
- una risposta che non nomina nessun id SHALL valere per la domanda aperta, che
  è l'unica che può esserci per la regola qui sotto;
- una SECONDA conferma di invio su una card che ne ha già una VIVA SHALL essere
  RIFIUTATA con quella ragione, e NON SHALL prendere il posto della prima,
  CHIUNQUE la chieda: un'altra sessione dello stesso task o un'altra richiesta
  della STESSA sessione, che non è un caso limite — il bridge MCP gestisce ogni
  riga JSON-RPC in un callback che non aspetta, quindi due `send_mail` di un
  messaggio corrono insieme, e la rotta è comunque chiamabile a mano. La card
  disegna un blocco di risposta rapida solo: mostrare la seconda significa
  togliere la prima, e un atto irreversibile non può nemmeno restare in coda in
  silenzio per ore. Una `ask_user_question` generica invece ASPETTA il suo
  turno, perché il suo bridge ripassa con la stessa domanda ogni 25 secondi e
  non perde niente;
- il rifiuto della seconda NON SHALL toccare niente di ciò che è della prima:
  né il suo rendez-vous, né la sua voce nel registro, né una riga nel thread.
  Il registro SHALL essere chiavato sulla RICHIESTA — l'id della riga che porta
  la domanda — e non sulla sessione: chiavato sulla sessione, la gamba che
  perdeva cancellava la voce di quella che aveva vinto, e il clic sulla conferma
  ancora a schermo non partiva più (misurato: `pendingRoutedAsk` tornava null e
  la card non diceva niente). Chiavare per id NON basta da solo, e la spec non
  SHALL prometterlo: due richieste possono portare lo STESSO id, perché
  l'instradamento restituisce la voce aperta a chiunque ripeta la stessa domanda
  e due `send_mail` di un messaggio la ripetono per costruzione. Ciò che regge è
  il punto qui sotto;
- se la domanda che occupa la card non aspetta più nessuno, la nuova SHALL
  sostituirla, la sostituzione SHALL essere scritta nel thread ANCHE fra
  sessioni diverse, e il rendez-vous della sostituita SHALL essere annullato,
  così il suo invio fallisce con la sua traccia invece di raccogliere un sì che
  non era suo. «Non aspetta più nessuno» SHALL essere deciso su DUE fatti e non
  su uno: la sessione della domanda non ha più un rendez-vous aperto (turno
  interrotto), oppure nessuno è più ripassato a ri-porre quella domanda entro un
  tempo dichiarato — le gambe del poll sono il battito, e una sola delle due
  misure non basta, perché il rendez-vous è chiavato sulla sessione e non sa
  distinguere due richieste della stessa.

UNA RICHIESTA ALLA VOLTA SULLA CARD, E IL CANCELLO SE LO IMPONE DA SÉ. Il
cancello SHALL prendere un LUCCHETTO sulla superficie che disegna la domanda —
la card quando la sessione ne ha una, la sessione stessa quando è una chat —
PRIMA di qualunque scrittura e PRIMA di aprire qualunque rendez-vous, e SHALL
rilasciarlo alla fine, anche sugli errori. Chi non lo prende SHALL essere
rifiutato subito, con la sua ragione, senza aver toccato niente: né il
rendez-vous della prima, né la sua voce nel registro, né una riga sopra la sua
domanda. Ordinare le operazioni non basta e NON SHALL essere la difesa: due
richieste con lo STESSO contenuto sono la stessa domanda per l'instradamento,
quindi la seconda passava il ramo «occupato», entrava nel rendez-vous della
prima e lo sostituiva (misurato a 120 ms: la prima tornava «superseded», si
portava via la voce comune, e la conferma restava a schermo coi tasti che non
raggiungevano nessuno). Il lucchetto non guarda il contenuto.

IL LUCCHETTO ATTRAVERSA LE GAMBE, E LO FA CON UN GETTONE. La rotta SHALL
restituire il gettone del lucchetto insieme a `pending`, e lo strumento SHALL
riportarlo a ogni gamba successiva; una gamba che lo porta rinnova il lucchetto,
una richiesta che non ce l'ha e trova la card occupata è rifiutata. Non c'è
altro che possa distinguerli: con un payload identico la seconda gamba di una
richiesta e una seconda richiesta hanno lo stesso digest, la stessa chiave e lo
stesso testo. Il lucchetto SHALL avere una SCADENZA (la gamba dichiarata più un
margine), perché una richiesta il cui processo muore fra due gambe terrebbe
altrimenti la card per sempre.

UNA RICHIESTA NON SHALL POSSEDERE UN ID CHE NON HA CREATO. Quando
l'instradamento restituisce l'id di una riga che questa richiesta non ha
scritto, la richiesta NON SHALL adottarlo: o ne crea uno suo, o viene rifiutata.
L'id che una richiesta può chiudere è solo quello che ha creato lei, e la
richiesta SHALL tenerne traccia esplicita attraverso le proprie gambe. La
finestra dove serve è reale: il lucchetto scade prima della voce nel registro
(che si tiene per due minuti di silenzio), e in quel buco una richiesta identica
si vedrebbe consegnare la riga di chi sta ancora aspettando.

UNA `ask_user_question` GENERICA NON SHALL UCCIDERE LA CONFERMA SOTTO DI SÉ. Il
rendez-vous è chiavato sulla SESSIONE e la seconda attesa sostituisce la prima,
per progetto; ma il bridge MCP non aspetta i suoi handler, quindi una domanda
generica e un invio della stessa sessione sono in volo insieme. Quando una
conferma d'invio della STESSA sessione sta aspettando, la gamba della domanda
generica SHALL spendere il suo tempo SENZA registrarsi sul rendez-vous e
rispondere `pending`: aspetta il suo turno senza togliere niente a nessuno.

Questa regola SHALL valere CON O SENZA CARD, ed è la stessa regola: fuori dalla
board la corsa era intatta. Il fatto «una conferma di questa sessione aspetta»
SHALL essere letto dal LUCCHETTO del cancello e NON dal registro delle domande
instradate — quel registro è chiavato sul TASK e in una chat non esiste, quindi
l'instradamento non risponde e la gamba si registrava lo stesso (riprodotto con
le rotte vere e senza card: il sì che la persona dava sul pannello dell'INVIO
veniva consegnato alla domanda generica, e l'invio tornava «superseded by a newer
question»). Il lucchetto la chiave giusta ce l'ha già: per una sessione senza
card è `session:<chiave>`.

Se chi occupa la card è un'altra sessione, il rendez-vous è un altro e non c'è
niente da temere: quella gamba SHALL registrarsi normalmente. Due sessioni dello
stesso task esistono per costruzione, e trattarle come una sola significa una
domanda che non raggiunge mai nessuno per tutto il tempo in cui l'altra tiene la
card.

I TASTI NON SHALL RESTARE SU UN BLOCCO MORTO. Quando la domanda di una richiesta
finisce senza che qualcuno abbia risposto NEL THREAD — scaduta, annullata,
sostituita, oppure risposta dal pannello della chat — il blocco SHALL essere
chiuso con una riga sua nel thread, cioè con una riga che il lettore che disegna
i tasti conta come parola: svuotare il registro e basta lascia un blocco di
risposte rapide che non risponde a nessuno, e la traccia del rifiuto accanto a
lui è una NOTA apposta, quindi non glieli toglie. E un clic su un blocco che non
aspetta più nessuno SHALL ricevere una risposta leggibile sulla card — non
SHALL diventare un commento qualunque e NON SHALL rimettere al lavoro l'agente:
misurato, la persona premeva «Conferma», non partiva niente, nessuno glielo
diceva, e la parola arrivava all'agente come un commento. Una frase scritta sotto
lo stesso blocco resta invece una nota: è il CONTENUTO che coincide con una delle
opzioni di quel blocco a dire che qualcuno ha premuto.

La domanda SHALL contenere il MESSAGGIO che sta per partire: mittente,
destinatario, oggetto e il corpo (tagliato a una lunghezza dichiarata, e il
taglio SHALL essere annunciato). Una conferma che mostra solo il destinatario e
un conteggio di caratteri è una firma su una busta chiusa, e la board dice già
la stessa cosa altrove: se chiedi «confermi X?», chi risponde deve poter vedere
X.

Gli ALLEGATI SHALL essere NOMINATI nella domanda, con nome e peso: un conteggio
(«Allegati: 1») non si può leggere, e il workspace di una card è l'intera
cartella del progetto, dove sta anche il database. Un file che nessuno ha visto
nominare è un file che nessuno poteva fermare.

La riga dello strumento su cui la domanda viene dipinta SHALL essere trovata
anche quando il tool è registrato col NOME NUDO: il runtime nativo pubblica gli
strumenti di Topics senza il prefisso della flotta, e su questa macchina è il
runtime della grande maggioranza dei topic. Un confronto esatto sul solo nome
prefissato significa nessuna riga, nessun pannello, e ogni invio in chat
rifiutato con «nessuno poteva confermare».

La ricerca di quella riga NON SHALL dipendere da una scrittura DIFFERITA. La
colonna che porta le chiamate di un turno moderno (`blocks`) passa da un
throttle che rimanda fra 1 e 15 secondi tutto ciò che non è la prima scrittura
del turno: un `send_mail` che non è il primo strumento del suo turno non è
ancora sulla riga quando il cancello la legge. Prima di leggere, il cancello
SHALL forzare la scrittura pendente del turno vivo. «Non ancora persistita» NON
SHALL essere trattata come «non c'è nessuno a cui chiedere»: quel rifiuto è
secco — lo strumento solleva sul rifiuto e non c'è una seconda gamba — e taglia
ogni invio che non sia il primo strumento del turno.

Il cancello SHALL considerare la domanda POSTA solo quando il commento è stato
scritto davvero. Il registro delle domande instradate è per TASK e non guarda il
testo: una voce lasciata da una domanda di un turno interrotto faceva uscire
l'instradamento SENZA scrivere niente, e il valore di ritorno veniva letto come
«chiesto». Una domanda nuova SHALL sostituire quella che trova solo
quando quella non aspetta più nessuno, e la sostituita SHALL essere chiusa con
una riga sua: un blocco di risposta rapida che cambia testo sotto gli occhi
senza dirlo è peggio del silenzio. «La stessa sessione sostituisce sempre» è
CADUTO e NON SHALL tornare: valeva finché una sessione poteva avere una domanda
sola in volo, e non può — due `send_mail` di un messaggio corrono insieme — e
per quella strada la seconda conferma si prendeva la card della prima. Chi
chiede non entra nella decisione: contano i due fatti di sopra (rendez-vous
aperto, e qualcuno che ripassa).

Se la risposta non arriva, o non è quella di consenso, NON SHALL partire niente
e lo strumento SHALL dirlo con la ragione.

IL CONFINE DI FIDUCIA È L'UTENTE DELLA MACCHINA, e questo delta NON SHALL
promettere di più. Il server e gli agenti girano sotto lo STESSO uid (misurato con `ps`: il
`bun run server.ts` e le CLI degli agenti hanno lo stesso utente), il canale che
risponde alla domanda è la rotta dei commenti della board, e su loopback
`evaluateIdentity` risponde `role: 'owner'` senza credenziali. Un processo che
gira come l'utente del server può quindi rispondere «Conferma» al posto della
persona — e nessuna credenziale locale lo impedisce, perché le legge tutte: il
token del daemon è un file 0600 di quell'utente e i token dei dispositivi stanno
nel DB, che è 0644. Ciò che la conferma garantisce è che niente esce senza una
decisione presa SU QUESTA MACCHINA e senza che ne resti la traccia sulla card;
non è una difesa contro un processo che è già dentro il confine.

#### Scenario: la persona legge cosa firma
- **GIVEN** una conferma di invio aperta
- **THEN** la domanda SHALL contenere il corpo del messaggio
- **AND** la traccia lasciata dopo NON SHALL contenerlo

#### Scenario: la persona legge cosa allega
- **GIVEN** una conferma di invio con un allegato
- **THEN** la domanda SHALL contenere il NOME del file, non solo quanti sono

#### Scenario: il tool è registrato col nome nudo
- **GIVEN** una riga che porta `send_mail` senza prefisso di flotta
- **THEN** la conferma SHALL essere dipinta su quella riga

#### Scenario: la persona non risponde
- **GIVEN** una conferma aperta e nessuna risposta
- **THEN** NON SHALL partire nessun processo
- **AND** lo strumento SHALL riportare che la conferma non è arrivata

#### Scenario: due messaggi di fila
- **GIVEN** un primo messaggio confermato e inviato
- **WHEN** l'agente ne manda un secondo
- **THEN** SHALL essere chiesta una NUOVA conferma

#### Scenario: una risposta che riguarda un'altra domanda
- **GIVEN** una risposta la cui chiave non è quella di questo messaggio
- **THEN** NON SHALL valere come consenso

#### Scenario: due conferme sulla stessa card
- **GIVEN** una conferma di invio già aperta e ancora in attesa di risposta
- **WHEN** un'altra sessione dello stesso task ne chiede una seconda
- **THEN** la seconda SHALL essere rifiutata con quella ragione
- **AND** la domanda sulla card SHALL restare quella della prima
- **AND** il sì SHALL far partire il PRIMO messaggio, non il secondo

#### Scenario: due conferme della STESSA sessione, in volo insieme
- **GIVEN** un invio in attesa di conferma sulla card
- **WHEN** la stessa sessione ne chiede un secondo mentre il primo aspetta
- **THEN** il secondo SHALL essere rifiutato con quella ragione
- **AND** la card SHALL portare UNA sola conferma, quella del primo messaggio
- **AND** il clic su quella conferma SHALL essere consegnato e far partire il
  primo messaggio, non il secondo

#### Scenario: due invii IDENTICI della stessa sessione, in volo insieme
- **GIVEN** un invio in attesa di conferma sulla card
- **WHEN** la stessa sessione ne chiede un secondo con lo STESSO contenuto
- **THEN** il secondo SHALL essere rifiutato con quella ragione
- **AND** la card SHALL portare UNA sola conferma e il registro SHALL nominarla
- **AND** il clic su di lei SHALL essere consegnato, e SHALL partire UN invio solo

#### Scenario: la gamba successiva della stessa richiesta
- **GIVEN** una gamba tornata `pending` col suo gettone
- **WHEN** la richiesta torna portando quel gettone
- **THEN** SHALL essere di nuovo `pending`, senza una seconda conferma sulla card
- **AND** una richiesta identica SENZA quel gettone SHALL essere rifiutata

#### Scenario: il lucchetto è scaduto ma la domanda è ancora sulla card
- **GIVEN** una conferma sulla card la cui richiesta sta ancora aspettando, e il
  lucchetto lasciato scadere
- **WHEN** arriva una richiesta identica
- **THEN** SHALL essere rifiutata invece di adottare quella riga
- **AND** la domanda viva SHALL restare esigibile dal suo clic

#### Scenario: una domanda generica mentre un invio aspetta
- **GIVEN** una conferma di invio in attesa sulla card
- **WHEN** la STESSA sessione apre una `ask_user_question` diversa
- **THEN** la domanda generica SHALL rispondere `pending` senza scrivere niente
- **AND** l'attesa dell'invio NON SHALL essere annullata, e il sì SHALL raggiungerla

#### Scenario: la conferma è stata risposta dal pannello della chat
- **GIVEN** una conferma uscita sulla card e risposta dal tab
- **THEN** il blocco sulla card SHALL essere chiuso da una riga sua
- **AND** il lettore che disegna i tasti NON SHALL trovare più una domanda

#### Scenario: qualcuno preme un blocco che non aspetta più nessuno
- **GIVEN** un blocco di risposte rapide senza più un rendez-vous dietro
- **WHEN** la persona ne preme un'opzione
- **THEN** la card SHALL scrivere che quel clic non è stato consegnato
- **AND** l'agente NON SHALL essere rimesso al lavoro da quella parola
- **AND** una frase scritta sotto lo stesso blocco SHALL restare un commento

#### Scenario: la traccia di un invio rifiutato non spegne la domanda viva
- **GIVEN** una conferma viva sulla card e un secondo invio rifiutato
- **THEN** la riga «Invio NON partito» SHALL essere scritta come NOTA
- **AND** la domanda sopra di lei SHALL restare da rispondere, coi suoi tasti

#### Scenario: la persona risponde a una domanda superata
- **GIVEN** una domanda sostituita e una risposta che nomina la riga vecchia
- **THEN** NON SHALL partire niente e la risposta SHALL restare una nota
- **AND** la card SHALL avere la riga che lo dice
- **AND** la domanda aperta SHALL restare aperta

#### Scenario: la riga dello strumento non è ancora stata scritta
- **GIVEN** un invio che non è il primo strumento del suo turno, con la
  scrittura dei blocchi ancora in attesa del throttle
- **THEN** la domanda SHALL essere dipinta lo stesso
- **AND** l'invio NON SHALL essere rifiutato con «nessuno poteva confermare»

#### Scenario: nel registro c'è una domanda di un turno interrotto
- **GIVEN** una voce lasciata da un `ask_user_question` mai risposto sulla
  stessa sessione
- **THEN** la domanda sull'invio SHALL comparire sulla card
- **AND** quella vecchia SHALL essere chiusa con una riga che lo dice

### Requirement: OUTBOUND-04 — `send_mail` e `google_call` sono strumenti dell'agente

Il server MCP di Topics SHALL pubblicare `send_mail` (destinatario, oggetto,
corpo, account fra quelli dichiarati, allegati presi dal workspace della card) e
`google_call` (servizio, risorsa, sotto-risorsa, metodo, `params` e `body` come
JSON).

Gli allegati SHALL essere risolti DENTRO il workspace della sessione: un percorso
che esce dalla cartella SHALL essere rifiutato. Il contenimento SHALL essere
deciso sul percorso REALE, con i link simbolici gia' risolti (sia del candidato
sia del workspace): `resolve()` normalizza `../` e NON segue un link, e un
agente che ha una shell nella propria worktree scrive `ln -s <segreto> allegato`
in un comando.

LA CONFERMA SHALL VINCOLARE I BYTE, NON IL NOME. Risolvere il percorso congela
una stringa, e fra la domanda e lo spawn c'è l'attesa della persona: nello
stesso workspace l'agente sostituisce il file (o lo ripunta a un link) e parte
altro, con la persona che ha letto «preventivo.pdf (9 B)». Al momento della
domanda gli allegati SHALL essere LETTI e copiati in una cartella di appoggio
del server (0700, fuori da ogni workspace), e ciò che viene passato alla CLI
SHALL essere quella copia. La domanda SHALL portare nome, peso e l'impronta
(sha256, in forma breve) dei byte congelati, e l'identità del messaggio SHALL
comprendere quell'impronta: byte diversi sono un messaggio diverso, quindi una
domanda nuova, non un sì ereditato. Le copie SHALL essere cancellate quando
l'invio finisce, e quelle che nessuno ha più chiuso SHALL scadere.

QUELLA CARTELLA NON È FUORI PORTATA DELL'AGENTE, e il delta NON SHALL dirlo:
l'agente gira sotto lo stesso uid del server, quindi 0700 tiene fuori gli ALTRI
utenti e non lui (vedi il confine nominato in OUTBOUND-03). Riprodotte due
strade, e ognuna SHALL essere chiusa per quello che è:

- il NOME della cartella NON SHALL essere derivabile dal contenuto né dalla
  sessione. Derivandolo, l'agente lo calcolava e ci piantava dentro la propria
  copia PRIMA di chiamare lo strumento: nessuna corsa, nessun tempismo. Il nome
  SHALL venire da `mkdtemp` e il riuso fra le gambe SHALL passare da una mappa
  in memoria;
- ogni copia SHALL essere creata con `O_EXCL`: un file già presente a quel
  percorso è un attacco, non una gamba precedente. `if (!existsSync) write` lo
  consegnava intatto;
- dopo il sì e PRIMA dello spawn le copie SHALL essere rilette e ri-hashate, e
  un'impronta diversa SHALL fermare l'invio con la sua riga sulla card. La
  finestra da chiudere è l'attesa della persona, che dura minuti.

LA FINESTRA CHE RESTA SI DICE COL SUO NUMERO, e questo delta NON SHALL chiamarla
«microsecondi» né dire che il percorso è segreto. Fra quella rilettura e la
`open` della CLI ci sono un `resolveCliPath`, un `Bun.spawn` e un avvio di
processo intero: riprodotta 1 volta su 1 con i tempi veri e 3 su 4 senza nessun
ritardo simulato, e il percorso non si indovina — si ELENCA, cosa che costa
niente a chi gira come questo utente. La chiusura naturale (aprire la copia,
scollegarla e passare al figlio `/dev/fd/N`) è stata MISURATA contro la CLI vera
il 2026-09-16 (`gws` 0.22.5, `gmail +send --dry-run`, nessun invio) e NON regge,
due volte e per due ragioni diverse. Col figlio nella cartella delle copie,
`--attach /dev/fd/3` torna «--attach '/dev/fd/3' resolves to '/dev/fd/3' which
is outside the current directory» (400, `validationError`) — identico col file
già scollegato, che è lo stato che il trucco richiede: su macOS `/dev/fd/3` non
ha link da seguire, canonicalizza a sé stesso e non sta dentro nessuna cartella
di lavoro. Col figlio dentro `/dev/fd`, `--attach 3` supera il contenimento e si
ferma subito dopo: «Cannot read --attach '3': Bad file descriptor (os error 9)»,
col descrittore dimostrabilmente ereditato. Il descrittore alla CLI non arriva,
e una forma su stdin non c'è. Quindi la copia tiene un nome, e ciò che questo
delta promette è solo ciò che il codice fa: la finestra passa dai minuti della lettura a un avvio di
processo, e ciò che cambia IN quei minuti ferma l'invio. Il confine resta quello
di OUTBOUND-03: un processo che gira come l'utente del server chiama la CLI da
sé, e nessuna conferma dentro Topics glielo impedisce.

IL FIGLIO SHALL GIRARE DOVE STANNO LE COPIE. La CLI di Google rifiuta un
`--attach` che risolve FUORI dalla cartella corrente (misurato, stesso comando
di sopra: 400 `validationError`), e le copie congelate stanno sotto `~/.topics`
mentre il server gira dove l'ha avviato launchd: senza dichiarare la cartella di
lavoro del processo figlio, nessun allegato confermato sarebbe mai partito
davvero.

IL TETTO SHALL ESSERE MISURATO PRIMA DI LEGGERE. Il totale degli allegati SHALL
avere un limite dichiarato — oltre a quello che una casella accetta l'invio non
sarebbe comunque arrivato — e la decisione SHALL essere presa sulla `stat`: un
allegato da 64 MB rifiutato DOPO la lettura costa 64 MB di RSS al server
(misurato), cioè esattamente il guasto che il tetto esiste per impedire.
Un allegato che non è un FILE REGOLARE SHALL essere rifiutato: leggere una FIFO
non ritorna finché nessuno ci scrive, e `mkfifo report.csv` in una worktree è un
comando — misurato, ha congelato l'intero event loop del server (non la
richiesta) prima che a qualcuno fosse chiesto alcunché. La copia SHALL avvenire
a blocchi: il tetto limita ciò che può partire, i blocchi limitano ciò che sta
in RAM mentre parte.

Le chiamate Google che LEGGONO (`list`, `get`, e simili) NON SHALL chiedere
conferma; quelle che SCRIVONO SHALL chiederla, e un metodo che non si sa
classificare SHALL contare come scrittura. `watch` SHALL contare come
SCRITTURA: sembra un osservatore e non lo è, crea un'iscrizione push che
sopravvive alla chiamata.

`google_call` NON SHALL essere una seconda porta della posta, e un ELENCO da
solo NON BASTA a impedirlo. I quattro campi (servizio, risorsa, sotto-risorsa,
metodo) diventano argv della CLI, quindi SHALL essere NOMI di API — lettere,
cifre, punto, underscore. Senza questa regola l'elenco si aggira in due modi,
entrambi riprodotti: gli helper della CLI che spedisce (`+send`, `+reply`,
`+reply-all`, `+forward`, che non sono percorsi d'API e quindi non erano
nell'insieme; `+forward` inoltra un messaggio qualunque della casella, allegati
compresi, a un destinatario arbitrario) e i campi che cominciano con un trattino,
che arrivano alla CLI come FLAG.

Le chiamate di Gmail che SPEDISCONO (`users messages send`, `users drafts send`,
le loro forme brevi e i quattro helper) SHALL comunque essere rifiutate con un
errore che rimanda a `send_mail`: è un secondo strato e una risposta migliore
per chi chiama, non la recinzione. Il confronto SHALL ignorare maiuscole e
spazi. Un atto ha una porta sola, e quella che sa mostrare il messaggio esiste
già.

Ogni chiamata che scrive SHALL essere riassunta in una forma LEGGIBILE. Se il
corpo porta un campo `raw` in base64 SHALL essere decodificato e mostrato come
mittente, destinatario, oggetto e testo; nessun campo SHALL essere troncato
senza che il taglio sia annunciato. `body: {"userId":"me","raw":"Rnjvbto..."}`
tagliato a 300 caratteri è la stessa busta chiusa che OUTBOUND-03 vieta.

Entrambi gli strumenti SHALL attendere la persona a GAMBE CORTE, come
`ask_user_question`: una richiesta HTTP tenuta aperta a zero byte muore per
timeout di socket dal lato del client.

#### Scenario: un metodo sconosciuto
- **GIVEN** `google_call` con un metodo che non è nell'elenco dei letti
- **THEN** SHALL chiedere conferma prima di eseguirlo

#### Scenario: un allegato fuori dal workspace
- **GIVEN** un allegato che risolve fuori dalla cartella della sessione
- **THEN** SHALL essere rifiutato e NON SHALL partire nessun invio

#### Scenario: un allegato che e' un LINK verso l'esterno
- **GIVEN** dentro il workspace un link simbolico a un file fuori dal workspace
- **THEN** SHALL essere rifiutato e NON SHALL aprire nessuna conferma

#### Scenario: l'allegato cambia mentre la persona legge
- **GIVEN** un allegato confermato e, durante l'attesa, lo stesso nome che punta
  a un altro contenuto
- **THEN** SHALL partire il contenuto che la persona ha visto nominare e pesare
- **AND** il percorso passato alla CLI NON SHALL essere quello del workspace

#### Scenario: la copia e' gia' li' prima della chiamata
- **GIVEN** un file piantato al percorso di appoggio che la sessione userebbe
- **THEN** SHALL partire il contenuto letto dal workspace, non quello piantato

#### Scenario: l'allegato arriva dentro la cartella di lavoro del figlio
- **GIVEN** un invio confermato con un allegato
- **THEN** il percorso passato alla CLI SHALL essere dentro la cartella di
  lavoro del processo figlio

#### Scenario: la copia viene riscritta durante l'attesa
- **GIVEN** una copia congelata modificata dopo la domanda
- **THEN** l'invio SHALL essere rifiutato e NON SHALL partire nessun processo
- **AND** la card SHALL avere la riga che lo dice

#### Scenario: un allegato che non e' un file regolare
- **GIVEN** una FIFO al posto dell'allegato
- **THEN** SHALL essere rifiutata senza fermare il server

#### Scenario: un allegato oltre il tetto
- **GIVEN** un allegato piu' grande del tetto dichiarato
- **THEN** SHALL essere rifiutato senza essere stato letto

#### Scenario: una chiamata Google che spedisce
- **GIVEN** `google_call` con `gmail users messages send`
- **THEN** SHALL essere rifiutata rimandando a `send_mail`
- **AND** NON SHALL aprire nessuna conferma e NON SHALL eseguire niente

#### Scenario: un helper della CLI che spedisce
- **GIVEN** `google_call` con `gmail +forward` e i suoi flag nei campi liberi
- **THEN** SHALL essere rifiutata rimandando a `send_mail`

#### Scenario: un campo che e' un flag
- **GIVEN** un campo che comincia con un trattino su una chiamata che legge
- **THEN** SHALL essere rifiutata e NON SHALL eseguire niente

#### Scenario: una scrittura Google che porta un messaggio
- **GIVEN** una scrittura Google il cui corpo contiene un `raw` in base64
- **THEN** la domanda SHALL mostrare destinatario, oggetto e testo in chiaro

#### Scenario: una risposta del server non si ri-manda
- **GIVEN** una gamba a cui il server risponde con un errore (400, 502)
- **THEN** lo strumento SHALL riportare QUELL'errore all'agente
- **AND** NON SHALL ripetere la richiesta: solo una richiesta che non e' mai
  arrivata SHALL essere ritentata, perche' una seconda POST che il server
  riceve, dopo la conferma, e' un secondo messaggio

### Requirement: OUTBOUND-05 — Ciò che esce dalla macchina lascia una traccia sulla card

Ogni invio riuscito e ogni scrittura Google riuscita SHALL lasciare un commento
di servizio nel thread della card che li ha prodotti: chi (l'account), cosa (lo
strumento e l'oggetto o la chiamata), a chi (il destinatario o la risorsa) e
l'esito. Il commento NON SHALL contenere il corpo intero del messaggio.

Anche un tentativo RIFIUTATO dalla persona o FALLITO SHALL lasciare la sua riga:
una decisione che ferma un invio è un fatto della card quanto l'invio. Vale
anche per un fallimento DOPO il sì che non sia la CLI (un eseguibile che la
variabile non trova più): la persona ha confermato e niente è partito, e senza
quella riga l'unica memoria di un invio rotto è il messaggio dell'agente.

Quando una scrittura Google porta un MESSAGGIO, la traccia SHALL nominare
destinatario e oggetto: «scrittura eseguita» con il solo metodo dice che
qualcosa è partito e niente su cosa.

Una sessione che non appartiene a nessuna card NON SHALL fallire per questo: la
traccia è il risultato dello strumento nella chat.

#### Scenario: confermato e non partito
- **GIVEN** un invio confermato e un eseguibile che non si trova
- **THEN** SHALL comparire un commento che dice FALLITO e nomina la variabile

#### Scenario: invio riuscito da una card
- **GIVEN** una sessione che appartiene a un task
- **WHEN** l'invio riesce
- **THEN** SHALL comparire un commento con account, destinatario, oggetto ed esito
- **AND** NON SHALL contenere il corpo del messaggio
