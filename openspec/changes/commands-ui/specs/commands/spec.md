# Commands: ogni comando ha un senso in Topics

## ADDED Requirements

### Requirement: CMDUI-01 — Il menu «/» offre ciò che funziona nella chat aperta, in tre gruppi, letto dal motore

Il menu «/» del composer SHALL essere costruito per la chat aperta, sul motore che
il topic DICHIARA (CMD-08), in tre gruppi nell'ordine: «Topics» (i comandi che
Topics esegue o i controlli che apre), il gruppo del motore, «Le tue skill».

Il gruppo del motore SHALL venire dall'elenco che il motore stesso dà: per Claude
Code `system/init.slash_commands` e `system/commands_changed`; per gli agenti ACP
`available_commands_update`. Codex, le API e il motore di Topics NON SHALL avere
un gruppo del motore né il gruppo delle skill. Prima che la chat abbia un elenco
suo il menu SHALL usare l'ultimo elenco visto per lo stesso progetto e motore, e
NON SHALL avviare un processo solo per leggerlo.

Ogni nome SHALL passare per la mappa dei comandi di Topics, che gli dà un tipo
(`topics`, `control`, `engine`, `refused`, `hidden`) e dice se fa lavorare il
modello. Un nome `refused` o `hidden` NON SHALL comparire nel menu. Una riga che
fa lavorare il modello SHALL dirlo («turno»); una che apre un controllo SHALL
dire quale.

Le skill che Claude Code ha spente NON SHALL comparire.

#### Scenario: una chat Claude Code
- **GIVEN** una chat dichiarata `claude-code` la cui CLI ha mandato un `init` con `init`, `review`, `compact`, `agents` e la skill `vai`
- **WHEN** scrivo «/»
- **THEN** il menu ha i gruppi Topics, Claude Code e Le tue skill
- **AND** /init e /vai sono segnati «turno»
- **AND** /agents non c'è

#### Scenario: una chat Codex
- **GIVEN** una chat dichiarata `codex`
- **WHEN** scrivo «/»
- **THEN** il menu ha solo il gruppo Topics
- **AND** non offre /compact né alcuna skill

#### Scenario: nessun elenco ancora visto
- **GIVEN** un server appena avviato e una chat nuova che non ha ancora avviato la sua CLI
- **WHEN** scrivo «/»
- **THEN** il menu ha il gruppo Topics e le skill trovate nelle cartelle
- **AND** nessun processo CLI è stato avviato per costruirlo

#### Scenario: il filtro
- **WHEN** scrivo «/re»
- **THEN** restano solo i nomi che iniziano così, ognuno nel suo gruppo
- **AND** un gruppo senza righe non compare

### Requirement: CMDUI-02 — Un comando che in Topics ha un controllo apre quel controllo

/model, /effort, /context, /permissions e /fast scritti senza argomento (o scelti
dal menu) SHALL aprire, nel composer della chat, rispettivamente il selettore del
modello, il cursore dello sforzo, l'ispettore del contesto, il selettore
dell'autonomia e l'interruttore della modalità veloce, con il fuoco dentro. Con un
argomento valido SHALL applicarlo senza aprire niente. /mcp SHALL aprire il
livello Strumenti del menu utente e /config il menu utente.

Nessuno di questi SHALL arrivare al motore.

#### Scenario: /model scelto dal menu
- **GIVEN** una chat Claude Code
- **WHEN** scelgo /model dal menu «/»
- **THEN** il selettore del modello del composer è aperto
- **AND** la CLI non ha ricevuto nessun messaggio

#### Scenario: /model con un nome
- **WHEN** mando `/model opus`
- **THEN** il modello della chat è `opus` e nessun selettore è aperto

#### Scenario: /mcp
- **WHEN** mando /mcp
- **THEN** il menu utente è aperto sul livello Strumenti

### Requirement: CMDUI-03 — /resume elenca le sessioni Claude del progetto nate fuori da Topics e le apre come chat

/resume in una chat legata a un progetto SHALL aprire, sopra il composer, l'elenco
delle sessioni Claude Code di quel progetto che nessuna chat di Topics possiede,
dalla più recente, al massimo 50, con: titolo (quello dato con /rename, poi quello
generato, poi l'ultima domanda), ramo, quando, e «attiva adesso» se il transcript
è stato toccato negli ultimi 15 minuti. La parola dopo `/resume ` SHALL filtrare su
titolo e ramo.

Il titolo e il resto SHALL venire dalla coda del transcript, senza leggere il file
intero.

Scegliere una riga SHALL adottare la sessione (`POST /api/topics/adopt-claude`) e
aprire la chat che ne nasce; il turno dopo SHALL continuare la stessa sessione. Una
sessione attiva SHALL chiedere conferma prima. In una chat senza progetto, o con
l'elenco vuoto, SHALL rispondere con una scheda che dice perché e dove guardare.

/resume NON SHALL mai arrivare al motore.

#### Scenario: riprendere una sessione dal terminale
- **GIVEN** un progetto con due transcript non posseduti da Topics, uno con `custom-title` «Menu utente» e uno con solo `last-prompt`
- **WHEN** mando `/resume`
- **THEN** l'elenco mostra «Menu utente» e l'ultima domanda dell'altro, il più recente in cima
- **WHEN** scelgo «Menu utente»
- **THEN** si apre una chat nuova con la storia importata
- **AND** il turno dopo avvia la CLI con `--resume` e l'id di quella sessione

#### Scenario: una sessione già adottata
- **GIVEN** un transcript già legato a una chat di Topics
- **WHEN** mando `/resume`
- **THEN** quel transcript non è nell'elenco

#### Scenario: una sessione ancora attiva
- **GIVEN** un transcript toccato 2 minuti fa
- **WHEN** lo scelgo
- **THEN** una conferma dice che è ancora attiva in un terminale prima di adottarla

#### Scenario: nessun progetto
- **GIVEN** una chat senza progetto
- **WHEN** mando `/resume`
- **THEN** una scheda dice che /resume elenca le sessioni di un progetto
- **AND** il motore non ha ricevuto nessun messaggio

### Requirement: CMDUI-04 — La risposta di un comando è una scheda della pane, non un messaggio

Un comando che risponde con del testo (/status, /project, /goal, /rewind, /fork
quando rifiuta, l'esito di /compact, i nomi `refused`, le risposte locali della CLI
con `model: "<synthetic>"` e `num_turns: 0`) SHALL disegnare la risposta in una
scheda in coda ai messaggi della pane. La scheda SHALL restare finché la persona la
chiude, manda il messaggio dopo o un altro comando la sostituisce; NON SHALL avere
un timer.

La scheda NON SHALL essere salvata nel thread né entrare nella storia mandata al
motore; al ricarico NON SHALL esserci.

/compact SHALL mostrare la scheda «in corso» finché arriva l'esito: i token prima
e dopo, oppure il motivo del fallimento detto dalla CLI.

#### Scenario: /status resta
- **WHEN** mando `/status`
- **THEN** una scheda «Stato della sessione» mostra il modello, l'effort e l'autonomia
- **AND** dopo 6 secondi è ancora lì
- **WHEN** mando un messaggio
- **THEN** la scheda non c'è più

#### Scenario: una risposta locale della CLI
- **GIVEN** la CLI risponde a `/output-style` con un messaggio `<synthetic>` e `num_turns: 0`
- **THEN** il testo compare nella scheda
- **AND** non compare come messaggio dell'agente, né dopo un ricarico

#### Scenario: /compact fallisce
- **GIVEN** la CLI risponde a `/compact` con `compact_result: "failed"` e `compact_error: "Not enough messages to compact."`
- **THEN** la scheda passa da «in corso» a un errore che riporta quella frase

### Requirement: CMDUI-05 — /usage apre il misuratore del piano nel menu utente

Il livello Provider AI del menu utente SHALL mostrare in cima il piano Claude: per
la finestra di 5 ore e per la settimana una barra, la percentuale e quando si
azzera, dalle letture che i turni di Claude Code già mandano. Oltre la soglia
dell'avviso la barra SHALL cambiare colore. Senza una lettura SHALL dirlo. La coda
della riga Provider AI SHALL aggiungere la percentuale delle 5 ore.

/usage e /cost SHALL aprire il menu utente su quel livello, e NON SHALL arrivare
al motore.

#### Scenario: con una lettura
- **GIVEN** una lettura con la finestra di 5 ore al 38% e la settimana al 78%
- **WHEN** mando `/usage`
- **THEN** il menu utente è aperto sul livello Provider AI
- **AND** le due barre dicono 38% e 78% con l'ora di azzeramento
- **AND** la barra della settimana ha il colore dell'avviso

#### Scenario: senza lettura
- **GIVEN** nessuna lettura dal riavvio
- **WHEN** apro il livello
- **THEN** il blocco dice che la lettura arriva col primo turno di Claude Code

### Requirement: CMDUI-06 — Ogni motore ha i suoi comandi, detti per nome

/compact SHALL compattare su Claude Code (la CLI), su OpenClaw (il gateway) e sul
motore di Topics (la sua compattazione chiamata subito, con lo stesso separatore
di quella automatica); sugli altri motori NON SHALL essere offerto, e scritto SHALL
rispondere che quel motore non compatta a richiesta.

/clear, /new e /reset SHALL far dimenticare la sessione su ogni motore che ne ha
una, gli agenti ACP compresi (CMD-09). /reasoning SHALL esserci solo su OpenClaw,
e SHALL passare il suo argomento (`on`, `off`, `stream`).

#### Scenario: /compact sul motore di Topics
- **GIVEN** una chat sul motore di Topics sotto la soglia della compattazione
- **WHEN** mando `/compact`
- **THEN** la storia è compattata e compare il separatore con i token prima e dopo
- **AND** nessun turno del modello è partito

#### Scenario: /compact su Codex
- **GIVEN** una chat dichiarata `codex`
- **WHEN** scrivo `/compact` e lo mando
- **THEN** una scheda dice che Codex non compatta a richiesta
- **AND** Codex non ha ricevuto nessun messaggio

### Requirement: CMDUI-07 — Il menu si usa da tastiera e dal telefono, e /help è il menu

Il menu «/» e l'elenco di /resume SHALL usare il guscio di `SuggestionMenu`,
attaccato al composer anche sotto 768 px, e NON SHALL diventare un foglio. Le
frecce SHALL attraversare i gruppi senza fermarsi alle intestazioni; Invio e Tab
SHALL scegliere; Esc SHALL chiudere. Sul telefono ogni riga SHALL essere alta
almeno 44 px.

Scegliere un comando che non vuole argomenti SHALL eseguirlo; uno che li vuole
SHALL inserirlo con lo spazio.

/help SHALL aprire il menu «/» intero, con una riga in fondo che dice che i
comandi di Topics non costano e quelli segnati «turno» fanno lavorare il modello.

Il menu «+» del composer NON SHALL ripetere i comandi: SHALL avere una riga
«Comandi /» che apre il menu «/».

#### Scenario: tastiera
- **GIVEN** il menu «/» aperto sulla prima riga del gruppo Topics
- **WHEN** premo freccia giù fino alla prima riga del gruppo del motore
- **THEN** nessuna intestazione riceve il fuoco
- **WHEN** premo Invio su /status
- **THEN** /status è eseguito senza un secondo Invio

#### Scenario: telefono
- **GIVEN** una finestra di 390x844
- **WHEN** scrivo «/»
- **THEN** il menu sta sopra il composer, il campo resta visibile e toccabile
- **AND** ogni riga è alta almeno 44 px

#### Scenario: /help
- **WHEN** mando `/help`
- **THEN** il menu «/» è aperto con tutti i suoi gruppi

### Requirement: CMDUI-08 — Nei composer della board un comando non diventa prosa in silenzio

Nel composer del cassetto di una card e nel commento della card, un testo che
inizia con un nome della mappa dei comandi (non una skill) SHALL mostrare sopra il
campo la riga «I comandi vanno dati nella chat dell'agente» con «Apri la
sessione», che apre la chat dell'agente della card; senza una sessione viva la
riga SHALL dire che lì un comando è testo. Invio SHALL mandare il testo come oggi.

#### Scenario: /compact nel cassetto
- **GIVEN** una card con una sessione d'agente viva
- **WHEN** scrivo `/compact` nel cassetto
- **THEN** compare la riga con «Apri la sessione»
- **WHEN** la tocco
- **THEN** si apre la chat dell'agente della card

## MODIFIED Requirements

### Requirement: CMD-06 — Every offered slash command has a destination

The composer's slash-command menu SHALL only offer commands that resolve
somewhere: a branch of the chat pane that runs it or opens a control, or a name
the session's own engine lists as runnable in the mode Topics drives it
(CMDUI-01), which is then delivered unmodified. A command in neither reaches the
model as ordinary prose, and nothing happens.

Being in the server's `CLI_BUILTINS` allowlist is NOT a destination by itself: a
name the CLI refuses in `--print` (`isn't available in this environment`) SHALL be
answered locally, and a name the CLI does not have SHALL NOT be in the list.

Entries of the allowlist SHALL be matchable by the matcher that reads it:
lower-case, no slash, no whitespace.

> Written from the defect. On 2026-08-25 `/pause` ("Pause agent (@name)") and
> `/assign` ("Assign task (@name task)") were offered in the menu and existed
> nowhere — no handler, not allowlisted. Both were removed, and
> `client/src/components/Chat/slashCommandRouting.test.ts` now makes the class
> impossible rather than fixing the two instances. On 2026-10-03 `/resume` was
> found offered AND allowlisted, and refused by the CLI on every turn: membership
> in the allowlist had been read as a destination.

#### Scenario: a command offered without a destination
- **GIVEN** an entry the menu offers
- **WHEN** it is neither handled in the chat pane nor in the engine's own list of runnable commands
- **THEN** the check fails and names it

#### Scenario: a command that relies only on the allowlist
- **GIVEN** an offered command whose only route is the engine (`/compact` on Claude Code, `/init`, a skill)
- **THEN** it is in `CLI_BUILTINS` or is a slash invocation the engine expands, AND its name is in the recorded list of the engine's runnable commands
- **AND** removing it from that route, or the engine dropping the name, fails the check

#### Scenario: the help text and the menu cannot disagree
- **GIVEN** `/help`, which is the one place a user asks what can be typed here
- **THEN** it opens the same menu, built from the same map
- **AND** a hand-written second list fails the check, because two hand-kept lists drift and neither looks incomplete on its own

#### Scenario: a command the CLI cannot run in this mode
- **GIVEN** a command the CLI refuses when driven with `--print`, such as `/resume`, `/vim` or `/rewind`
- **WHEN** it is typed in the chat
- **THEN** it is answered locally, saying so and naming what to use instead, or Topics runs its own version
- **AND** it is NOT forwarded to a process that can only refuse it

#### Scenario: an allowlist entry that can never match
- **GIVEN** an entry written with a leading slash, whitespace or an upper-case letter
- **WHEN** the matcher compares the first token of a message against the list
- **THEN** that entry can never match, and the check fails instead of leaving it there reading as coverage
