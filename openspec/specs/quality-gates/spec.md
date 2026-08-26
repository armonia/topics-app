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

### Requirement: GATE-07 — Niente di PERSONALE in un file tracciato, e il debito può solo scendere

Nessun file tracciato SHALL contenere il percorso della cartella personale, il
nome di chi lavora al repository, o un indirizzo di posta su un dominio
personale. Sono già rientrati tutti e tre: decine di percorsi in file di misura,
oltre cento file col nome proprio alla vigilia del primo push pubblico, e un
indirizzo reale dentro una migration — trovato da una spec, non da un cancello.

Il nome SHALL essere cercato in OGNI grafia in cui compare, compresa quella
codificata per un indirizzo e quella usata negli identificativi di cartella.

L'utente di una macchina di costruzione NON SHALL essere trattato come il nome di
una persona, o decine di file legittimi diventerebbero rossi.

Il PREDICATO SHALL essere visto MORDERE: un indirizzo personale preso, uno di
ruolo lasciato stare.

Il debito noto SHALL poter solo SCENDERE: nessun file NUOVO, e nessuna voce
STANTIA nell'elenco. Ogni esenzione SHALL portare scritta la propria RAGIONE.

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
