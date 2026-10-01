# Settings: le preferenze nel menu utente, i moduli nelle Impostazioni

## ADDED Requirements

### Requirement: USERMENU-01 — Le preferenze di tutti i giorni si cambiano dentro il menu utente, con il controllo vero

Il menu utente SHALL avere un livello «Aspetto» con, nell'ordine: Tema
(segmento a tre: chiaro, scuro, sistema), Testo (passo da 12 a 18 px),
Larghezza chat (passo da 600 a 1300 px a 20 px, con «Piena»), Densità
(segmento a due), Finestre fluttuanti (interruttore, solo nel guscio desktop),
Lingua (la `Select` dell'app) e, in fondo, il rimando alle scorciatoie da
tastiera.

Ogni controllo SHALL applicare il valore al cambio, senza «Salva», e SHALL
scrivere nello stesso deposito di oggi (`saveSettings`, `setTheme`,
`pushOutputLanguage`). Il livello NON SHALL avere un'anteprima: il menu non
copre la chat e il cambio si vede dal vivo.

La riga del livello SHALL dire in coda come sta (per esempio «Sistema · 13
px»), come già fa Vista.

Nessuna preferenza che chiede di scrivere una chiave, un URL o un token SHALL
stare nel menu.

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

Il menu utente SHALL avere un livello «Notifiche» con: notifiche (interruttore
generale), suono e «anche sulla chat aperta» (interruttori, disattivati se il
generale è spento), lo stato delle notifiche su questo dispositivo con «Attiva»
solo quando premerlo fa qualcosa, e i progetti silenziati con «Riattiva»
(l'elenco c'è solo se non è vuoto).

L'ingranaggio del pannello del campanello SHALL aprire il menu utente con il
livello Notifiche già aperto (`topics:open-user-menu`), sul desktop dalla card
e sul telefono dal menu del titolo. Le Impostazioni NON SHALL avere una voce
Notifiche.

#### Scenario: dal campanello
- **WHEN** apro il campanello e premo l'ingranaggio
- **THEN** è aperto il menu utente con il livello Notifiche visibile
- **AND** nessun `settings-panel` è montato

#### Scenario: silenziare e riattivare
- **GIVEN** un progetto silenziato dal suo menu nella colonna
- **THEN** il livello Notifiche lo elenca
- **WHEN** premo «Riattiva»
- **THEN** il progetto esce da `mutedProjects` e dall'elenco

### Requirement: USERMENU-04 — I dispositivi si rinominano e si revocano dove li vedi

Il livello «Dispositivi» del menu utente SHALL permettere, su ogni dispositivo
appaiato: rinominare (il nome diventa un campo nella riga, Invio salva, Esc
annulla) e revocare (la riga diventa una conferma in linea con il fuoco su
«Annulla», nessuna modale). Il computer su cui gira il server NON SHALL avere
né l'uno né l'altro.

I dispositivi revocati SHALL stare in un livello figlio «Revocati», presente
solo se ce n'è almeno uno. Il livello NON SHALL avere una riga che apre
un'altra copia dell'elenco. Le richieste dei computer remoti, se ci sono, SHALL
comparire in cima come una riga che apre Impostazioni, Computer remoti.

#### Scenario: revocare dal menu
- **GIVEN** un telefono appaiato
- **WHEN** premo il cestino sulla sua riga
- **THEN** la riga chiede conferma e il fuoco è su «Annulla»
- **WHEN** confermo
- **THEN** il telefono passa nel livello «Revocati»

#### Scenario: niente seconda copia
- **THEN** il pannello Impostazioni non contiene l'elenco dei dispositivi

### Requirement: USERMENU-05 — Chi sei sta nella tab Profilo, l'account in cima al menu

Il pannello Impostazioni NON SHALL avere le voci Profilo, Seguaci e
Organizzazione. Nome, foto, bio, amici, seguaci, privacy e organizzazione
SHALL cambiarsi dalla tab Profilo; la presenza Discord e «pubblica il costo»
SHALL stare nel menu Privacy della tab, sotto «Fuori da Topics».

Accedi ed esci SHALL esistere in un solo posto: il blocco account in cima al
menu utente. Ogni collegamento che oggi apre una voce tolta SHALL aprire la
stessa pagina nella tab Profilo.

#### Scenario: un collegamento vecchio
- **WHEN** qualcosa chiama `openSettings('organization')`
- **THEN** si apre la tab Profilo sulla pagina dell'organizzazione

#### Scenario: l'account una volta
- **THEN** né il pannello Impostazioni né la tab Profilo hanno un campo per accedere
- **AND** il blocco account del menu utente ce l'ha

### Requirement: USERMENU-06 — Ogni preferenza ha una porta, e le Impostazioni tengono solo i moduli

Ogni chiave di `AppSettings` e ogni preferenza dell'interfaccia SHALL essere
modificabile da esattamente UNA superficie; i comandi (pannelli, cronologia) e
le scorciatoie da tastiera verso la stessa superficie non contano come porte.
Un test unitario SHALL elencare le chiavi di `AppSettings` e fallire se una
chiave non ha una casa dichiarata o ne ha due.

Il pannello Impostazioni SHALL avere esattamente le voci Provider AI,
Strumenti, Calendario, Piano, Computer remoti, e SHALL aprirsi con ⌘, e dalla
riga «Impostazioni» del menu utente. Una preferenza senza controllo SHALL
uscire da `AppSettings` (oggi `voiceMode`); una che si aggiunge SHALL anche
togliersi (oggi `keepLiveSites`, da Sistema, Prestazioni).

#### Scenario: le voci del pannello
- **WHEN** premo ⌘,
- **THEN** il pannello elenca cinque voci, nell'ordine Provider AI, Strumenti, Calendario, Piano, Computer remoti

#### Scenario: una chiave senza casa
- **GIVEN** una chiave aggiunta ad `AppSettings` senza una casa dichiarata
- **THEN** il test delle porte fallisce nominandola

### Requirement: USERMENU-07 — Il menu si usa da tastiera e dal telefono

Il primo livello del menu utente SHALL muovere il fuoco con freccia su, freccia
giù, Home ed End. Nei livelli di preferenze il segmento SHALL essere un
`radiogroup` (frecce sinistra e destra cambiano e applicano), il passo uno
`spinbutton`, l'interruttore `role="switch"`.

Sotto 768 px i livelli Aspetto, Notifiche e Vista SHALL essere nel menu del
titolo, aperti come foglio con «Indietro», con bersagli di almeno 44 px.

#### Scenario: tutto da tastiera
- **WHEN** apro il menu dalla card, scendo con le frecce fino ad Aspetto e premo freccia destra
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

## MODIFIED Requirements

### Requirement: SETORG-01 — Le impostazioni parlano italiano, e i gruppi si trovano da lì

Segnalato: le impostazioni non erano ben divise, i gruppi non si vedevano, e nel
profilo era accorpata la possibilità di aggiungere altre persone, che lì non ha
senso, perché il profilo è di una persona sola.

Il pannello Impostazioni e i livelli di preferenze del menu utente SHALL essere
nella lingua dell'interfaccia.

Il banner da mettere in un documento condiviso SHALL essere copiabile, già
pronto, dalla tab Profilo.

I GRUPPI SHALL trovarsi dal menu utente (livello Gruppi) e amministrarsi dalla
tab Profilo, pagina dell'organizzazione. Il pannello Impostazioni NON SHALL
averne una copia.

#### Scenario: il menu delle impostazioni
- **GIVEN** la lingua predefinita
- **THEN** le voci del pannello e dei livelli SHALL leggersi in quella lingua

#### Scenario: i gruppi
- **GIVEN** il menu utente aperto
- **THEN** i gruppi SHALL essere raggiungibili dal livello Gruppi, e «Gestisci» SHALL aprire la tab Profilo sulla pagina dell'organizzazione

### Requirement: APPSET-03 — Due voci, due contenuti, e ogni porta arriva alla propria

«Chi sei» e «che macchine hai» SHALL vivere in due superfici distinte: la tab
Profilo e il livello Dispositivi del menu utente. Erano una voce sola:
l'identificativo diceva `devices` mentre l'etichetta diceva «Profilo».

Ogni collegamento diretto SHALL atterrare sulla PROPRIA superficie:
`openSettings('devices')` apre il menu utente sul livello Dispositivi,
`apriProfilo('profile')` la tab Profilo.

La superficie attiva SHALL essere leggibile dalla marcatura di accessibilità
che già scrive (`aria-expanded` sulla riga del livello, la tab attiva).

#### Scenario: le due porte
- **GIVEN** i due collegamenti diretti
- **THEN** ciascuno SHALL aprire la propria superficie, e i due contenuti SHALL differire

### Requirement: APPSET-05 — Le voci delle impostazioni sono voci di PRIMO livello, tradotte davvero

Le pagine dell'identità (profilo, chi segue, riservatezza, organizzazione)
SHALL essere raggiungibili con un gesto dalla tab Profilo, ciascuna con il suo
titolo. Il pannello Impostazioni NON SHALL contenerne nessuna.

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
