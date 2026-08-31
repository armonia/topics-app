## Purpose

Come esce una versione: cosa deve essere vero perché si pubblichi, chi decide, e
cosa una persona legge PRIMA di premere il tasto che raggiunge tutti.

## Background

TRENTASETTE RILASCI, VENTOTTO DA UNA VERIFICA NON VERDE. Misurato su sessanta
esecuzioni: la pubblicazione partiva sul PUSH, cioè prima che qualcuno avesse
guardato se il codice funzionava. E un'espressione di condizione non valida non
è un errore: viene valutata FALSA, e il lavoro viene saltato in silenzio.

I QUATTRO NUMERI DI VERSIONE SI SCOLLANO DA SOLI. Tre versioni di fila hanno
toccato tre file su quattro; misurato su una di esse, il quarto era cinque
versioni indietro.

E UN RILASCIO COMPLETO PUÒ RESTARE BOZZA PER SEMPRE: dodici pacchetti su dodici
caricati, poi un errore del servizio undici secondi DOPO l'ultimo caricamento
riuscito. Il lavoro c'era tutto; a mancare era il giudizio su cosa fosse
davvero successo.

## Requirements

### Requirement: RELEASE-01 — Si pubblica sull'ESITO della verifica, e sullo SHA che è stato giudicato

La pubblicazione SHALL essere innescata dall'ESITO della verifica, non dal push:
altrimenti esce codice che nessuno ha guardato.

Una verifica ROSSA NON SHALL pubblicare. Una verifica CANCELLATA, scaduta,
saltata o in attesa NON SHALL pubblicare: «non lo sappiamo» NON è «va bene».

Il commit che ALZA la versione NON SHALL innescare un altro giro: nessun anello.
Un ramo che non è quello principale NON SHALL pubblicare.

SHALL essere preso lo SHA che la verifica ha GIUDICATO, non lo stato corrente del
ramo: un prelievo senza riferimento esplicito pubblica qualcos'altro.

Il lavoro di rilascio SHALL dipendere da quello di versione, così il cancello
vale per entrambi.

Le clausole scritte nel flusso e quelle rigiocate dal banco SHALL essere le
STESSE, e il banco SHALL verificarlo: altrimenti diverge senza che nessuno lo
sappia.

#### Scenario: una verifica cancellata
- **GIVEN** un esito non verde e non rosso
- **THEN** NON SHALL essere pubblicato niente

#### Scenario: il commit che alza la versione
- **GIVEN** il commit prodotto dal rilascio precedente
- **THEN** NON SHALL innescare un nuovo rilascio

### Requirement: RELEASE-02 — I quattro numeri di versione coincidono, e un gesto solo li riallinea

I quattro file che dichiarano la versione SHALL portare lo STESSO numero, e ognuno
SHALL dichiararne uno leggibile.

Il messaggio di fallimento SHALL NOMINARE il gesto che risolve: un cancello che
dice solo «non coincidono» lascia a chi legge il compito di scoprire come si
aggiusta.

SHALL esistere UN gesto che li riallinea tutti e quattro — riallineare senza
inventare un numero nuovo, imporne uno esplicito, o incrementare — e un albero
scollato SHALL essere ROSSO prima di quel gesto e VERDE dopo.

Un argomento che non è né una parola nota né un numero di versione valido SHALL
uscire con un errore, non scrivere un incremento a caso.

#### Scenario: un file rimasto indietro
- **GIVEN** tre file allineati e uno no
- **THEN** il cancello SHALL fallire, nominando il gesto che risolve

#### Scenario: un argomento non valido
- **GIVEN** una parola che non è né nota né un numero di versione
- **THEN** SHALL essere un errore

### Requirement: RELEASE-03 — Si pubblica se i PACCHETTI ci sono, non se il lavoro è uscito zero

Il giudizio sulla pubblicabilità SHALL guardare i PACCHETTI PRESENTI, non il
codice di uscita dei lavori di costruzione: un errore del servizio dopo l'ultimo
caricamento riuscito lasciava una costruzione completa su tre sistemi operativi
bloccata come bozza per sempre.

L'insieme atteso SHALL essere DICHIARATO, e il giudizio SHALL guardare i SUFFISSI,
non la versione nel nome.

Un pacchetto MANCANTE NON SHALL pubblicare, e il messaggio SHALL dire QUALE. Una
FIRMA mancante NON SHALL pubblicare: senza, l'aggiornamento automatico non
installa. Un sistema operativo INTERO mancante NON SHALL pubblicare. Il manifesto
dell'aggiornamento mancante NON SHALL pubblicare: senza, gli altri non vengono
mai chiesti.

IL MANIFESTO SHALL ESSERE APERTO, non solo contato. Il 31/08 la 2.2.256 è
passata dodici su dodici con un `latest.json` che nominava SETTE piattaforme su
dieci e nessuna Windows: gli installer c'erano tutti, il nome del manifesto
c'era, e chi era su Windows non ha ricevuto l'aggiornamento senza che niente lo
dicesse. Quindi il giudizio SHALL leggere DENTRO il manifesto e SHALL rifiutare
la pubblicazione se una piattaforma attesa non è nominata, dicendo QUALE. Un
manifesto ILLEGGIBILE SHALL essere un guasto DISTINTO da una piattaforma
mancante: le due cose si curano in modo diverso. Piattaforme IN PIÙ NON SHALL
disturbare, per la stessa ragione dei pacchetti in più.

La causa SHALL restare scritta accanto al controllo: le tre costruzioni della
matrice caricano OGNUNA il proprio manifesto e vince l'ultima, quindi una corsa
vinta da chi non ha visto Windows pubblica un manifesto presente e monco.

Una bozza VUOTA NON SHALL essere pubblicata. Pacchetti IN PIÙ NON SHALL
disturbare: la domanda è «c'è tutto», non «c'è solo».

Il controllo dei pacchetti SHALL venire PRIMA della pubblicazione, e il flusso
SHALL girare ANCHE con una costruzione rossa — ma solo se il rilascio è stato
creato.

#### Scenario: costruzione rossa e pacchetti completi
- **GIVEN** dodici pacchetti su dodici e un lavoro uscito non-zero
- **THEN** SHALL essere pubblicato

#### Scenario: una firma mancante
- **GIVEN** un pacchetto senza la sua firma
- **THEN** NON SHALL essere pubblicato

#### Scenario: dodici pacchetti su dodici e un manifesto monco
- **GIVEN** tutti i pacchetti presenti e un `latest.json` senza le voci Windows
- **THEN** NON SHALL essere pubblicato
- **AND** il messaggio SHALL nominare le piattaforme che mancano

#### Scenario: un manifesto che non si legge
- **GIVEN** un `latest.json` che non è un manifesto dell'aggiornamento
- **THEN** NON SHALL essere pubblicato
- **AND** SHALL essere detto come guasto diverso da «manca una costruzione»

### Requirement: RELEASE-04 — Chi preme «pubblica» LEGGE che raggiunge tutti

Prima del gesto che pubblica, la schermata SHALL DIRE la CONSEGUENZA: il difetto
non era la velocità, era che NESSUNA schermata lo diceva — si elencavano i commit
in uscita e si offriva il tasto, e chi lo premeva prendeva una decisione di
pubblicazione senza che niente gliela nominasse.

La frase SHALL NOMINARE CHI la riceve, non solo che «esce», e SHALL dire che il
cancello è la verifica automatica, non un'approvazione umana.

Il gesto che porta il lavoro sul ramo principale SENZA pubblicare SHALL
DICHIARARE che non pubblica — anche nella sua variante forzata.

La riga SHALL comparire SOLO quando c'è davvero qualcosa da pubblicare, e SHALL
stare PRIMA dei tasti, non dopo.

Con l'aggiornamento AUTOMATICO acceso NON SHALL essere offerto il tasto che
scarica: è un gesto che non fa niente. SHALL essere comunque DETTO che una
versione sta arrivando — il silenzio no, un gesto inutile nemmeno. Lo stato SHALL
essere letto dalla STESSA fonte che usa la barra, o le due si contraddicono.

#### Scenario: qualcosa da pubblicare
- **GIVEN** dei commit in uscita
- **THEN** la conseguenza SHALL essere scritta prima dei tasti

#### Scenario: aggiornamento automatico acceso
- **GIVEN** l'automatismo attivo
- **THEN** NON SHALL essere offerto il tasto che scarica

### Requirement: RELEASE-05 — I documenti descrivono il prodotto che SPEDISCE oggi

I documenti che una persona legge per configurare o installare SHALL descrivere
ciò che il prodotto è ADESSO.

Il file di esempio della configurazione NON SHALL INCHIODARE la scelta del
fornitore: fissarne uno che non risponde non produce nessun errore — la chat
semplicemente non risponde mai. SHALL nominare TUTTI i valori validi, e SHALL
segnalare quelli che si registrano senza il proprio motore.

La documentazione SHALL nominare la chiave che DAVVERO decide il predefinito, e
nell'ORDINE in cui viene consultata.

I pacchetti PROMESSI SHALL essere esattamente quelli che la costruzione produce:
promettere un formato che non si costruisce più manda a cercare un file che non
esiste.

Le descrizioni del prodotto NON SHALL essere sopravvissute a un cambio di
direzione, e i crediti NON SHALL nominare un guscio archiviato o un componente
che nessun pacchetto contiene. Ogni componente CREDITATO SHALL portare la propria
licenza, e i motori con obblighi di licenza SHALL essere NOMINATI su OGNI
piattaforma dove viaggiano.

I setacci che verificano tutto questo SHALL essere visti PRENDERE il testo che
hanno sostituito.

#### Scenario: un formato di pacchetto non più costruito
- **GIVEN** una promessa nella documentazione
- **THEN** il banco SHALL fallire

#### Scenario: un fornitore inchiodato nella configurazione di esempio
- **GIVEN** una scelta fissata
- **THEN** il banco SHALL fallire

### Requirement: RELEASE-06 — Le istruzioni di installazione descrivono un percorso che ESISTE

Le istruzioni per aprire l'applicazione la prima volta SHALL descrivere un
percorso che il sistema operativo offre ANCORA: il vecchio aggiramento non esiste
più, e chi lo segue non trova la voce, riprova, conclude che il pacchetto è
corrotto e se ne va.

Il percorso che FUNZIONA SHALL essere scritto DOVE serve, in tutti i documenti che
ne parlano.

NON SHALL essere suggerito di spegnere la protezione per TUTTA la macchina.

Il controllo SHALL leggere per PARAGRAFO e SHALL riconoscere un paragrafo che
NEGA l'istruzione vecchia: citarla per dire che non vale più non è darla.

#### Scenario: l'istruzione superata
- **GIVEN** un documento che la dà come valida
- **THEN** il banco SHALL fallire

#### Scenario: la stessa istruzione citata per negarla
- **GIVEN** un paragrafo che dichiara che non vale più
- **THEN** NON SHALL essere un fallimento

### Requirement: UPDATER-01 — L'aggiornamento si annuncia, ma un controllo SILENZIOSO resta silenzioso

Il riquadro dell'aggiornamento SHALL comparire per gli stati che chiedono qualcosa
a chi guarda — disponibile, in scaricamento, pronto — perché senza quel riquadro
nessuno saprebbe che c'è, dato che non arriva più da solo. Lo stato di riposo NON
SHALL disegnare niente.

Un controllo AUTOMATICO all'avvio SHALL restare SILENZIOSO sugli errori: finché non
esiste una release firmata la porta risponde «non trovato», e un riquadro d'errore
a ogni avvio riguarda qualcosa che chi guarda non ha chiesto e non può risolvere.

**Un aggiornamento davvero DISPONIBILE SHALL uscire lo stesso, anche se il
controllo era silenzioso**: il silenzio vale per i guasti, non per le notizie.

Chiuso da chi guarda, o con il pannello della versione già aperto, NON SHALL
comparire un doppione.

#### Scenario: il controllo al boot senza release firmate
- **GIVEN** un controllo automatico che fallisce
- **THEN** NON SHALL comparire nessun riquadro d'errore

#### Scenario: un aggiornamento disponibile trovato dal controllo al boot
- **GIVEN** un controllo silenzioso che trova un aggiornamento
- **THEN** il riquadro SHALL comparire lo stesso

### Requirement: UPDATER-02 — An update that reports success SHALL have arrived whole

An installer that skips a file and still exits 0 produces the worst kind of
update: the registry says the new version, the shell says the new version, and
one binary on disk is still the old one. Nobody is lying and nobody is right.

Measured on a real Windows 11 machine on 2026-08-27, updating 2.2.173 → 2.2.176
with the app open and a terminal in use: `app.exe`, `topics-server.exe` and
`webrtc-bridge.exe` were replaced, `pty-bridge.exe` was NOT. The one file left
behind was the only one that was RUNNING — the NSIS installer cannot overwrite a
file in use, in silent mode it skips it, and it exits 0. Tauri's own template
closes exactly one process before copying (`CheckIfAppIsRunning` looks for
`${MAINBINARYNAME}.exe` and nothing else), so every sidecar survives by
construction.

The installer SHALL close its sidecars before copying, and SHALL FAIL when one
is still locked afterwards: a copy that could not happen is not a successful
install.

The shell SHALL compare, at startup, the fingerprints of the binaries beside it
against the ones the build shipped, and SHALL surface a mismatch where the user
already looks for version information.

The warning SHALL NOT be symmetric: only a verdict that was actually verified
accuses anyone. A build carrying no fingerprints — a dev build, or the stub
sidecars CI creates for the existence gate — knows nothing, and whoever knows
nothing SHALL stay quiet. A warning that fires on every `tauri dev` is a warning
ignored on the day it is true.

Every sidecar declared in `externalBin` SHALL be listed in the installer hooks:
what this requirement prevents is not the locked file, it is the SILENCE — add a
fourth sidecar without listing it and that binary goes back to being skipped
with nobody the wiser.

#### Scenario: a sidecar is running during the update
- **GIVEN** an update installed while the app is open
- **WHEN** the installer copies the new binaries
- **THEN** the sidecars SHALL be closed first
- **AND** a file still locked afterwards SHALL fail the install rather than be skipped

#### Scenario: the shell notices it is standing next to stale binaries
- **GIVEN** a shell whose sidecar fingerprints do not match the shipped ones
- **THEN** the mismatch SHALL be shown with the version information

#### Scenario: a build that knows nothing keeps quiet
- **GIVEN** a build with no recorded fingerprints (dev, or CI stub sidecars)
- **THEN** no warning SHALL be shown

### Requirement: UPDATER-03 — L'app RIGUARDA, non controlla una volta sola all'avvio

Il controllo all'avvio basta a un'app che si riavvia. Topics e' un elemento di
avvio che resta aperto per giorni: se quel controllo e' l'unico automatico,
allora per una macchina accesa da mercoledi' non esiste nessun aggiornamento.

Misurato sul PC Windows il 29/08/2026: l'ultimo pacchetto scaricato era la
2.2.211 delle 21:23 del 28, e nel frattempo erano uscite la 2.2.212, 2.2.213,
2.2.214 e 2.2.215 — nessuna scaricata. La catena di rilascio era sana
(`latest.json` porta la voce `windows-x86_64` firmata) e la macchina sapeva
aggiornarsi: nessuno gliel'ha piu' chiesto. Una correzione poteva quindi essere
spedita e la persona su Windows continuava a vedere il difetto, perche' la cura
stava due versioni piu' avanti di quanto la sua app le avrebbe mai proposto.

L'app SHALL quindi ripetere il controllo a intervalli mentre resta aperta, e
quel ripetersi SHALL essere SILENZIOSO come quello di avvio (UPDATER-01): un
controllo periodico che annuncia «sei aggiornato» sarebbe un avviso che nessuno
ha chiesto, quattro volte al giorno. Lo smontaggio SHALL fermare il giro, o una
pagina che rimonta ne accumulerebbe uno in piu' ogni volta.

#### Scenario: la macchina resta accesa
- **GIVEN** l'app avviata e lasciata aperta oltre il periodo di ricontrollo
- **WHEN** viene pubblicata una versione nuova dopo il controllo di avvio
- **THEN** l'app SHALL controllare di nuovo senza nessun gesto dell'utente

#### Scenario: si smonta
- **GIVEN** il giro dei controlli avviato
- **WHEN** viene fermato
- **THEN** SHALL non arrivare nessun controllo successivo
