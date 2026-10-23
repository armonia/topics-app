## Purpose

I cancelli che tengono in piedi il resto: come si prova che mordono, quando
devono tacere, e perché «verde» e «non ho misurato» non possono essere lo stesso
esito.

## Background

UN CANCELLO VALE QUALCOSA SOLO UNA VOLTA CHE LO SI È VISTO ROSSO. È la regola che
governa questo intero gruppo: ogni cancello ha un banco che gli costruisce
davanti il difetto che dovrebbe fermare, lancia lo SCRIPT VERO, e pretende
l'uscita non-zero — che è la cosa che ferma davvero l'integrazione.

E UN CRICCHETTO VALE QUANTO LA SUA LISTA. Uno di questi stampava «manca, salto»
sull'uscita di diagnostica e usciva comunque ZERO: rinominare uno dei sei file
sorvegliati lasciava il verde su cinque, mentre la riga di riepilogo continuava a
dichiararne sei.

TERZA REGOLA, LA PIÙ COSTOSA DA IMPARARE: «non ho potuto misurare» NON è verde.
Un cancello che non ha girato — perché mancava uno strumento, perché la macchina
non consegnava fotogrammi, perché il testimone non c'era — SHALL uscire con un
terzo esito, distinto sia dal verde sia dal rosso.

## Requirements

### Requirement: GATE-01 — Ogni cancello si prova ROSSO sullo script vero, non sulle sue funzioni

Ogni cancello SHALL avere un banco che costruisce il difetto che deve fermare,
lancia lo SCRIPT REALE e pretende il CODICE DI USCITA non-zero. Provare le
funzioni esportate e non l'uscita del processo lascia scoperto proprio ciò che
ferma l'integrazione.

Il messaggio SHALL NOMINARE il colpevole — il file, e dove è possibile la riga:
un rosso che non dice dove non si può riparare.

Un albero PULITO SHALL uscire ZERO: un cancello che accusa sempre viene spento
come uno che non accusa mai.

Un argomento SCONOSCIUTO SHALL essere un errore dichiarato, non un giro a vuoto
che finisce verde.

#### Scenario: il difetto costruito apposta
- **GIVEN** un albero che contiene ciò che il cancello deve fermare
- **THEN** lo script SHALL uscire non-zero, nominando il file

#### Scenario: un albero pulito
- **GIVEN** nessun difetto
- **THEN** lo script SHALL uscire zero

### Requirement: GATE-02 — Un cricchetto vale quanto la sua lista, e la lista stantia si vede ROSSA

Un file SORVEGLIATO che NON ESISTE PIÙ SHALL far fallire il cancello, NON SHALL
essere saltato. Saltarlo stampando una nota sull'uscita di diagnostica e uscire
zero è come cinque file su sei restano scoperti mentre il riepilogo ne dichiara
sei.

La riga di esito SHALL contare i file DAVVERO esaminati, non quelli in elenco.

Un file già nella linea di partenza SHALL restare verde; lo STESSO file
CRESCIUTO oltre il proprio tetto SHALL diventare rosso, e il tetto SHALL essere
DICHIARATO. Una crescita dentro la tolleranza SHALL essere ammessa. Un file che
la linea di partenza non ha mai visto SHALL essere un colpevole NUOVO.

Un file GUARITO SHALL essere SEGNALATO e NON SHALL MAI far fallire il cancello:
migliorare non si punisce.

Il riconoscimento delle copie SHALL guardare al CODICE: un commento ricopiato
non è una copia, e una sequenza di sole parentesi di chiusura nemmeno. Una copia
RE-INDENTATA SHALL restare una copia.

#### Scenario: un file sorvegliato rinominato
- **GIVEN** un percorso in elenco che non esiste più
- **THEN** il cancello SHALL fallire, non saltarlo

#### Scenario: un file guarito
- **GIVEN** un file sceso sotto il proprio tetto
- **THEN** SHALL essere segnalato senza far fallire il cancello

### Requirement: GATE-03 — Il riconoscitore della lingua sbaglia in DUE modi, e vanno provati entrambi

Il riconoscimento della lingua SHALL essere provato sia sui FALSI NEGATIVI —
testo che è nella lingua sbagliata e non viene visto — sia sui FALSI POSITIVI:
nomi di classi grafiche, chiavi, indirizzi e parole comuni alle due lingue NON
SHALL essere contati.

Un cricchetto sulla lingua vale quanto il numero sotto di sé: se l'estrattore
chiama «commento» qualcosa che non lo è, il numero non significa ciò che dichiara.

Per gli IDENTIFICATORI il riconoscimento per parole comuni NON basta: un nome
corto nella lingua sbagliata non contiene nessuna di quelle parole, e la
riparazione ovvia — allargare l'elenco — non l'avrebbe preso.

Per la conta di ciò che MANCA da tradurre, l'errore che fa danno è quello per
DIFETTO: non contare una stringa che una persona legge dichiara finita una
migrazione che non lo è.

I NOMI degli strumenti SHALL stare in UNA lingua sola, e il cancello che lo
impone SHALL essere provato su sé stesso.

#### Scenario: un nome di classe grafica
- **GIVEN** testo che somiglia alla lingua sorvegliata ma è una classe
- **THEN** NON SHALL essere contato

#### Scenario: un identificatore corto nella lingua sbagliata
- **GIVEN** un nome che non contiene nessuna parola comune
- **THEN** SHALL essere riconosciuto lo stesso

### Requirement: GATE-BUNDLE-FRESH-01 — Un cancello che misura una CARTELLA rifiuta di certificarne una vecchia

I budget del pacchetto si leggono da `public/`, non dai sorgenti. Quindi
lanciare quel cancello senza aver ricostruito misura ciò che è stato compilato
l'ultima volta e NON DICE NIENTE sul codice che c'è nell'albero — pur uscendo
verde, con dei numeri sopra.

Non è un rischio teorico: il lavoro che ricostruisce `public/` a ogni salvataggio
è spento dal 04/08/2026, quindi quella cartella si muove solo se qualcuno digita
il comando. Il 25/08 le due misure differivano di 309 byte per puro caso — quel
giro era quasi tutto lato server; un giro a maggioranza client avrebbe dato un
verdetto sulla build sbagliata. L'unica traccia del pericolo era prosa dentro un
file di riferimento: un avvertimento che si legge solo se apri il file giusto,
cioè esattamente il fallimento che descrive.

Prima di misurare, il cancello SHALL confrontare l'età della cartella costruita
con quella dei SORGENTI, e SHALL RIFIUTARE di proseguire quando la costruzione è
più vecchia.

Il rifiuto SHALL essere il TERZO ESITO di [[GATE-04]], non un fallimento: un
pacchetto stantio non è un pacchetto fuori budget. Il messaggio SHALL NOMINARE
entrambi gli istanti e il comando che ricostruisce — un rifiuto che non dice
come uscirne insegna a rilanciare a caso.

Il confronto SHALL usare l'età dei FILE, non la data dell'ultimo commit: le
modifiche non ancora committate sono il caso locale più comune, ed è
precisamente quello che un confronto sui commit non vede.

#### Scenario: sorgenti più recenti del pacchetto
- **GIVEN** una costruzione più vecchia di un file sorgente
- **THEN** il cancello SHALL rifiutare col terzo esito, senza misurare niente

#### Scenario: pacchetto appena costruito
- **GIVEN** una costruzione più recente di ogni sorgente
- **THEN** il cancello SHALL misurare i budget normalmente

### Requirement: GATE-04 — «Non ho misurato» è un TERZO esito, mai verde

Un cancello che non ha potuto girare — strumento assente, misura assente, linea
di partenza mai registrata, forma del dato sbagliata — SHALL uscire con un
esito DISTINTO dal verde e dal rosso.

Un errore di AVVIO dello strumento NON SHALL essere ignorato: uno strumento
lanciato e mai partito produce zero rilievi, che letti come «nessun problema»
sono la bugia più tranquilla che un cancello possa dire.

Una misura PIÙ VECCHIA della corsa che avrebbe dovuto produrla SHALL essere
RIFIUTATA, e l'assenza dell'istante NON SHALL spegnere il controllo di
freschezza.

Un TESTIMONE ASSENTE SHALL valere come ACCUSA, non come silenzio; un testimone a
ZERO SHALL restare un impedimento.

Un dato strutturalmente valido ma di FORMA SBAGLIATA SHALL essere rifiutato.

Un IMPEDIMENTO SHALL avere la precedenza su uno SFORO: il rosso su una misura che
non vale non è un rosso, e riportarlo come tale manda a inseguire un guasto che
non c'è.

Un cancello che non ha NIENTE da misurare SHALL uscire con l'esito
dell'impedimento, non con lo zero.

#### Scenario: lo strumento non parte
- **GIVEN** un cancello il cui strumento non si avvia
- **THEN** SHALL uscire con l'esito dell'impedimento, non zero

#### Scenario: un impedimento e uno sforo insieme
- **GIVEN** entrambi presenti
- **THEN** SHALL essere riportato prima l'impedimento

### Requirement: GATE-05 — Un cancello di misura dichiara la POSA, e non si allarga da solo

Un cancello che misura tempi o fotogrammi SHALL stampare TUTTE le proprie
metriche anche quando sono verdi: un numero che si vede solo quando è rosso non
si può seguire nel tempo.

SHALL diventare rosso su OGNI metrica PRESA DA SOLA — la mediana alta, il caso
peggiore che una percentuale nasconde, e la causa sottostante — perché ognuna
descrive un difetto che le altre non vedono.

La MACCHINA fa parte della posa: una macchina che disegna a una cadenza più bassa
NON SHALL essere giudicata contro un budget scritto per una più alta, ma una
macchina che ha MARGINE SHALL essere giudicata lo stesso, o il cancello non
protegge niente. Una cadenza solo un po' diversa SHALL continuare a essere
giudicata: un gradino troppo largo nasconde un rallentamento di tre volte.

Il budget NON SHALL allargarsi da solo su una macchina lenta, NON SHALL MAI
essere scritto a ZERO da una misura di zero, e SHALL mantenere un PAVIMENTO anche
su una macchina molto veloce. Sopra il pavimento SHALL seguire la misura.

Il valore ESATTAMENTE uguale al budget SHALL passare, quello appena sopra no.

Un banco che non ha ESERCITATO ciò che dice di misurare — una lista vuota, un
trascinamento che non è atterrato, una virtualizzazione che non ha montato niente
— SHALL essere RIFIUTATO: è veloce per tutti.

Una linea di partenza MAI REGISTRATA SHALL produrre l'esito dell'impedimento per
quanto buoni siano i numeri, e SHALL essere giudicata normalmente una volta
registrata.

Un rumore piccolo NON SHALL essere una notizia; un raddoppio SHALL esserlo anche
su pochi millisecondi. Due passate LONTANE nel tempo SHALL fermare il giudizio
invece di accusare qualcuno, e due passate simili SHALL essere confrontabili. Una
misura presa su un corpus quasi vuoto NON SHALL essere confrontata con una presa
su uno pieno.

Una macchina globalmente lenta SHALL produrre l'impedimento, non l'accusa. Un
guasto COSTANTE SHALL essere distinto dall'instabilità: due passate che
concordano non sono rumore.

Una linea di partenza ILLEGGIBILE SHALL essere DENUNCIATA, non saltata, e un
numero scritto come testo NON SHALL spegnere in silenzio la voce che descrive.

#### Scenario: una macchina più lenta della linea di partenza
- **GIVEN** una cadenza troppo bassa per il budget
- **THEN** SHALL essere dichiarato non misurabile

#### Scenario: il caso peggiore
- **GIVEN** una mediana buona e un solo fotogramma pessimo
- **THEN** SHALL essere rosso

### Requirement: GATE-06 — Il cancello dei segreti guarda quattro cose, e un pezzo che non sa misurare esce con l'impedimento

Il cancello dei segreti SHALL diventare rosso su: una chiave riconoscibile in un
file tracciato, una chiave privata, una parola d'ordine ad alta entropia dentro
un indirizzo, e un valore ad alta entropia assegnato a un nome che dichiara di
essere un segreto — mentre un SEGNAPOSTO evidente NON SHALL far scattare niente.

Un file di ambiente TRACCIATO SHALL essere rosso ANCHE SE VUOTO: il difetto è che
sia tracciato, non cosa contiene oggi.

L'esenzione di una riga SHALL richiedere una RAGIONE scritta: senza ragione NON
SHALL spegnere niente. Un'esenzione senza motivo è un'esenzione che nessuno può
rivedere.

Il cancello SHALL coprire anche i DATI PERSONALI in file tracciati e il PERCORSO
della cartella personale, e SHALL dichiarare rossi gli avvisi delle dipendenze
NON presenti nella linea di partenza.

Un pezzo del cancello che NON SA misurare NON SHALL stampare verde: SHALL uscire
con l'esito dell'impedimento.

#### Scenario: un file di ambiente vuoto ma tracciato
- **GIVEN** un file di ambiente senza contenuto, tracciato
- **THEN** SHALL essere rosso

#### Scenario: un'esenzione senza ragione
- **GIVEN** una riga esentata senza motivo scritto
- **THEN** l'esenzione NON SHALL avere effetto

### Requirement: GATE-07 — Niente di PERSONALE in un file tracciato, e ciò che è già pubblico non si redige

Nessun file tracciato SHALL contenere il percorso della cartella personale di chi
lavora al repository, il nome utente che quel percorso rivela, o il dato
personale di un TERZO — un cliente, una ragione sociale, una persona che non ha
scelto di comparire qui. Sono già rientrati: decine di percorsi in file di
misura, e un indirizzo reale dentro una migration — trovato da una spec, non da
un cancello.

L'identità dell'AUTORE del repository NON SHALL essere trattata come un dato da
redigere. La premessa che lo chiedeva — «i commit sono firmati da un autore
anonimo, quindi il nome nei sorgenti è una contraddizione» — è stata MISURATA
falsa il 2026-09-02: l'autore è la persona reale in 310 degli ultimi 400 commit,
già su `origin/main`. Togliere quel nome dai commenti non lo toglie dagli SHA né
dalla pagina dei contributor: il cancello produrrebbe solo rosso senza rischio
corrispondente, che è il modo più rapido in cui un cancello viene spento da chi
lo subisce.

I termini di terzi SHALL essere DICHIARATI in un elenco NON tracciato, mai
scritti dentro il repository che devono proteggere, e letti da UN SOLO modulo:
tre parser dello stesso file divergono al primo cambio di sintassi, e uno che
diverge in silenzio è cieco. Un elenco assente SHALL significare «niente da
cercare qui», MAI «pulito».

Il nome SHALL essere cercato in OGNI grafia in cui compare, compresa quella
codificata per un indirizzo e quella usata negli identificativi di cartella.

L'utente di una macchina di costruzione NON SHALL essere trattato come il nome di
una persona, o decine di file legittimi diventerebbero rossi.

Il PREDICATO SHALL essere visto MORDERE: un dato di terzi preso, il nome
dell'autore lasciato stare, un indirizzo di ruolo lasciato stare.

Ogni esenzione SHALL portare scritta la propria RAGIONE.

Il cancello che protegge la pubblicazione SHALL guardare ciò che il push
AGGIUNGE — contenuto E messaggi di commit — e SOLO verso i remoti configurati: un
nome che sta in un ramo locale NON è una fuga, e un riferimento a un remoto che
non esiste più NON pubblica niente. Senza l'elenco dei nomi SHALL uscire con un
errore invece di fingere di aver guardato.

Ogni elenco esaminato SHALL essere verificato NON VUOTO: un cancello che misura
zero file è verde e cieco.

#### Scenario: un nome solo nel messaggio di un commit
- **GIVEN** contenuto pulito e un messaggio che porta il nome
- **THEN** il push SHALL essere bloccato

#### Scenario: un ramo puramente locale
- **GIVEN** un nome presente solo su un ramo mai pubblicato
- **THEN** NON SHALL essere trattato come una fuga

### Requirement: GATE-08 — Nessun CICLO fra moduli, nessun tipo SPECCHIATO, nessun byte invisibile

I moduli NON SHALL formare CICLI di importazione oltre a quelli DICHIARATI, e
ogni deroga dichiarata SHALL corrispondere a un ciclo che esiste ancora: nessuna
eccezione fossile.

Un tipo NON SHALL essere dichiarato DUE volte, una per lato: gli specchi
divergono in silenzio — campi mai arrivati al client, una modifica costruita da
un tipo incompleto che azzera ciò che non conosce, uno schema che accetta valori
che l'originale rifiuta. Ogni eccezione SHALL spiegare PERCHÉ.

Nessun sorgente SHALL contenere un byte NULLO: non si vede e non si trova — la
ricerca testuale salta l'intero file come binario, e dentro una stringa produce
un confronto che fallisce fra due valori stampati identici. Lo scanner SHALL
guardare solo i file di TESTO, e SHALL essere visto trovarne uno davvero.

Il budget dei tipi non specificati SHALL contare solo quelli scritti in CODICE:
non dentro una parola, non nei commenti, non dentro una stringa di prosa — un
cancello NATO rosso per una parola inglese in una descrizione è un cancello che
verrà spento. Uno con la sua RAGIONE scritta NON SHALL contare. Il tetto SHALL
coincidere con la misura di oggi.

#### Scenario: un tipo dichiarato su entrambi i lati
- **GIVEN** lo stesso tipo in client e in server
- **THEN** il banco SHALL fallire, salvo eccezione motivata

#### Scenario: la parola dentro una stringa di prosa
- **GIVEN** un testo che contiene la parola
- **THEN** NON SHALL essere contata

### Requirement: GATE-09 — Un banco non eredita la macchina di chi lo lancia

Nessun banco SHALL dichiarare un percorso FISSO nella cartella temporanea
condivisa: misurato, tre corse in parallelo producevano decine di rossi per
lucchetti contesi, tutti verdi presi da soli.

Ogni banco che lancia il sistema di versione SHALL passare un AMBIENTE proprio,
che disattiva i ganci della macchina e la firma: su questa macchina un gancio di
terze parti chiamava la rete a ogni commit — misurato, più del doppio del tempo
per commit, e sotto carico il superamento del tempo massimo. Il rilevatore SHALL
essere visto dire di NO su una chiamata senza ambiente e di sì sulle varianti
corrette. Il caricamento globale da solo NON BASTA: senza ambiente esplicito
l'isolamento si perde, e il banco SHALL dirlo.

Nessun banco SHALL leggere un file che esiste sul disco locale ma NON è
tracciato: su un clone pulito quel file non c'è, e il rosso arriva dove nessuno
lo collega — misurato, oltre cento commit senza un pacchetto di rilascio.

L'estrattore SHALL riconoscere la forma che ha rotto la verifica, ed escludere i
falsi positivi già noti.

#### Scenario: un percorso fisso nella cartella temporanea
- **GIVEN** un banco che lo dichiara
- **THEN** il cancello SHALL fallire

#### Scenario: un file non tracciato letto da un banco
- **GIVEN** un file presente in locale e assente dal repository
- **THEN** il cancello SHALL fallire

### Requirement: GATE-10 — Ogni cancello è CABLATO, e ciò che è un referto non è un cancello

OGNI cancello SHALL essere eseguito da qualcuno, o SHALL avere scritta la ragione
per cui non lo è: un elenco tenuto a mano si è scollato subito, e tre cancelli
non giravano da nessuna parte.

Nessuna ragione dichiarata SHALL essere SCADUTA.

Un REFERTO — qualcosa che misura e racconta — NON SHALL entrare in un flusso di
verifica: uno di essi leggeva lo stato di una bacheca da un file che su un clone
pulito non esiste, e usciva con un errore senza guardare niente. La distinzione
SHALL stare nel NOME, non nella memoria di chi lo ha scritto.

Il riconoscimento SHALL rispettare i CONFINI di parola — un nome che è prefisso di
un altro NON è quell'altro — e SHALL distinguere la DEFINIZIONE dall'INVOCAZIONE.

Il cancello sul codice morto SHALL sapere DOVE è CIECO: un modulo importato in
modo opaco lo rende invisibile, e senza dirlo il verde non significa niente. Ogni
punto cieco noto SHALL puntare a un file che esiste ancora e SHALL avere un
motivo scritto; nessuna sonda SHALL restare dimenticata in un file tracciato.

La BARRA locale — l'unico comando che un umano lancia per sapere «e' verde?» —
NON SHALL essere un sottoinsieme dei cancelli STATICI su cui l'integrazione
blocca: dire «verde» dove la CI dira' rosso e' la stessa bugia di un cancello che
non gira, servita a chi sta per consegnare. Ogni esclusione SHALL essere scritta
NEL file della barra, non altrove: un'esclusione argomentata solo nel banco e'
indistinguibile da una dimenticanza per chi legge la barra.

#### Scenario: un cancello nuovo mai cablato
- **GIVEN** uno script di verifica che nessun flusso esegue
- **THEN** il banco SHALL fallire

#### Scenario: un referto messo in un flusso
- **GIVEN** uno script che misura e racconta
- **THEN** NON SHALL comparire in un flusso di verifica

#### Scenario: un cancello statico che la CI blocca e la barra non esegue
- **GIVEN** un `check:*` invocato da `.github/workflows/ci.yml`
- **AND** assente dalla lista che `scripts/qa-gate.sh` esegue
- **THEN** il banco SHALL fallire, a meno che la barra non ne scriva il motivo

### Requirement: SLOT-01 — Il semaforo dei cancelli esclude davvero, e non può MAI rifiutarsi di eseguire

Questo involucro sta davanti a OGNI cancello costoso, quindi un difetto qui è un
difetto in tutti i cancelli insieme, e in ogni turno che ne esegue uno. Le due
cose da tenere ferme sono OPPOSTE.

**Il comando gira SEMPRE.** L'output SHALL passare, un successo SHALL restare un
successo, e il codice di uscita SHALL essere QUELLO DEL COMANDO. Con la
strozzatura SPENTA SHALL girare lo stesso. Un file di slot rotto NON SHALL poter
fermare un comando.

**E la strozzatura esclude DAVVERO**, o è decorazione: uno slot SHALL significare
uno alla volta, non due; due slot SHALL lasciarne passare due insieme; e lo slot
SHALL tornare libero quando il comando ha finito.

Uno slot tenuto da un processo MORTO NON SHALL essere uno slot: SHALL essere
raccolto.

Un comando APPESO SHALL essere abbattuto: oltre il tetto di tempo da parete
SHALL uscire con il codice dedicato invece di restare appeso, SHALL portarsi via
i propri figli, e lo slot SHALL tornare libero ANCHE in quel caso. Un comando che
finisce in tempo NON SHALL essere toccato, e il tetto SHALL potersi spegnere.

#### Scenario: uno slot di un processo morto
- **GIVEN** un file di slot che nomina un processo non più vivo
- **THEN** SHALL essere raccolto, e il comando SHALL partire

#### Scenario: un comando appeso
- **GIVEN** un comando che supera il tetto di tempo
- **THEN** SHALL essere abbattuto, e lo slot SHALL tornare libero

### Requirement: SLOT-02 — Il freno sta sotto il comando, non solo nello script, e due corse non scrivono lo stesso referto

MISURATO IL 27/08/2026 alle 02:40, con la board che dichiarava un tetto di UN
agente: loadavg 52,9 su 12 core, 90 processi node/bun, e DUE `bun test` interi
vivi INSIEME dallo STESSO worktree, uno da 12 minuti e 54 secondi e l'altro da
circa 4. SLOT-01 era in vigore e non c'entrava nulla: erano stati lanciati a mano
come `bun test --timeout 30000 ...`, cioè il comando che `test:unit` avvolge,
senza l'involucro. Un freno che vive solo nello script è un freno che l'ingresso
diretto scavalca.

**Il semaforo SHALL essere preso anche DA DENTRO la corsa.** Ogni `bun test` di
questo repository passa dal preload dei test, e lì lo slot SHALL essere preso,
così che `bun run test:unit` non abbia una porta privilegiata ma la stessa porta,
presa un passo prima. Chi tiene già uno slot SHALL marcare l'ambiente di ciò che
lancia, e una corsa già coperta NON SHALL mettersi in coda dietro al proprio
genitore: sarebbe un'attesa che non finisce.

**E SHALL fallire aperto come il resto.** Un errore del semaforo SHALL lasciar
girare il comando, e l'attesa SHALL avere un limite oltre il quale si gira senza
strozzatura, mai un cancello bloccato per sempre.

**Due corse NON SHALL scrivere lo stesso file di referto.** Entrambe le corse
misurate portavano `--reporter-outfile=/tmp/unit.xml`, un percorso che nel
repository non compare da nessuna parte: chi ha scritto il comando se l'è
inventato, e la seconda corsa sovrascriveva il verdetto della prima. Un cancello
che promuove o boccia una consegna leggendo il risultato di UN'ALTRA corsa è
peggio di un cancello lento. Quindi: il percorso del referto junit SHALL essere
derivato per corsa (worktree, pid, istante) invece che fisso, e una seconda
corsa VIVA sullo stesso percorso assoluto SHALL essere rifiutata a voce alta
invece di sovrascrivere in silenzio. Questo è l'unico punto del semaforo che NON
fallisce aperto: qui «aperto» è esattamente la corruzione misurata.

**Una corsa che nessuno aspetta SHALL avere comunque una fine.** Le due corse
erano orfane (`nohup ... &`) del turno che le aveva lanciate: il tetto di tempo
da parete SHALL valere anche per chi non è passato dall'involucro.

#### Scenario: due `bun test` diretti con uno slot solo
- **GIVEN** due comandi `bun test` lanciati a mano, senza passare dagli script
- **AND** un solo slot dichiarato
- **THEN** le loro finestre di vita NON SHALL sovrapporsi

#### Scenario: la stessa coppia con la strozzatura spenta
- **GIVEN** gli stessi due comandi con il semaforo disattivato
- **THEN** SHALL sovrapporsi, o il banco non sta misurando nulla

#### Scenario: una corsa già coperta dall'involucro
- **GIVEN** una corsa lanciata da chi tiene già lo slot
- **THEN** NON SHALL rimettersi in coda, e SHALL partire subito

#### Scenario: due corse sullo stesso referto junit
- **GIVEN** una corsa viva che ha preso un percorso di output
- **WHEN** una seconda corsa chiede lo stesso percorso assoluto
- **THEN** SHALL essere rifiutata con un codice dedicato, e il referto della
  prima SHALL restare intatto

#### Scenario: due referti chiesti dallo script sanzionato
- **GIVEN** due corse di `test:unit:junit` dallo stesso worktree
- **THEN** i due percorsi di output SHALL essere DISTINTI

### Requirement: GATE-11 — Il cancello che sceglie le spec e2e di una modifica ha il suo cancello

Far girare la suite e2e intera a ogni cambiamento costa troppo; farne girare
troppo poche significa essere verdi mentre la prova che misurava quel
cambiamento non e' mai partita. La selezione automatica delle spec SHALL quindi
essere provata come si prova il prodotto, perche' sbaglia in DUE modi opposti e
tutti e due si sono verificati mentre veniva scritta.

Selezionare TROPPO SHALL essere un guasto: la prima versione legava 5 file
modificati a 75 spec agganciandosi a frammenti di parola come «famil», e un
cancello che riaccende l'intera suite viene spento dal primo che ha fretta.

Selezionare le spec SBAGLIATE SHALL essere un guasto: la seconda versione
metteva otto spec di altre funzioni davanti a quella che era davvero diventata
rossa.

Il legame SHALL passare dagli identificativi dei test dichiarati nel codice,
letti in tutte le forme in cui si scrivono, e l'ordine SHALL mettere davanti le
spec piu' vicine al cambiamento.

#### Scenario: gli identificativi si leggono ovunque siano dichiarati
- **GIVEN** un file che dichiara identificativi come attributo, come espressione e come stringa interpolata
- **THEN** la lettura SHALL trovarli tutti

#### Scenario: la spec che misura il cambiamento viene per prima
- **GIVEN** una modifica che tocca una funzione con la sua spec dedicata
- **THEN** quella spec SHALL precedere le spec di altre funzioni

### Requirement: GATE-12 — La suite unit gira un processo per file, e il verdetto non dipende dal raggruppamento

`bun test` fa girare tutti i file di una corsa in UN processo: quello che un file
lascia (un globale DOM, un `mock.module`, `DATA_DIR`, un timer in volo) passa al
successivo, e il verdetto dipende da come la corsa e' tagliata. Misurato il
05/09/2026 e di nuovo il 21/10: due tentativi di shard nello stesso processo
erano piu' veloci (4,7 e 6,8 minuti) e rossi su test verdi in seriale, mai gli
stessi. Il cancello `test:unit` SHALL quindi lanciare ogni file di test nel suo
processo `bun test`, N file per volta presi da UNA coda comune (default: uno per
core, fra due e quattro), e il verdetto SHALL essere l'aggregato: verde solo se
OGNI file e' verde. Un fallimento nella coda seriale in coda SHALL restare
rosso: nessun retry automatico SHALL sostituirne l'esito. L'output completo del
fallimento, stdout incluso, SHALL restare nel referto.

La corsa SHALL coprire gli STESSI file di `bun test` sulle radici di
`package.json`: un file che la divisione perde e' un cancello che si crede di
avere. I file SHALL partire dal piu' lento al piu' veloce per durata misurata
(un file senza durata nota SHALL pesare la mediana, mai zero), oppure in ordine
casuale con `test:unit:shuffle`, che SHALL stampare il seme e ripetere la stessa
corsa con lo stesso seme: con un processo per file l'ordine non SHALL cambiare
nessun verdetto. Quello che non si isola — i racer che si contendono una risorsa
del sistema con asserzioni di tempistica — SHALL girare uno alla volta DOPO gli
altri, senza contesa di CPU, e la lista di quei file SHALL corrispondere a file
che esistono.

L'output di un file verde SHALL essere scartato; quello di un file rosso SHALL
essere ristampato, con il comando che lo riproduce (`bun test <file>`). Le ULTIME
righe del sommario SHALL nominare i file e i test rossi: il commento sulla card
tiene solo la coda dell'output. Quando il file e' rosso senza nessun test rosso
— hook scaduto, crash, timeout di processo — il sommario SHALL dirlo, non tacere.

Il piano SHALL guardare il CARICO della macchina prima di partire. Sopra una
pressione di 1,25 (carico per core) SHALL usare meno processi (divisi per la
pressione, mai sotto uno) e SHALL scriverlo nell'output. Un numero di shard
scelto a mano via ambiente NON SHALL essere sovrascritto. Il timeout per test
SHALL essere lo stesso per ogni file: 30 s oppure l'override esplicito
`TOPICS_TEST_TIMEOUT_MS`, senza aumenti dovuti al carico. L'ambiente, incluso
`CI`, SHALL essere ereditato, salvo `DATA_DIR`, `TOPICS_DATA_DIR`, `TOPICS_HOME` e
`OPENCLAW_CONFIG_PATH`, che un file non eredita mai dal terminale di chi lancia.

#### Scenario: macchina satura
- **GIVEN** carico 46 su 12 core, nessuna scelta esplicita via ambiente
- **THEN** la corsa SHALL usare un solo processo alla volta e mantenere il timeout di 30 s, e la prima riga dell'output SHALL dirlo

#### Scenario: la coda seriale fallisce
- **GIVEN** tutti i file verdi e un racer della coda seriale che esce 7
- **THEN** la corsa SHALL uscire 7, stampare stdout e stderr del fallimento e non riprovarlo

#### Scenario: un rosso in un file e' un rosso del cancello
- **GIVEN** N file di cui uno esce non-zero
- **THEN** il verdetto aggregato SHALL essere non-zero e il file SHALL essere nominato

#### Scenario: la stessa corsa si ripete
- **GIVEN** una corsa con `--shuffle` e il seme che ha stampato
- **THEN** la corsa con quel seme SHALL avere lo stesso ordine

#### Scenario: la corsa copre le radici della suite
- **GIVEN** le radici dichiarate da `test:unit` in package.json
- **THEN** SHALL coincidere con le radici che la corsa enumera, e il job `unit` della CI SHALL lanciarla senza percorsi

### Requirement: GATE-13 — Quello che un file lascia non raggiunge il file dopo, ne' la cartella temporanea

Un test che installa `globalThis.window = { localStorage }`, un `mock.module` che
`mock.restore()` non ritira, un `DATA_DIR` o una variabile d'ambiente, e non li
toglie, li regalava a ogni file dopo nello stesso processo. Misurato il
05/09/2026: 10 file su 1149 lasciavano `window`, `localStorage` o
`requestAnimationFrame`; il 12/09 un `mock.module` non ritirato; l'08/10 un
`DATA_DIR`. Ognuno e' costato rossi che cambiavano bersaglio con l'ordine e tre
cancelli diversi, uno per classe, a valle della perdita.

Con un processo per file il difetto SHALL non essere rappresentabile: quello che
un file fa al mondo (globali, registro dei moduli, ambiente, timer, singleton)
SHALL restare nel suo processo e SHALL non cambiare l'esito di nessun altro file,
in qualunque ordine. La prova SHALL essere un controllo a due file che in UN
processo si contaminano davvero e col runner no.

Ogni file SHALL avere la sua cartella temporanea (`TMPDIR`), creata prima e
rimossa dopo di lui, qualunque cosa ci abbia lasciato dentro. Una corsa di test
lanciata a mano (`bun test <file>`, senza il runner) SHALL avere lo stesso: il
preload da' al processo una `TMPDIR` sua e la toglie alla fine. Il 23/10/2026 la
temp del Mac del proprietario conteneva ~11.000 `topics-cred*`, 4.800 `topics*`,
3.500 `tracker-home*` e `import*` lasciati dalle corse di test, e 54 file
continuavano a farlo: chiedere a ogni test di pulire e' una difesa per file, a
valle della perdita; qui la perdita non puo' restare. Su CI, se nonostante
questo compare qualcosa nella temp vera o in `/tmp/topics-test` (un percorso
scritto a mano nel test), la corsa SHALL uscire non-zero nominando le voci.

#### Scenario: cio' che a lascia non c'e' per b, in entrambi gli ordini
- **GIVEN** un file che lascia un `window` finto, un `mock.module`, un `DATA_DIR` e una variabile d'ambiente, e un file che si aspetta un mondo pulito
- **THEN** i due file in UN processo SHALL contaminarsi (il controllo) e col runner SHALL passare entrambi, a-poi-b e b-poi-a

#### Scenario: cio' che un file lascia nella temp non resta
- **GIVEN** un file che crea una cartella nella temp e non la rimuove
- **THEN** dopo la corsa del runner quella cartella SHALL non esistere nella temp della corsa, e dopo un `bun test <file>` diretto SHALL non esistere nella cartella temporanea data al processo

### Requirement: GATE-14 — La scala tipografica è una sola, e ci si esce solo dichiarando

Misurato su `client/src` prima di questa card: 1550 dimensioni di font, tutte
scritte come valori arbitrari (`text-[11px]`), su 24 dimensioni distinte. Sei
erano a mezzo pixel (9.5 10.5 11.5 12.5 13.5, 88 usi su 27 file) — e mezzo
pixel non è una dimensione: il rasterizzatore arrotonda, e da che parte dipende
da piattaforma, zoom e densità dello schermo. Due stavano sotto la soglia di
leggibilità (7px e 8px, 9 usi). La stessa misura si scriveva in due modi
(`text-xs` accanto a `text-[12px]`), quindi cercarne uno ne trovava metà.
Nessuno ha deciso niente di tutto questo: è ciò a cui un client converge quando
la dimensione di un componente nuovo si sceglie guardando il vicino.

La scala SHALL esistere come SORGENTE UNICA: un blocco `@theme` in
`client/src/index.css` con gradini NOMINATI, e SHALL dichiarare la sola
`font-size` — l'altezza di riga resta su un `leading-*` esplicito accanto alla
misura, perché un gradino che porta con sé un'interlinea implicita sposta un
box di riga mentre sembra cambiare solo la dimensione.

Un gradino SHALL essere un numero INTERO di pixel e SHALL stare al di sopra
della soglia di 9px. Aggiungerne uno è una decisione legittima e si prende in
quel blocco; ciò che non è permesso è aggirarlo.

Il cancello `check:typography` SHALL uscire non-zero quando un file di
`client/src` porta una misura assoluta in un valore arbitrario, o una classe
della scala di Tailwind (che il reset `--text-*: initial` ha spento, quindi non
genera più niente e il testo cade sulla misura ereditata), o quando un gradino
del blocco `@theme` non rispetta le due regole qui sopra. Una misura RELATIVA in
valore arbitrario (`text-[0.92em]`) NON SHALL essere rossa: dice «rispetto a chi
mi contiene», che nessun gradino fisso può dire.

#### Scenario: una misura scritta a mano in un componente
- **GIVEN** un file di `client/src` con `text-[12.5px]`
- **THEN** `check:typography` SHALL uscire non-zero nominando file, riga e misura

#### Scenario: una classe della scala spenta
- **GIVEN** un file di `client/src` con `text-xs`
- **THEN** `check:typography` SHALL uscire non-zero, perché quella classe non genera più alcuna dimensione

#### Scenario: un gradino a mezzo pixel nel blocco `@theme`
- **GIVEN** un `@theme` che dichiara `--text-qualcosa: 10.5px`
- **THEN** `check:typography` SHALL uscire non-zero

#### Scenario: colori, allineamenti e misure relative restano verdi
- **GIVEN** un file con `text-app-text-muted`, `text-center` e `text-[0.92em]`
- **THEN** `check:typography` SHALL uscire zero

### Requirement: GATE-15 — Un cancello non segnala il lavoro che lo sta eseguendo, e l'hook installato è quello del repo

Il contatore del checkout gira dentro il `pre-push`, cioè nel momento in cui
qualcuno sta per dire «fatto». Lì i commit in arrivo non sono ancora sul remoto,
quindi contarli significa stampare come avanzo esattamente il carico che il push
sta consegnando: misurato il 20/09, due commit segnalati dallo stesso comando che
li pubblicava. Un avviso che compare a OGNI push non è un avviso, è il rumore che
insegna a non leggere il cancello il giorno che ha ragione.

Il contatore SHALL ricevere le punte in pubblicazione (`--in-push <sha>`) e SHALL
escluderle dal conteggio del non spinto. Ciò che il push NON tocca — un ramo
rimasto indietro, uno stash, una worktree — SHALL restare rosso: la cura di un
falso allarme non è smettere di guardare. Uno sha di soli zeri, cioè una
cancellazione di ramo, non pubblica niente e NON SHALL spegnere il conteggio.

L'hook INSTALLATO SHALL essere il file VERSIONATO, non una sua copia. Una
fotocopia smette di somigliare al sorgente al primo cambiamento e nessuno lo
dice: il 20/09 la correzione al `pre-push` è stata scritta, committata e spinta,
e il push ha eseguito la versione della notte prima. L'installazione SHALL quindi
INOLTRARE al file tracciato, passando ARGOMENTI e STDIN e restituendo il CODICE DI
USCITA immutato — stdin porta i ref che la guardia legge per decidere, e la
guardia rifiuta uscendo non-zero. Se il file tracciato non c'è (un commit
vecchio, un checkout parziale) l'inoltro SHALL uscire zero: un hook assente è
meglio di un hook che esplode.

#### Scenario: il push segnala il proprio carico
- **GIVEN** `main` con commit non ancora sul remoto
- **WHEN** il contatore riceve quelle punte in `--in-push`
- **THEN** NON SHALL nominarli come non spinti

#### Scenario: resta dello sporco che il push non tocca
- **GIVEN** un ramo oltre `main` durante lo stesso push
- **THEN** il contatore SHALL dirlo

#### Scenario: l'hook versionato cambia
- **GIVEN** una modifica a `scripts/git-hooks/pre-push`
- **WHEN** parte un push senza reinstallare gli hook
- **THEN** SHALL essere eseguita la versione NUOVA

### Requirement: GATE-16 — Chi lancia i test decide UNA volta quanto è lenta la macchina, e lo tramanda

Le finestre d'attesa dei test si scrivono per una macchina scarica e si
moltiplicano per un fattore (`GATE`: `shared/test-time-slack.ts`, tetto 4x). Il
fattore SHALL essere misurato da CHI LANCIA la corsa e passato ai figli in
`TOPICS_TEST_TIME_SLACK`: se non lo passa nessuno, ogni file lo ricalcola al
proprio import, e in una corsa da mezz'ora il primo file vede una macchina
quieta mentre l'ultimo vede il carico che la corsa stessa sta producendo. Due
test della stessa suite finiscono con due idee diverse di quanto è lenta la
macchina.

Misurato il 20/09: una barra intera a carico 26 è uscita rossa su ESATTAMENTE
due test su 16.991, entrambi in attesa dentro una finestra, entrambi verdi da
soli e verdi in coppia subito dopo.

OGNI runner SHALL tramandarlo — quello a shard, quello e2e e quello SERIALE che
`bun run test:unit` avvia, usato dalla barra locale e dalla CI. Un valore già
presente nell'ambiente SHALL vincere sulla misura: chi lo ha forzato sa qualcosa
che lo script non sa.

Il fattore NON SHALL allargare il limite per singolo test
(`TOPICS_TEST_TIMEOUT_MS`): quello serve a prendere un blocco, e allargarlo
nasconderebbe proprio i blocchi che esiste per trovare.

Percorsi espliciti passati a un runner SHALL SOSTITUIRE quelli predefiniti, non
sommarsi: restringere l'indagine a un file deve eseguire quel file, non l'intera
suite.

#### Scenario: la corsa seriale parte
- **GIVEN** `bun run test:unit`
- **THEN** i test figli SHALL leggere il fattore dall'ambiente

#### Scenario: un fattore forzato a mano
- **GIVEN** `TOPICS_TEST_TIME_SLACK` già valorizzato
- **THEN** SHALL restare quello

#### Scenario: un solo file sulla riga di comando
- **GIVEN** un percorso esplicito
- **THEN** SHALL essere eseguito solo quello

### Requirement: GATE-17 — L'ordine dei router è una tabella, e due router che rivendicano la stessa rotta si vedono ROSSI

Le richieste `/api/*` SHALL passare dai router nell'ordine di UNA tabella
esplicita (`API_ROUTER_ORDER`, `server/route-table.ts`): il primo che risponde
vince, chi restituisce null lascia passare la richiesta al successivo, un router
che esiste solo sotto una condizione SHALL tenere il suo posto e dichiarare la
condizione. Prima l'ordine esisteva solo come catena di 45 `||` dentro `fetch`,
e nessuno poteva leggerlo né fissarlo.

L'ordine SHALL essere fissato da un test con la lista d'oro dei nomi: cambiarlo
è un cambio di precedenza, e si fa apposta, mai come effetto collaterale.

Un cancello (`check:route-shadowing`) SHALL leggere i predicati di percorso dei
router veri e uscire NON-ZERO quando un router più avanti rivendica un metodo e
un percorso che uno più indietro rivendica già, nominando i due file con la
riga. Una sovrapposizione esaminata e voluta SHALL stare in una lista scritta
con il motivo, e una voce della lista che non trova più niente SHALL essere
rossa. Il cancello NON SHALL cambiare la precedenza: riporta.

#### Scenario: due router sulla stessa rotta
- **GIVEN** un router che rivendica `GET /api/x` dopo un altro che la rivendica già
- **THEN** il cancello SHALL uscire 1, nominando entrambi i file

#### Scenario: l'ordine cambiato per sbaglio
- **GIVEN** due router scambiati di posto nella tabella
- **THEN** il test della lista d'oro SHALL fallire

### Requirement: GATE-18 — La sincronizzazione col PC Windows toglie solo cio' che ha spedito

`tools/topwin sync` SHALL togliere dalla copia sul PC solo i file che una sync
precedente ha spedito e che HEAD non ha piu': la lista di cio' che e' stato
spedito vive sul PC (`.topwin-shipped`). Senza quella lista la stima SHALL
essere ricavata dalla storia (i percorsi cancellati da un commit, senza
rinomine e senza cartelle), e SHALL escludere ogni percorso che il repo oggi
IGNORA: un file tracciato un tempo e ignorato adesso (`docs/DEAD-CODE.md`,
`videos/INDEX.md`, i risultati dei banchi) sul PC lo generano i giri, non una
sync. Misurato il 03/10: 515 dei circa 2400 percorsi cancellati erano di
questo tipo.

#### Scenario: un percorso ignorato nella lista ricavata dalla storia
- **GIVEN** un PC senza `.topwin-shipped` che ha un file cancellato da un commit e ora ignorato, e uno cancellato e non ignorato
- **WHEN** si lancia `tools/topwin sync`
- **THEN** SHALL essere tolto solo il secondo

### Requirement: GATE-19 — Ciò che è indipendente non si mette in fila, e un pezzo rosso non nasconde gli altri

`typecheck` e `lint` SHALL eseguire i loro pezzi (cinque `tsc`, quattro passi di
eslint) insieme tramite `scripts/parallel.ts`, dentro lo stesso slot di
`slot.ts`: un solo cancello logico, non uno per pezzo. Il verdetto SHALL essere
verde solo se lo sono tutti i pezzi, l'uscita SHALL essere quella del primo
pezzo rosso nell'ordine in cui sono scritti (la stessa che avrebbe dato la
catena `a && b`), e un giro SHALL elencare TUTTI i rossi invece di fermarsi al
primo. L'output SHALL arrivare per pezzo e intero, con i rossi in fondo: la
board tiene solo la coda.

`scripts/qa-gate.sh` SHALL eseguire insieme `typecheck`, `lint` e i cancelli
statici, e SHALL stampare le stesse righe nello stesso ordine di quando andavano
in fila. `check:deadcode-blindspots` SHALL girare da solo, a corsa finita: scrive
una sonda in ogni file di progetto e un cancello che legge in quel momento
vedrebbe un export in più.

#### Scenario: un pezzo rosso fra due verdi
- **GIVEN** tre comandi, il secondo esce 3
- **WHEN** si lancia `scripts/parallel.ts` con i tre
- **THEN** SHALL girare anche il terzo, SHALL uscire 3 e SHALL nominare il secondo

#### Scenario: due rossi
- **GIVEN** due comandi che escono 5 e 7, in quest'ordine
- **THEN** SHALL uscire 5 e SHALL elencarli entrambi

#### Scenario: i pezzi girano davvero insieme
- **GIVEN** due comandi che dormono 1 s ciascuno
- **THEN** il totale SHALL essere ben sotto i 2 s

### Requirement: GATE-20 — Un lavoro launchd si committa come modello, mai come plist pronto

Un file sotto `scripts/launchd/` SHALL essere un modello con segnaposto
(`.plist.in`, con `__HOME__`, `__REPO__`, `__BUN__`, `__LOG__`) e NON SHALL
contenere un letterale `/Users/<nome>/` o `/home/<nome>/`. Il plist vero lo
scrive `scripts/install-db-snapshot.ts` sulla macchina che lo installa, e non
e' tracciato.

Il motivo e' che il repo e' pubblico e un plist concreto deve per forza
scrivere percorsi assoluti — `WorkingDirectory`, `HOME`, l'interprete, i log —
cioe' la home e il nome utente di chi l'ha installato. Il 22/10/2026 uno ci e'
finito per davvero (PR #405, sei occorrenze) e la CI e' rimasta verde: i due
cancelli che cercano un percorso di home cercano la home **di chi esegue**, e
su un runner di CI non e' di nessuno. Il controllo SHALL quindi essere indipendente da
chi lo lancia.

#### Scenario: un plist concreto con la home di una persona
- **GIVEN** un file tracciato in `scripts/launchd/` con `/Users/qualcuno/Projects/...`
- **WHEN** gira il cancello
- **THEN** SHALL essere rosso su qualunque macchina, runner compreso

#### Scenario: il modello con i segnaposto
- **GIVEN** `com.armonia.topics-db-snapshot.plist.in` con `__REPO__` e `__HOME__`
- **THEN** SHALL essere verde
- **AND** `bun scripts/install-db-snapshot.ts --print` SHALL riempirli tutti

#### Scenario: un percorso di sistema non e' quello di una persona
- **GIVEN** `<string>/usr/bin:/bin:/opt/homebrew/bin</string>`
- **THEN** SHALL essere verde

### Requirement: GATE-21 — «Pubblicato» sono anche i tag, e un termine già pubblicato si blocca in avanti invece di fare rosso per sempre

Il cancello della storia pubblicata (`check:history-clean`,
`scripts/scrub-history.ts --check`) SHALL misurare l'unione di TUTTI i ref che
il remoto serve: i rami remoti, i **tag che il remoto ha** e `refs/pull/*`.
Prima guardava solo `--remotes=<r>/*`, cioè i 20 rami pubblicati e nessuno dei
710 tag pubblicati: misurato il 22/10/2026 su un termine reale, 51 commit
contro i 112 dell'unione, e tre nomi di cliente riportati `pulito` mentre 14
riscontri su 12 commit distinti li portavano ancora, tutti sotto UN tag di
release pubblicato i cui commit erano stati rebasati via da `main`. Verificato
clonando il repo da zero senza alcun flag: 710 tag e tutti i 12 commit
presenti. Un cancello che sottostima di 2x dice «pulito» su metà di ciò che il
pubblico può leggere.

Un tag pubblicato SHALL essere identificato per **SHA**, non per nome:
`ls-remote` restituisce entrambi, e risolvere il nome risolve l'oggetto LOCALE.
Con un tag spostato da una delle due parti (una release ri-tagliata, un
`git tag -f` locale) il cancello misurava un commit diverso da quello che il
remoto serve e stampava `pulito` senza alcun avviso.

Il **messaggio di un tag annotato** SHALL essere misurato: nessuna passata di
`git log` lo legge, perché la passata visita i commit e il testo di un oggetto
tag non è né un messaggio di commit né un blob. Il conteggio dei messaggi di tag
SHALL essere riportato separato da quello dei commit.

Un termine SHALL essere cercato come **stringa**, non come pattern: `--grep` è
una regex, quindi un termine che contiene `[`, `(` o `.` non trovava NIENTE nei
messaggi — la metà esatta per cui `--grep` era stato aggiunto. Misurato con
`Acme [Milano] srl` in un messaggio pubblicato: 0 riscontri senza `-F`, 1 con.

L'elenco dei tag SHALL arrivare dal remoto (`git ls-remote --tags`), non da
`--tags`: 316 dei 1026 tag di questo clone esistono solo qui, 307 dei quali
backup `archive/*`, e contarli farebbe annunciare una fuga PUBBLICA su ref che
nessuno può raggiungere — lo stesso difetto di `selfcheck/main`. Un remoto che
risponde con zero tag SHALL contare come «nessun tag pubblicato». Quando un
remoto NON risponde il cancello NON SHALL indovinare in nessuna delle due
direzioni — né tacere né ripiegare sui tag locali, che trasformerebbe un backup
`archive/*` in una fuga pubblica: SHALL dichiarare la misura mancata e uscire 2.

Un termine di `.personal-terms` SHALL poter essere marcato **solo in avanti**
(prefisso `>` sulla riga; il formato è documentato nel docblock di
`scripts/personal-terms.ts`, perché il file non è tracciato). Un termine così
marcato NON SHALL far fallire il controllo sulla storia pubblicata — che SHALL
riportarlo come esposizione nota con il suo conteggio — e SHALL comunque essere
rifiutato dal hook pre-push nei commit non ancora pushati, **messaggi
inclusi**. Senza i due livelli un termine già pubblicato rende
`check:history-clean` rosso per sempre (l'unico rimedio sarebbe riscrivere la
storia, ed è misurato che non basta: GitHub serve gli oggetti per SHA anche 62
giorni dopo un force-push), quindi non si poteva aggiungere affatto: è per
questo che il percorso della home dell'autore è rimasto fuori dalla lista fino
a finire in un plist launchd nella PR #405 senza che niente lo cercasse.

**Ogni fallimento di `git` nella misura SHALL essere registrato, e un giro con
qualcosa registrato NON SHALL riportare un verde**: SHALL uscire 2 («non
misurabile») dicendo il motivo. È la cura all'origine di quattro falsi verdi
misurati su questo stesso ramo, tutti la stessa forma — l'helper inghiottiva
l'errore in `""`, e per una domanda di conteggio `""` vale ZERO, quindi «git si
è rifiutato di rispondere» e «non c'è niente» erano lo stesso valore. I quattro:
un oggetto pubblicato che il clone non ha, un percorso scritto come un rev (la
lista dei rev SHALL essere chiusa da `--`), un termine con un metacarattere, un
remoto che non risponde. Un termine già trovato pubblico fra i ref misurabili
SHALL comunque dare 1: una fuga certa batte una misura mancata.

Con l'elenco dei termini VUOTO il cancello SHALL uscire 0 senza giudicare
niente: è lo stato normale in CI e su un clone fresco, e «nessun termine» non è
un verde ma «niente da cercare».

Il hook pre-push SHALL fallire CHIUSO sulla stessa condizione: una guardia che
non ha potuto misurare non lascia passare il push.

Un marcatore su un termine che la storia pubblicata NON contiene SHALL essere
segnalato come inutile, non essere rosso: non copre nulla e il pre-push lo
blocca comunque.

#### Scenario: un nome che solo un tag pubblicato raggiunge
- **GIVEN** un commit con il termine, raggiungibile solo da un tag spinto sul remoto
- **WHEN** si lancia `check:history-clean`
- **THEN** SHALL uscire 1, mentre il vecchio ambito (solo i rami remoti) ne contava 0

#### Scenario: un tag che vive solo in locale
- **GIVEN** lo stesso commit, con il tag MAI spinto e il remoto che risponde
- **THEN** SHALL uscire 0 e SHALL riportarlo come sporcizia solo locale

#### Scenario: un oggetto pubblicato che il clone non ha
- **GIVEN** un tag spinto sul remoto dopo che il clone esisteva, quindi il suo oggetto non è qui
- **THEN** SHALL uscire 2 e NON SHALL dire che niente di pubblicato contiene i nomi
- **AND** se un ref misurabile porta già il termine, SHALL uscire 1
- **AND** con l'elenco dei termini vuoto SHALL uscire 0

#### Scenario: un tag spostato in locale
- **GIVEN** il tag sul remoto che punta al commit sporco e il ref locale dello stesso nome spostato su uno pulito
- **THEN** SHALL uscire 1

#### Scenario: il messaggio di un tag annotato
- **GIVEN** un termine solo in `git tag -a -m` su un tag spinto
- **THEN** SHALL uscire 1 contando un messaggio di tag, e NON SHALL consigliare di togliere il marcatore

#### Scenario: un termine con un metacarattere, solo nel messaggio
- **GIVEN** un termine che contiene `[...]` nel messaggio di un commit pubblicato, e lo stesso in un commit non pushato
- **THEN** il cancello SHALL uscire 1 e il pre-push SHALL uscire 1

#### Scenario: un ref rotto
- **GIVEN** un `refs/pull/*` che punta a un oggetto inesistente
- **THEN** SHALL uscire 2, e il motivo stampato NON SHALL contenere il termine

#### Scenario: termine solo in avanti già nella storia pubblicata
- **GIVEN** `> <termine>` e il termine in un commit sul ramo remoto
- **THEN** `check:history-clean` SHALL uscire 0 e SHALL nominarlo col conteggio come esposizione nota
- **AND** lo stesso repo senza il marcatore SHALL uscire 1

#### Scenario: lo stesso termine in un commit non pushato
- **GIVEN** `> <termine>` e un commit locale che lo contiene nel contenuto, e un altro che lo ha solo nel MESSAGGIO
- **THEN** il hook pre-push SHALL uscire 1 in entrambi i casi
