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
