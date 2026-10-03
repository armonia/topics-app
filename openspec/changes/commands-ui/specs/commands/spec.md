# Commands: ogni comando ha un senso in Topics

## ADDED Requirements

### Requirement: CMDUI-01 — Il menu «/» offre ciò che funziona nella chat aperta, in tre gruppi, letto dal motore

Il menu «/» del composer SHALL essere costruito per la chat aperta, sul motore che
il topic DICHIARA (CMD-08), in tre gruppi nell'ordine: «Topics» (i comandi che
Topics esegue o i controlli che apre), il gruppo del motore, «Le tue skill».

Il gruppo del motore SHALL venire dall'elenco che il motore stesso dà: per Claude
Code `system/init.slash_commands` e `system/commands_changed`; per gli agenti ACP
`available_commands_update`. Codex, le API, OpenClaw e il motore di Topics NON SHALL
avere un gruppo del motore. Prima che la chat abbia un elenco suo il menu SHALL
usare l'ultimo elenco visto per lo stesso progetto e motore, e NON SHALL avviare un
processo solo per leggerlo.

Il gruppo «Le tue skill» SHALL esserci sui motori che le espandono, come dice
SKILL-01: su Claude Code le skill e i comandi tuoi, sul motore di Topics le skill
(quelle che il suo prompt elenca e il suo tool `skill` carica). Su Codex, sulle API,
sugli agenti ACP e su OpenClaw NON SHALL esserci.

Ogni nome SHALL passare per la mappa dei comandi di Topics, che gli dà un tipo
(`topics`, `control`, `engine`, `refused`, `hidden`), dice se fa lavorare il
modello e tiene gli alias del motore. Un alias SHALL comportarsi come il suo nome
e NON SHALL comparire come riga a parte. Un nome `refused` o `hidden` NON SHALL
comparire nel menu. Una riga che fa lavorare il modello SHALL dirlo («turno»); una
che apre un controllo SHALL dire quale.

#### Scenario: una chat Claude Code
- **GIVEN** una chat dichiarata `claude-code` la cui CLI ha mandato un `init` con `init`, `code-review`, `compact`, `agents` e la skill `vai`
- **WHEN** scrivo «/»
- **THEN** il menu ha i gruppi Topics, Claude Code e Le tue skill
- **AND** /init, /code-review e /vai sono segnati «turno»
- **AND** /agents non c'è, e /review non è una riga a parte

#### Scenario: un alias scritto a mano
- **GIVEN** la stessa chat
- **WHEN** mando `/review`
- **THEN** parte come /code-review
- **WHEN** mando `/cost`
- **THEN** succede quello che succede con /usage (CMDUI-05)

#### Scenario: una chat sul motore di Topics
- **GIVEN** una chat dichiarata `topics` e la skill `vai` installata e accesa
- **WHEN** scrivo «/»
- **THEN** il menu ha i gruppi Topics e Le tue skill, e nessun gruppo del motore
- **AND** /vai è segnata «turno»

#### Scenario: una chat Codex
- **GIVEN** una chat dichiarata `codex`
- **WHEN** scrivo «/»
- **THEN** il menu ha solo il gruppo Topics
- **AND** non offre /compact né alcuna skill

#### Scenario: nessun elenco ancora visto
- **GIVEN** un server appena avviato e una chat Claude Code nuova che non ha ancora avviato la sua CLI
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
pannello Strumenti ancorato al «+» del composer della chat, lo stesso che apre la
riga «Strumenti» di quel menu; /config SHALL aprire il menu utente. /usage e /cost
seguono CMDUI-05.

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
- **THEN** il pannello Strumenti è aperto accanto al «+» del composer
- **AND** nessuna richiesta ha montato la flotta MCP per aprirlo

#### Scenario: /config
- **WHEN** mando /config
- **THEN** il menu utente è aperto

### Requirement: CMDUI-03 — /resume elenca le sessioni Claude del progetto nate fuori da Topics e le apre come chat

/resume in una chat legata a un progetto SHALL aprire, sopra il composer, l'elenco
delle sessioni Claude Code di quel progetto che nessuna chat di Topics possiede,
dalla più recente, 20 alla volta, con: titolo (quello dato con /rename, poi quello
generato, poi l'ultima domanda), ramo, quando, e «attiva adesso» se il transcript
è stato toccato negli ultimi 15 minuti. Finché ce ne sono altre, l'ultima riga SHALL
essere «Carica più vecchie», che aggiunge le 20 dopo. La parola dopo `/resume `
SHALL filtrare su titolo e ramo.

La lettura SHALL essere limitata: solo le cartelle dei transcript il cui nome
codificato inizia col percorso del progetto, il cui `cwd` letto SHALL comunque
stare dentro il progetto; le sessioni che Topics possiede scartate dal nome del
file prima di leggerlo; la coda (al più 64 KB) letta solo per le righe della pagina,
con I/O asincrono e mai il file intero. Le letture di /resume NON SHALL togliere
voci alla cache del censimento delle sessioni esterne, né il censimento alle sue.

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

#### Scenario: più di una pagina
- **GIVEN** un progetto con 25 transcript non posseduti da Topics
- **WHEN** mando `/resume`
- **THEN** l'elenco ha 20 righe e «Carica più vecchie»
- **AND** le code lette sono 20
- **WHEN** scelgo «Carica più vecchie»
- **THEN** l'elenco ha 25 righe e «Carica più vecchie» non c'è più

#### Scenario: le cartelle degli altri progetti
- **GIVEN** transcript recenti in una cartella di un altro progetto
- **WHEN** mando `/resume`
- **THEN** nessuna coda di quella cartella è stata letta

#### Scenario: il censimento non perde la sua cache
- **GIVEN** il censimento delle sessioni esterne ha appena letto le sue code
- **WHEN** mando `/resume` e poi il censimento gira di nuovo senza che nessun file sia cambiato
- **THEN** il censimento non rilegge nessuna coda

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
quando rifiuta, l'esito di /compact, i nomi `refused`, le risposte locali della CLI)
SHALL disegnare la risposta in una scheda in coda ai messaggi della pane. Una
risposta locale della CLI è un messaggio con `model: "<synthetic>"` in un turno
partito da un comando che finisce con `num_turns: 0`; un `<synthetic>` in un turno
che non è partito da un comando NON SHALL finire nella scheda. La scheda SHALL
restare finché la persona la chiude, manda il messaggio dopo o un altro comando la
sostituisce; NON SHALL avere un timer.

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
- **THEN** il testo compare dentro la scheda
- **AND** non compare come messaggio dell'agente, né dopo un ricarico

#### Scenario: /compact fallisce
- **GIVEN** la CLI risponde a `/compact` con `compact_result: "failed"`, `compact_error: "Not enough messages to compact."` e un messaggio `<synthetic>` con la stessa frase
- **THEN** la scheda passa da «in corso» a un errore che riporta quella frase, letta dentro la scheda
- **AND** nessun messaggio dell'agente la ripete

### Requirement: CMDUI-05 — /usage e /cost aprono Provider e chiavi dal selettore, con la settimana

/usage e /cost SHALL aprire il pannello Provider e chiavi ancorato al selettore del
modello del composer della chat, lo stesso che apre l'ultima riga del selettore
(SETHOME-01 della change `sidebar-menu-settings`), e NON SHALL arrivare al motore.

In cima al pannello, sotto l'abbonamento Claude e la finestra di 5 ore che
USERMENU-10 vi mette già, SHALL esserci la finestra della settimana: una barra, la
percentuale e quando si azzera, con giorno e ora, dalle letture che i turni di
Claude Code già mandano. La riga compatta del piano nel selettore SHALL aggiungere la
percentuale della settimana dopo quella delle 5 ore. Oltre la soglia dell'avviso la
barra e la cifra SHALL cambiare colore come quelle delle 5 ore. Senza una lettura il
pannello SHALL dirlo.

#### Scenario: con una lettura
- **GIVEN** una lettura con la finestra di 5 ore al 38% e la settimana al 78%
- **WHEN** mando `/usage`
- **THEN** il pannello Provider e chiavi è aperto accanto al selettore del modello del composer
- **AND** le due barre dicono 38% e 78% con quando si azzerano
- **AND** la barra della settimana ha il colore dell'avviso
- **AND** la riga del piano nel selettore dice «5 h al 38% · sett. 78%»

#### Scenario: /cost
- **WHEN** mando `/cost`
- **THEN** è aperto lo stesso pannello
- **AND** la CLI non ha ricevuto nessun messaggio

#### Scenario: senza lettura
- **GIVEN** nessuna lettura dal riavvio
- **WHEN** mando `/usage`
- **THEN** il pannello dice che la lettura arriva col primo turno di Claude Code

### Requirement: CMDUI-06 — Ogni motore ha i suoi comandi, detti per nome

/compact SHALL compattare su Claude Code (la CLI), su OpenClaw (il gateway) e sul
motore di Topics (la sua compattazione chiamata subito, con lo stesso separatore
di quella automatica); sugli altri motori NON SHALL essere offerto, e scritto SHALL
rispondere che quel motore non compatta a richiesta.

/clear, /new e /reset SHALL far dimenticare la sessione su ogni motore che ne ha
una, gli agenti ACP compresi (CMD-09). /reasoning SHALL esserci solo su OpenClaw,
SHALL dire che decide se il ragionamento si vede, e SHALL passare il suo argomento
(`on`, `off`, `stream`) anche quando è scritto nello stesso messaggio.

#### Scenario: /compact sul motore di Topics
- **GIVEN** una chat sul motore di Topics sotto la soglia della compattazione, senza un turno in volo
- **WHEN** mando `/compact`
- **THEN** la storia è compattata e compare il separatore con i token prima e dopo
- **AND** nessun turno del modello è partito

#### Scenario: /compact su Codex
- **GIVEN** una chat dichiarata `codex`
- **WHEN** scrivo `/compact` e lo mando
- **THEN** una scheda dice che Codex non compatta a richiesta
- **AND** Codex non ha ricevuto nessun messaggio

#### Scenario: /reasoning con l'argomento
- **GIVEN** una chat OpenClaw
- **WHEN** mando `/reasoning off`
- **THEN** l'argomento `off` arriva al gateway

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

Un messaggio che è un'invocazione (SKILL-03) NON SHALL prendere la citazione di una
risposta armata; la citazione SHALL restare armata per il messaggio dopo.

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

#### Scenario: un comando con una risposta armata
- **GIVEN** una chat Claude Code con «Rispondi» armato su un messaggio
- **WHEN** mando `/code-review`
- **THEN** la CLI riceve un messaggio che inizia con `/code-review`
- **AND** la citazione è ancora armata nel composer

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

### Requirement: CMDUI-09 — Una skill riceve il contesto fuori dal messaggio

Quando il messaggio è un'invocazione (SKILL-03) di un nome che non è un built-in
della CLI, su Claude Code il messaggio SHALL arrivare alla CLI nudo, cioè iniziare
con il comando, e il blocco del contesto NON SHALL stare né prima né dopo il comando
nello stesso messaggio. Al primo turno di una CLI il contesto SHALL andare nel suo
prompt di sistema e SHALL contare come mandato. Su una CLI già avviata gli slot che
cambiano a ogni turno (plan mode, board globale) SHALL saltare quel turno e tornare
al turno dopo, e gli slot ancora da mandare NON SHALL contare come mandati.

Un messaggio che non è un'invocazione SHALL avere il contesto come oggi.

#### Scenario: una skill al primo turno
- **GIVEN** una chat Claude Code nuova
- **WHEN** il primo messaggio è `/vai solo il bug X`
- **THEN** la CLI riceve un messaggio che è esattamente `/vai solo il bug X`
- **AND** il prompt di sistema con cui parte contiene gli slot del contesto di quel turno

#### Scenario: una skill in plan mode
- **GIVEN** una chat Claude Code già avviata, in plan mode
- **WHEN** mando `/recap`
- **THEN** la CLI riceve `/recap` senza `<context>`
- **WHEN** mando poi un messaggio normale
- **THEN** quel messaggio porta lo slot del plan mode

#### Scenario: un messaggio normale
- **GIVEN** una chat Claude Code nuova
- **WHEN** il primo messaggio è `ciao`
- **THEN** la CLI riceve `<context>` davanti a `ciao`, come oggi

### Requirement: CMDUI-10 — Un messaggio appuntato si vede

Un messaggio appuntato con «Appunta» SHALL portare un segno visibile anche senza il
puntatore sopra. Con almeno un appunto, sopra i messaggi della chat SHALL esserci una
riga «N appuntati · restano nel contesto dell'agente» che apre l'elenco degli
appunti; ogni voce SHALL portare al suo messaggio e SHALL potersi staccare da lì.
Senza appunti la riga NON SHALL esserci.

#### Scenario: appuntare
- **GIVEN** una chat con tre messaggi e nessun appunto
- **WHEN** appunto il secondo
- **THEN** il secondo messaggio porta il segno
- **AND** sopra i messaggi c'è «1 appuntato · resta nel contesto dell'agente»
- **WHEN** apro la riga e stacco l'appunto
- **THEN** la riga non c'è più e il messaggio non porta il segno

## MODIFIED Requirements

### Requirement: SKILL-01 — The user's own commands and skills are discovered from known folders

The system SHALL offer, alongside the built-in slash commands, the commands and
skills the user authored on disk: `<name>.md` files under the command folders
(the user's home folder first, then the project's), and `<name>/SKILL.md`
directories under the skill folders. Each entry SHALL declare which of the two it
is, so the interface can tell a command from a skill. A name SHALL appear once
even when several folders hold it, and a folder that does not exist SHALL be
skipped rather than failing the listing.

They SHALL be offered only on an engine that expands them: Claude Code offers both
commands and skills; Topics' native engine offers skills only, the ones its prompt
lists and its `skill` tool loads. Codex, the API engines, the ACP agents and
OpenClaw SHALL NOT be offered them, because there a typed `/name` is prose. A skill
switched off in the user's `skillOverrides` SHALL NOT be offered, and SHALL NOT be
listed in the native engine's prompt either.

#### Scenario: Commands and skills are listed together, each declaring its kind
- **GIVEN** a command in the user's folder, a command in the project's folder, and a skill directory
- **WHEN** the available commands are listed
- **THEN** all three SHALL be present
- **AND** the skill SHALL be declared a skill, not a command

#### Scenario: A name appears once
- **GIVEN** the same name present in more than one folder
- **WHEN** the list is built
- **THEN** it SHALL appear exactly once

#### Scenario: The HTTP listing declares the kind of every entry
- **GIVEN** the slash-command listing endpoint
- **WHEN** it is called
- **THEN** it SHALL answer with a list
- **AND** every entry SHALL carry a name and a kind that is either command or skill

#### Scenario: Only where the engine expands them
- **GIVEN** a command and a skill on disk
- **WHEN** the list is built for a chat on Topics' native engine
- **THEN** the skill SHALL be offered and the command SHALL NOT
- **WHEN** the list is built for a chat on Codex
- **THEN** neither SHALL be offered

#### Scenario: A switched-off skill
- **GIVEN** a skill whose name is `off` in `skillOverrides`
- **WHEN** the list is built for a Claude Code chat, or the native engine builds its prompt
- **THEN** that skill SHALL NOT be in either

### Requirement: CMD-06 — Every offered slash command has a destination

The composer's slash-command menu SHALL only offer commands that resolve
somewhere: a branch of the chat pane that runs it or opens a control, a name
the session's own engine lists as runnable in the mode Topics drives it
(CMDUI-01), which is then delivered unmodified, or, on Topics' native engine, a
skill its prompt lists. A command in none of these reaches the model as ordinary
prose, and nothing happens.

Being in the server's `CLI_BUILTINS` allowlist is NOT a destination by itself: a
name the CLI refuses in `--print` (`isn't available in this environment`) SHALL be
answered locally, and a name the CLI does not have SHALL NOT be in the list. A name
the CLI accepts only as an alias of another (`review` of `code-review`, `cost` of
`usage`) is not in the CLI's list and SHALL count as its canonical name.

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
- **WHEN** it is neither handled in the chat pane, nor in the engine's own list of runnable commands, nor a skill the native engine lists
- **THEN** the check fails and names it

#### Scenario: a command that relies only on the allowlist
- **GIVEN** an offered command whose only route is the engine (`/compact` on Claude Code, `/init`, a skill)
- **THEN** it is in `CLI_BUILTINS` or is a slash invocation the engine expands, AND its name, or the name it is an alias of, is in the recorded list of the engine's runnable commands
- **AND** removing it from that route, or the engine dropping the name, fails the check

#### Scenario: an alias is not a missing command
- **GIVEN** `cost` and `review`, which the CLI runs but does not list
- **WHEN** the check compares the map against the recorded list with its aliases
- **THEN** both pass as `usage` and `code-review`

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
