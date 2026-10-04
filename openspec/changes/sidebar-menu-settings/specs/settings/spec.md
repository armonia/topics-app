# Settings: ogni impostazione nel menu utente

## ADDED Requirements

### Requirement: USERMENU-01 — Le preferenze di tutti i giorni si cambiano dentro il menu utente, con il controllo vero

Il menu utente SHALL avere un livello «Aspetto» con, nell'ordine: Tema
(segmento a tre: chiaro, scuro, sistema), Testo (passo da 12 a 18 px),
Larghezza chat (passo da 600 a 1300 px a 20 px, con «Piena» come passo dopo 1300), Densità
(segmento a due), Finestre fluttuanti (interruttore, solo nel guscio desktop),
Lingua (la `Select` dell'app) e, in fondo, il rimando alle scorciatoie da
tastiera.

Ogni controllo SHALL applicare il valore al cambio, senza «Salva», e SHALL
scrivere nello stesso deposito di oggi (`saveSettings`, `setTheme`,
`pushOutputLanguage`). Il livello NON SHALL avere un'anteprima: il menu non
copre la chat e il cambio si vede dal vivo.

La riga del livello SHALL dire in coda come sta (per esempio «Sistema · 13
px»), come già fa Vista.

Il menu utente SHALL tenere solo chi sei e com'è l'app: l'account col suo
Piano, le persone, i Dispositivi con le Macchine, Aspetto, Notifiche, Vista,
Pannelli, Cronologia e Sistema. I moduli che non sono l'account (Provider e
chiavi, Strumenti MCP, Calendario) vivono dove si usano (SETHOME-01).

#### Scenario: cambiare tema dal menu
- **GIVEN** il tema `system`
- **WHEN** apro il menu utente, il livello Aspetto, e scelgo «Scuro»
- **THEN** la pagina ha la classe `dark` senza chiudere il menu
- **AND** la coda della riga Aspetto dice «Scuro»
- **AND** `GET /api/ui-state/theme` rilegge `dark`

#### Scenario: il testo con la tastiera
- **GIVEN** il fuoco sul passo Testo a 13
- **WHEN** premo freccia su due volte
- **THEN** il valore è 15 e il `font-size` della radice dell'app (`App.tsx:1425`) è `15px`

#### Scenario: niente anteprima
- **WHEN** il livello Aspetto è aperto
- **THEN** non contiene un riquadro di anteprima dei messaggi

### Requirement: USERMENU-02 — Vista dice lo stato che c'è, non quello che verrà

Il livello «Vista» SHALL avere: Archiviati (interruttore), Ordine (segmento
Cronologico / Per stato, con quello attivo selezionato) e Riga della board
(interruttore, spostato da Aspetto). Nessuna voce SHALL avere come etichetta il
modo successivo al clic.

#### Scenario: l'ordine attivo si legge
- **GIVEN** la colonna in ordine cronologico
- **THEN** il segmento «Cronologico» ha `aria-checked="true"`
- **WHEN** scelgo «Per stato»
- **THEN** la colonna si raggruppa per stato e il segmento lo dice

#### Scenario: la riga della board
- **WHEN** spengo «Riga della board» in Vista
- **THEN** la riga della board sparisce dalla colonna
- **AND** Aspetto non ha più quell'interruttore

### Requirement: USERMENU-03 — Le preferenze delle notifiche hanno una casa sola, e il campanello ci porta

Il menu utente SHALL avere un livello «Notifiche» con TUTTO quel che oggi sta
nella voce Notifiche delle Impostazioni, e nient'altro altrove:

- notifiche (interruttore generale), suono e «anche sulla chat aperta»
  (interruttori, disattivati se il generale è spento);
- lo stato del permesso dei banner di sistema con il tasto che quello stato
  consente, come vuole NOTIF-PERM-01;
- l'accesso completo al disco per rispettare «Non disturbare», con «Concedi»,
  presente solo quando il cancello è bloccato;
- «Questo dispositivo», livello figlio con lo stato dell'iscrizione push,
  «Attiva» solo quando premerlo fa qualcosa, e da iscritto «Ricevi qui»
  (interruttore), «Quando Topics è già aperto» (segmento: notifica di sistema /
  banner in Topics) e «Disattiva qui»;
- «Altri dispositivi», livello figlio con un interruttore push per ciascuno,
  presente solo se ce n'è almeno uno;
- i progetti silenziati con «Riattiva» (l'elenco c'è solo se non è vuoto).

L'ingranaggio del pannello del campanello SHALL aprire il menu utente con il
livello Notifiche già aperto (`topics:open-user-menu`), sul desktop dalla card
e sul telefono dal menu del titolo. Le Impostazioni NON SHALL avere una voce
Notifiche.

#### Scenario: dal campanello
- **WHEN** apro il campanello e premo l'ingranaggio
- **THEN** è aperto il menu utente con il livello Notifiche visibile
- **AND** nessun `settings-panel` è montato

#### Scenario: niente si perde nello spostamento
- **GIVEN** il permesso dei banner «non ancora deciso» e questo dispositivo iscritto
- **WHEN** apro il livello Notifiche
- **THEN** c'è il tasto che chiede il permesso al sistema
- **AND** il livello «Questo dispositivo» ha `push-when-open-native`, `push-when-open-in-app` e `push-unsubscribe`

#### Scenario: silenziare e riattivare
- **GIVEN** un progetto silenziato dal suo menu nella colonna
- **THEN** il livello Notifiche lo elenca
- **WHEN** premo «Riattiva»
- **THEN** il progetto esce da `mutedProjects` e dall'elenco

### Requirement: USERMENU-04 — I dispositivi si rinominano e si revocano dove li vedi

Il livello «Dispositivi» del menu utente, sul desktop e sul telefono
(USERMENU-09), SHALL permettere, su ogni dispositivo appaiato: rinominare (il
nome diventa un campo nella riga, Invio salva, Esc annulla) e revocare (la riga
diventa una conferma in linea con il fuoco su «Annulla», nessuna modale). Il
computer su cui gira il server NON SHALL avere né l'uno né l'altro.

Quando le persone sono più di una, ogni riga SHALL avere anche «Di chi è»: un
livello con le persone come scelta, che sposta il dispositivo sulla persona
scelta con la stessa route di oggi. Con una persona sola NON SHALL comparire.

Ogni dispositivo appaiato SHALL dire, sotto il nome, quando è stato visto
l'ultima volta (o che è connesso adesso) e da quale IP si è appaiato: questo
elenco è l'unico posto in cui si nota un accesso che non si riconosce. Se
l'elenco non si legge, il livello SHALL dirlo con «Riprova» invece di restare
vuoto.

I dispositivi revocati SHALL stare in un livello figlio «Revocati», presente
solo se ce n'è almeno uno. Ogni revocato SHALL dire quando è stato revocato. Il livello NON SHALL avere una riga che apre
un'altra copia dell'elenco. Le richieste dei computer remoti, se ci sono, SHALL
comparire in cima come una riga che apre il livello Nodi del menu utente.

#### Scenario: revocare dal menu
- **GIVEN** un telefono appaiato
- **WHEN** premo il cestino sulla sua riga
- **THEN** la riga chiede conferma e il fuoco è su «Annulla»
- **WHEN** confermo
- **THEN** il telefono passa nel livello «Revocati»

#### Scenario: quando e da dove
- **GIVEN** un telefono visto tre ore fa, appaiato da 192.168.1.4, e un tablet revocato due giorni fa
- **WHEN** apro il livello «Dispositivi»
- **THEN** la riga del telefono dice «visto 3 h fa · da 192.168.1.4»
- **AND** nel livello «Revocati» il tablet dice «revocato 2 g fa»

#### Scenario: elenco che non si legge
- **GIVEN** la route dei dispositivi non risponde
- **WHEN** apro il livello «Dispositivi»
- **THEN** il livello dice che non riesce a leggere l'elenco e offre «Riprova»
- **WHEN** la route torna a rispondere e premo «Riprova»
- **THEN** compare l'elenco

#### Scenario: di chi è
- **GIVEN** due persone e un telefono attribuito alla prima
- **WHEN** dalla riga del telefono apro «Di chi è» e scelgo la seconda
- **THEN** la riga dice che il telefono è della seconda

#### Scenario: niente seconda copia
- **THEN** il livello Nodi del menu utente non contiene l'elenco dei dispositivi
- **AND** contiene `settings-node-pair`

### Requirement: USERMENU-05 — Chi sei sta nella tab Profilo, l'account in cima al menu

Il menu utente NON SHALL avere livelli Profilo, Seguaci o Organizzazione da
compilare. Nome, foto, bio, amici, seguaci, seguiti, privacy e organizzazione
SHALL cambiarsi dalla tab Profilo.

Ciò che oggi sta SOLO in quelle voci SHALL avere una casa nella tab prima che
le voci escano:

- «Persone», l'elenco di chi c'è da seguire, SHALL essere un pannello della
  tab accanto a seguaci e seguiti;
- «Fuori da Topics» SHALL essere un pannello della tab accanto a Privacy, con
  le cifre, il banner, la pagina pubblica (Pubblica, Apri, Copia, Revoca, e
  «pubblica il costo» come sua sotto-opzione, APPSET-07 invariato) e la
  presenza Discord.

Accedi ed esci SHALL esistere in un solo posto su ciascuno schermo: il blocco
account in cima al menu utente, che sul telefono sta in cima al menu del titolo
(USERMENU-09). Ogni collegamento che oggi apre una voce tolta SHALL aprire la
stessa pagina nella tab Profilo.

#### Scenario: un collegamento alla pagina dell'organizzazione
- **WHEN** qualcosa chiede la pagina dell'organizzazione (`apriProfilo('organization')`)
- **THEN** si apre la tab Profilo sulla pagina dell'organizzazione

#### Scenario: la pagina pubblica ha una casa
- **WHEN** apro la tab Profilo, pannello «Fuori da Topics»
- **THEN** ci sono `profile-public-publish` e il «pubblica il costo»
- **AND** una revoca rifiutata mostra `profile-public-error` accanto al tasto e lascia il link

#### Scenario: le persone da seguire hanno una casa
- **WHEN** apro la tab Profilo, pannello «Persone»
- **THEN** c'è `list-people`

#### Scenario: l'account una volta, su tutti e due gli schermi
- **THEN** la tab Profilo non ha un campo per accedere
- **AND** il blocco account del menu utente ce l'ha, a 1400x900 nella card e a 390x844 nel menu del titolo

### Requirement: USERMENU-06 — Ogni impostazione ha una casa sola, dove si usa

Ogni chiave di `AppSettings`, ogni preferenza dell'interfaccia e ogni modulo
da compilare SHALL stare in esattamente UNA superficie; i comandi (pannelli,
cronologia), le scorciatoie da tastiera e i comandi della palette verso la
stessa superficie non contano come porte. Un test unitario SHALL elencare le
chiavi di `AppSettings` e fallire se una chiave non ha una casa dichiarata o ne
ha due.

NON SHALL esistere un pannello o una finestra Impostazioni, né una riga o una
pill che ne apra uno, né una sezione «Impostazioni» in nessun posto. Le
preferenze di tutti i giorni (Aspetto, Notifiche, Vista) e i due moduli che
SONO l'account e le sue macchine (Piano, sotto l'account; Macchine, dentro
Dispositivi: aggiungere un nodo, MACHINE-02, e le richieste da altri computer)
SHALL essere livelli del menu utente: i moduli larghi 400 px e mai più della
finestra meno i margini, con l'intestazione fissa e il corpo che scorre sotto
l'altezza massima del menu; sul telefono fogli dal basso a tutta larghezza.
Provider e chiavi, Strumenti MCP e Calendario SHALL vivere dove si usano
(SETHOME-01).

Un modulo, in un livello o nel suo pannello, SHALL comportarsi da modulo: ogni
tasto battuto in un campo (lettere, spazio, frecce, Home, End, Invio) SHALL
arrivare al campo; Escape in un campo SHALL chiudere solo quel livello o quel
pannello; Tab SHALL restare dentro; una conferma chiesta da lì e la lista di
una `Select` aperta da lì NON SHALL chiudere chi li ospita. Un livello aperto
col passaggio del mouse SHALL restare aperto, quando il puntatore se ne va,
appena lo si usa (un clic o un tasto dentro): la sua conferma e un testo
scritto a metà non SHALL perdersi. Il contenuto di un livello o di un pannello
con un modulo SHALL avere il ruolo `dialog` col nome del modulo, non `menu`.

⌘, SHALL aprire il menu utente con il fuoco sulla prima riga; premuto col menu
già aperto NON SHALL rimontarlo (un testo scritto a metà resta). L'ingranaggio
del campanello apre Notifiche, la riga delle richieste dei Dispositivi apre
Macchine. Una preferenza senza controllo SHALL uscire da `AppSettings` (oggi
`voiceMode`); una che si aggiunge SHALL anche togliersi (oggi `keepLiveSites`,
da Sistema, Prestazioni).

#### Scenario: ⌘, apre il menu
- **WHEN** premo ⌘,
- **THEN** è aperto il menu utente con il fuoco sulla riga dell'account
- **AND** non esiste nessun elemento `settings-panel` né `topics-menu-settings`
- **AND** il menu ha la riga Piano e non le righe Provider AI, Strumenti, Calendario, Nodi

#### Scenario: ⌘, col menu aperto
- **GIVEN** il livello Piano aperto e un gettone scritto a metà
- **WHEN** premo ⌘,
- **THEN** il fuoco è sulla riga dell'account, il livello è ancora aperto e il gettone è ancora nel campo

#### Scenario: un campo dentro un modulo
- **GIVEN** il pannello Provider e chiavi aperto e il campo della chiave di un provider
- **WHEN** scrivo una chiave e premo frecce, Home, End e poi Invio
- **THEN** ogni carattere è nel campo, il fuoco non lo lascia e la chiave parte al server
- **WHEN** apro la lista di una `Select` e premo Escape, poi Escape ancora
- **THEN** il primo chiude la lista, il secondo il pannello e basta

#### Scenario: una conferma dal livello
- **GIVEN** una licenza team e il livello Piano aperto
- **WHEN** premo «Togli la licenza» e poi «Annulla» nella conferma
- **THEN** il livello e il menu sono ancora aperti

#### Scenario: un livello aperto al passaggio del mouse, poi usato
- **GIVEN** il livello Piano aperto solo passando col mouse sulla sua riga, senza clic
- **WHEN** premo «Togli la licenza» e porto il mouse su «Annulla» nella conferma
- **THEN** il livello è ancora aperto dietro la conferma
- **WHEN** scrivo un gettone a metà e il mouse esce dal livello
- **THEN** il livello è ancora aperto e il gettone è ancora nel campo

#### Scenario: una chiave senza casa
- **GIVEN** una chiave aggiunta ad `AppSettings` senza una casa dichiarata
- **THEN** il test delle porte fallisce nominandola

### Requirement: USERMENU-07 — Il menu si usa da tastiera e dal telefono

Il primo livello del menu utente SHALL muovere il fuoco con freccia su, freccia
giù, Home ed End. Nei livelli di preferenze il segmento SHALL essere un
`radiogroup` (frecce sinistra e destra cambiano e applicano), il passo uno
`spinbutton`, l'interruttore `role="switch"`.

Sotto 768 px i livelli del menu utente (Piano, Dispositivi, Nodi, Provider AI,
Strumenti, Calendario, Aspetto, Notifiche, Vista) SHALL essere nel menu del
titolo, aperti come foglio a tutta larghezza, con bersagli di almeno 44 px.

#### Scenario: tutto da tastiera
- **WHEN** apro il menu dalla card, scendo con le frecce fino ad Aspetto, premo freccia destra e poi freccia giù
- **THEN** il fuoco è sul segmento del tema
- **AND** freccia destra cambia il tema

#### Scenario: telefono
- **GIVEN** 390x844
- **WHEN** apro il menu del titolo e tocco Aspetto
- **THEN** il livello è un foglio e nessun bersaglio è sotto 44 px

### Requirement: USERMENU-08 — Il menu si muove poco, e con il meccanismo di tutti

Il pannello e i livelli SHALL entrare con `.popover-enter` e uscire con
`lib/exitGhost.ts`, ai tempi di `MOTION.instant`. Il pallino dell'interruttore
e l'indicatore del segmento SHALL muoversi con `--motion-instant` e
`--ease-standard`. Nessun controllo nuovo SHALL scrivere una durata o una curva
a mano. Con `prefers-reduced-motion: reduce` nulla SHALL animarsi.

#### Scenario: riduci movimento
- **GIVEN** `prefers-reduced-motion: reduce`
- **WHEN** cambio il tema dal segmento
- **THEN** l'indicatore è al posto nuovo nello stesso frame, senza transizione

### Requirement: USERMENU-09 — Sul telefono il menu del titolo ha lo stesso blocco dell'identità

Sotto 768 px il menu del titolo SHALL avere in cima lo stesso blocco
dell'identità del menu utente del desktop: account (accedi, esci), Amici,
Gruppi, Dispositivi. SHALL essere lo stesso componente montato in due host, non
una seconda copia.

Le voci delle Impostazioni che oggi sono l'unica casa sul telefono di accedi,
esci, rinomina e revoca NON SHALL uscire dal pannello prima che questo blocco
sia sul telefono.

#### Scenario: accedere e revocare dal telefono
- **GIVEN** 390x844 e un dispositivo appaiato oltre a questo
- **WHEN** apro il menu del titolo
- **THEN** in cima c'è il blocco account con il campo per accedere
- **AND** dal livello Dispositivi revoco l'altro dispositivo con la conferma in linea

### Requirement: USERMENU-10 — La riga di un modulo dice come sta, senza aprire niente

Ogni riga che apre un modulo SHALL dire in coda come sta adesso, breve e in
cifre tabellari, come la coda di Vista, lì dove la riga sta:

- Piano, sotto l'account nel menu utente: il piano di Topics da
  `/api/license`, «Gratuito» o «Team · N posti»; quando la scadenza è entro
  trenta giorni (`scadenzaVicina`) l'avviso SHALL venire PRIMA («Scade tra
  N g · Team · 5 posti», «Scaduto · …»), nel tono di avviso, perché la coda si
  tronca a destra;
- Provider e chiavi, al piede di ogni selettore del modello: quanti provider
  possono eseguire un turno («3 pronti», `topics` escluso perché è
  l'interruttore sopra l'elenco), o, nel tono di avviso, «Nessuno pronto» e
  «<provider> non pronto» quando non lo è quello scelto. L'abbonamento Claude
  (Claude Code, o Topics, il runtime predefinito, che entra con le stesse
  credenziali) SHALL stare nella scheda di Claude Code («Max 20x · sett. 67%»)
  e, con le due finestre per intero, nel suo dettaglio; nel selettore SHALL
  esserci solo un avviso corto nel titolo Anthropic, e solo da
  `PLAN_USAGE_WARN_AT` in su (emendamento del 04/10, model-selector: prima era
  una riga compatta sotto Claude Code e accanto ai modelli Claude, e in cima al
  pannello). Il server SHALL esporre dell'abbonamento solo due
  etichette (`subscriptionType`, `rateLimitTier`), mai un token né il percorso
  delle credenziali; un tipo che il client non conosce NON SHALL essere
  nominato;
- Strumenti, nel «+» del composer: quanti server MCP rispondono, «Spenti» o
  «Nessuno»; senza montare la flotta (`?peek=1`), e senza dire «Nessuno» quando
  la flotta non è ancora montata;
- Calendario, nel menu della tessera del calendario: «Collegato», «In pausa» o
  «Non collegato»;
- Macchine, dentro Dispositivi: quanti nodi; le richieste da altri computer
  SHALL essere un badge con il numero, anche sulla riga Dispositivi.

Le code SHALL leggersi solo a superficie aperta (nessun polling a menu chiuso)
e di nuovo quando il loro livello si chiude, così un cambio fatto dentro si
vede subito. Le parole SHALL venire da funzioni pure con test, nelle due
lingue.

#### Scenario: il piano senza aprire niente
- **GIVEN** il piano gratuito
- **WHEN** apro il menu utente
- **THEN** la riga Piano dice «Gratuito» senza aprire il suo livello

#### Scenario: il piano Claude
- **GIVEN** le credenziali della CLI con `subscriptionType` `max` e `rateLimitTier` `default_claude_max_20x`, e la finestra di 5 ore al 42%
- **WHEN** apro il selettore del modello di una chat che usa il predefinito
- **THEN** il titolo Anthropic non porta nessun avviso, perché nessuna finestra è al 50%
- **AND** nel livello «Provider e chiavi» la scheda di Claude Code dice «Max 20x», e il suo dettaglio mostra «Abbonamento Claude Max 20x» con la finestra di 5 ore al 42%
- **AND** lo snapshot dei provider serializzato non contiene nessun token

#### Scenario: la scadenza vicina
- **GIVEN** una licenza team da 5 posti che scade fra 12 giorni
- **THEN** la riga Piano dice «Scade tra 12 g · Team · 5 posti» nel tono di avviso

### Requirement: SETHOME-01 — Ogni modulo vive dove si usa

Richiesta del 03/10: «ma no il menu di opzioni l'avevamo proprio tolto perchè
smistiamo tutto». Ogni modulo SHALL aprirsi accanto alla cosa che configura,
SHALL dire lì come sta (USERMENU-10) e SHALL essere raggiungibile dalla palette
col proprio nome:

- Provider e chiavi (chiavi, endpoint, CLI, runtime, predefiniti, checkpoint):
  una riga in FONDO a ogni selettore del modello (composer della chat,
  composer e cassetto della card, predefiniti della board), che apre
  «Provider e chiavi» come livello dello STESSO pannello, con ‹ ed Escape per
  tornare ai modelli; l'avviso dei limiti del piano apre il selettore del pane a
  fuoco sul dettaglio di Claude Code, o, senza un selettore sullo schermo, il
  foglio al centro (emendamento del 04/10, model-selector: prima era un
  pannello largo circa 420 px ancorato al selettore o all'avviso);
- Strumenti MCP (server e permessi): la riga «Strumenti» del «+» del composer
  della chat, che apre il pannello ancorato al «+»; aprire un composer o il suo
  «+» NON SHALL montare la flotta;
- Calendario (il feed iCal): la riga «Calendario» del menu della tessera
  fissata di una pagina di calendario, che apre il pannello ancorato alla
  tessera; chi non ha fissato un calendario non vede niente nella colonna, e lo
  trova dalla palette;
- Piano: sotto l'account, nel menu utente;
- Macchine: dentro il livello Dispositivi, col badge delle richieste sulla riga
  Dispositivi;
- la palette SHALL avere i comandi «Provider e chiavi», «Strumenti MCP»,
  «Calendario», «Piano», «Macchine», «Aspetto», «Notifiche», ognuno verso la
  sua casa, e NON SHALL avere una pill o un comando «Impostazioni».

I tre pannelli fuori dal menu SHALL essere disegnati da UN solo ospite
(`Settings/HomePanelHost`): ancorati all'elemento che li ha chiesti o, senza,
alla casa se è a schermo (`data-home-anchor`, col centro dentro la finestra:
una tessera scivolata fuori con la colonna chiusa non lo è); senza nessuno dei
due, sul desktop, un foglio al centro della finestra; sul telefono sempre un
foglio dal basso a tutta larghezza. Sul desktop un pannello ancorato SHALL
essere largo circa 420 px, mai più della finestra meno i margini, e scorrere
dentro. «Provider e chiavi» fa eccezione (emendamento del 04/10, model-selector):
l'ospite passa la richiesta al chip del modello a schermo (quello del pane a
fuoco per primo), che apre il proprio selettore su quel livello o sul dettaglio
chiesto; senza chip, sul desktop, il foglio al centro è largo 44rem come il
selettore, e la lista non ha ‹. Il menu da cui è partita la richiesta si chiude, ma un menu che
contiene l'ancora nel suo corpo (le impostazioni della board attorno al loro
selettore) SHALL restare aperto. All'apertura il fuoco SHALL essere nel
pannello e il primo Tab SHALL portarlo a un suo controllo. Alla chiusura il
fuoco SHALL tornare all'ancora.

#### Scenario: i provider dal selettore
- **GIVEN** una chat aperta
- **WHEN** apro il selettore del modello
- **THEN** l'ultima riga è «Provider e chiavi» con in coda quanti sono pronti
- **WHEN** la premo
- **THEN** «Provider e chiavi» prende il posto dei modelli nello stesso pannello, con la stessa posizione e larghezza
- **WHEN** apro la scheda di un provider, scrivo una chiave e premo Invio
- **THEN** la chiave parte al server e la risposta si legge nel dettaglio
- **WHEN** premo Escape due volte
- **THEN** torno alla lista e poi ai modelli, con la ricerca e lo scorrimento di prima

#### Scenario: il primo Tab resta nel pannello
- **GIVEN** il pannello Provider e chiavi appena aperto dal selettore, o Strumenti MCP dalla palette
- **WHEN** premo Tab, e poi Maiusc+Tab
- **THEN** ogni volta il fuoco è su un controllo del pannello

#### Scenario: i provider dai predefiniti della board
- **GIVEN** le impostazioni della board aperte, a 1280×800
- **WHEN** apro il loro selettore del modello e premo «Provider e chiavi»
- **THEN** il livello si apre nello stesso pannello del selettore e le impostazioni della board restano aperte
- **WHEN** premo Escape
- **THEN** si torna ai modelli del selettore, e le impostazioni della board restano aperte

#### Scenario: il calendario con la colonna chiusa
- **GIVEN** una pagina di calendario fissata e la colonna chiusa con ⌘B
- **WHEN** scelgo «Calendario» nella palette
- **THEN** il pannello si apre come foglio al centro della finestra, non appeso alla tessera fuori schermo
- **WHEN** premo Escape
- **THEN** il fuoco non è sulla tessera

#### Scenario: gli strumenti dal composer
- **GIVEN** una chat aperta, e la flotta MCP con due server che rispondono
- **WHEN** apro il «+» del composer
- **THEN** la riga «Strumenti» dice «2 attivi», e nessuna richiesta ha montato la flotta
- **WHEN** la premo e revoco un permesso
- **THEN** il pannello è accanto al «+» e il permesso non c'è più sul server

#### Scenario: il calendario dalla sua tessera
- **GIVEN** una pagina di calendario fissata e nessun feed
- **WHEN** apro il menu della tessera
- **THEN** la riga «Calendario» dice «Non collegato»
- **WHEN** la premo, scrivo l'indirizzo del feed e salvo
- **THEN** il pannello è accanto alla tessera e dice che un indirizzo è salvato
- **AND** riaprendo il menu della tessera la riga dice «Collegato»

#### Scenario: il piano sotto l'account
- **WHEN** apro il menu utente
- **THEN** la riga Piano è subito sotto l'account e dice «Gratuito»
- **WHEN** apro il livello, scrivo un gettone e premo «Installa»
- **THEN** il gettone parte al server

#### Scenario: le macchine in Dispositivi
- **GIVEN** una richiesta da un altro computer in attesa
- **WHEN** apro il menu utente
- **THEN** la riga Dispositivi porta un badge con 1
- **WHEN** apro Dispositivi e premo la riga delle richieste
- **THEN** si apre il livello Macchine con le richieste e l'aggiunta di un nodo
- **WHEN** scrivo l'indirizzo di un nodo e premo Invio
- **THEN** l'indirizzo parte al server e l'esito si legge nel livello

#### Scenario: i comandi della palette
- **GIVEN** nessuna chat aperta
- **WHEN** cerco «Provider e chiavi» nella palette e lo scelgo
- **THEN** il pannello si apre come foglio al centro della finestra
- **AND** «Strumenti MCP» e «Calendario» aprono i loro pannelli, «Piano», «Macchine», «Aspetto» e «Notifiche» i loro livelli del menu utente
- **AND** la palette non ha nessuna voce «Impostazioni»

#### Scenario: la palette con una chat aperta
- **GIVEN** una chat aperta, col suo chip del modello
- **WHEN** scelgo «Provider e chiavi» nella palette
- **THEN** si apre il selettore del modello di quella chat sul livello «Provider e chiavi», e nessun foglio al centro
- **WHEN** premo Escape due volte
- **THEN** torno ai modelli e poi il selettore si chiude, col fuoco sul chip

#### Scenario: niente impostazioni nel menu utente
- **WHEN** apro il menu utente
- **THEN** non ci sono le righe Provider AI, Strumenti, Calendario, Nodi né Impostazioni

#### Scenario: l'avviso dei limiti
- **GIVEN** l'avviso dei limiti del piano Claude nella colonna
- **WHEN** apro i dettagli e premo «Provider e chiavi»
- **THEN** si apre il selettore del pane a fuoco sul dettaglio di Claude Code (senza un selettore sullo schermo, il foglio al centro), senza il menu utente, e Escape fino in fondo riporta il fuoco sull'avviso

## MODIFIED Requirements

### Requirement: SETORG-01 — Le impostazioni parlano italiano, e i gruppi si trovano da lì

Segnalato: le impostazioni non erano ben divise, i gruppi non si vedevano, e nel
profilo era accorpata la possibilità di aggiungere altre persone, che lì non ha
senso, perché il profilo è di una persona sola.

Le righe e i livelli del menu utente, moduli compresi, SHALL essere nella
lingua dell'interfaccia.

Il banner da mettere in un documento condiviso SHALL essere copiabile, già
pronto, dalla tab Profilo.

I GRUPPI SHALL trovarsi dal menu utente (livello Gruppi) e amministrarsi dalla
tab Profilo, pagina dell'organizzazione. Il menu utente NON SHALL averne una
seconda copia.

#### Scenario: il menu delle impostazioni
- **GIVEN** la lingua predefinita
- **THEN** le righe e i livelli del menu utente SHALL leggersi in quella lingua

#### Scenario: i gruppi
- **GIVEN** il menu utente aperto
- **THEN** i gruppi SHALL essere raggiungibili dal livello Gruppi, e «Gestisci» SHALL aprire la tab Profilo sulla pagina dell'organizzazione

### Requirement: APPSET-03 — Due voci, due contenuti, e ogni porta arriva alla propria

«Chi sei» e «che macchine hai» SHALL vivere in due superfici distinte: la tab
Profilo e il livello Dispositivi del menu utente. Erano una voce sola:
l'identificativo diceva `devices` mentre l'etichetta diceva «Profilo».

Ogni collegamento diretto SHALL atterrare sulla PROPRIA superficie:
`openUserMenu('devices')` apre il menu utente sul livello Dispositivi,
`apriProfilo('profile')` la tab Profilo.

La superficie attiva SHALL essere leggibile dalla marcatura di accessibilità
che già scrive (`aria-expanded` sulla riga del livello, la tab attiva).

#### Scenario: le due porte
- **GIVEN** i due collegamenti diretti
- **THEN** ciascuno SHALL aprire la propria superficie, e i due contenuti SHALL differire

### Requirement: APPSET-05 — Le voci delle impostazioni sono voci di PRIMO livello, tradotte davvero

Le pagine dell'identità (profilo, chi segue, persone da seguire, riservatezza,
fuori da Topics, organizzazione) SHALL essere raggiungibili con un gesto dalla
tab Profilo, ciascuna con il suo titolo. Il menu utente NON SHALL contenerne nessuna.

Nessuna voce SHALL essere ripetuta, e ognuna SHALL avere la propria etichetta.

Nella seconda lingua le voci SHALL essere TRADOTTE DAVVERO, non ripiegate sulla
prima, e la verifica SHALL usare il criterio che sa distinguere «assente»
da «uguale».

L'interruttore a TRE stati (automatico, acceso, spento) SHALL fare andata e
ritorno senza collassare: scegliere «spento» SHALL scrivere un valore esplicito
che batte l'ambiente, e scegliere «automatico» SHALL CANCELLARE la scelta, non
scriverne una.

#### Scenario: la seconda lingua
- **GIVEN** le voci nella seconda lingua
- **THEN** NON SHALL essere ripiegate sulla prima

#### Scenario: «automatico»
- **GIVEN** la scelta automatica
- **THEN** SHALL cancellare la scelta, non scriverne una
