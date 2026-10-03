# Selettore del modello: uno solo, tutte le aziende in una vista

## ADDED Requirements

### Requirement: MSEL-01: Un componente solo, con tre varianti dichiarate

Ogni superficie che sceglie provider e modello per una chat o una card SHALL usare
`ModelSelector`. Le superfici sono: composer della chat, composer delle card,
cassetto della card, impostazioni della board, impostazioni della chat, modello
di default per provider, card della board.

Le varianti SHALL essere solo tre:
- `compact`: si sceglie mentre si scrive;
- `full`: si sceglie un default, con le descrizioni per intero;
- `chip`: si legge, e il clic apre la `compact`.

Lo `scope` SHALL essere `chat`, con tutti i provider, oppure `task`, con i soli
motori di codice.

Larghezza, intestazione e posizione SHALL dipendere solo da variante e
viewport, non dal chiamante. Una differenza tra due superfici che non viene da
variante o `scope` è un difetto.

#### Scenario: due superfici, stesso pannello
- **GIVEN** lo stesso snapshot
- **WHEN** si apre il selettore nel composer della chat e nel cassetto di una card
- **THEN** i due pannelli hanno la stessa larghezza, la stessa fascia e lo stesso ordine delle sezioni
- **AND** differiscono solo per ciò che lo `scope` toglie: i provider senza `coding-tasks` sulla card

#### Scenario: le impostazioni della chat
- **WHEN** l'utente apre le impostazioni di una chat
- **THEN** sceglie provider e modello con `ModelSelector` in variante `full`
- **AND** non c'è più una tendina con il solo provider

### Requirement: MSEL-02: Tutte le aziende in una vista, senza sottomenu

Aperto il selettore, i modelli correnti di ogni azienda presente nello snapshot
SHALL essere visibili nello stesso pannello, senza passare da un livello
intermedio. Le sezioni sono per azienda (Anthropic, OpenAI, Google, Altri).

Da 720 px di finestra in su le sezioni SHALL essere colonne affiancate, una per
azienda, tutte in vista insieme senza scorrere il pannello di lato; una colonna
più lunga dello spazio SHALL scorrere da sola, con l'intestazione ferma. Sotto
i 720 px le sezioni SHALL essere una lista sola, e l'intestazione di ciascuna
SHALL restare in vista mentre si scorre.

Il pannello SHALL restare dentro il viewport. Quando le righe non ci stanno,
SHALL scorrere solo l'area delle sezioni, e fascia, ricerca e Automatico SHALL
restare ferme.

Le generazioni non correnti SHALL stare in una riga «Altri modelli (n)» in fondo
alla loro sezione, che si apre sul posto.

La variante a finestra estesa dello stesso modello (`[1m]`) SHALL essere un
interruttore dentro la riga del modello, non una riga a sé.

#### Scenario: Opus e GPT insieme
- **GIVEN** Claude Code e Codex pronti
- **WHEN** l'utente apre il selettore
- **THEN** vede Opus 5.5 e GPT-6.1-Sol senza nessun altro clic
- **AND** passare dall'uno all'altro costa un clic

#### Scenario: quattro aziende su desktop
- **GIVEN** quattro aziende pronte e una finestra di 1280 × 900 px con il composer in basso
- **WHEN** l'utente apre il selettore
- **THEN** il pannello sta dentro il viewport
- **AND** le quattro intestazioni e la prima riga di ogni azienda sono visibili senza scorrere

#### Scenario: quattro aziende sul telefono
- **GIVEN** quattro aziende pronte e uno schermo largo 390 px
- **WHEN** l'utente apre il selettore
- **THEN** le aziende sono una lista sola nel foglio dal basso
- **AND** scorrendo la lista l'intestazione dell'azienda in vista resta ferma

#### Scenario: generazioni vecchie
- **GIVEN** Codex con `gpt-5.5` fuori dalla generazione corrente
- **WHEN** l'utente apre il selettore
- **THEN** `gpt-5.5` non è tra le righe visibili della sezione OpenAI
- **AND** compare aprendo «Altri modelli», o cercandolo

### Requirement: MSEL-03: La ricerca è il primo elemento

Il pannello SHALL avere un campo di ricerca in cima. Su desktop SHALL avere il
fuoco all'apertura, sul telefono no.

La ricerca SHALL confrontare per sottostringa, senza maiuscole né accenti, su
etichetta, id, azienda, motore e descrizione, includendo i modelli piegati. Le
sezioni senza risultati SHALL sparire. Senza risultati SHALL comparire «Nessuna
corrispondenza».

#### Scenario: cercare un'azienda
- **WHEN** l'utente scrive «openai»
- **THEN** restano solo le righe della sezione OpenAI, piegate comprese

### Requirement: MSEL-04: Ogni riga aiuta a scegliere

Ogni riga SHALL mostrare:
- il nome leggibile del modello;
- la finestra di contesto, solo nello `scope` `chat`;
- la strada («via Topics», «via Codex», …);
- la spunta se è il valore attuale.

Nella variante `full` SHALL mostrare anche la descrizione, quando il catalogo ne
ha una. Un modello con data di ritiro SHALL dirla.

La finestra dichiarata dal provider (`modelContextWindows`, già nello snapshot)
SHALL battere la tabella statica. Codex SHALL dichiarare `context_window` della
sua cache.

Una riga non utilizzabile SHALL restare visibile e disabilitata, con il motivo e
l'azione «Apri impostazioni». Un valore salvato che non è più nel catalogo
SHALL restare selezionato e disabilitato, mai sostituito in silenzio
(MP-TASK-06).

#### Scenario: la finestra dei GPT
- **GIVEN** la cache di Codex che dichiara 272000 per `gpt-6.1-sol`
- **WHEN** l'utente apre il selettore in chat
- **THEN** la riga mostra 272k, non ≈1M

#### Scenario: un modello in ritiro
- **GIVEN** `gpt-5.5` con `upgrade.retirement_at` al 14/10/2026
- **THEN** la sua riga dice «si ritira il 14/10»

### Requirement: MSEL-05: Una riga per modello, il motore sulla riga

Lo stesso modello offerto da più motori SHALL essere una riga sola. Il motore
SHALL essere deciso da una regola sola e ripetibile:
1. quello già salvato;
2. il default dello snapshot;
3. l'ordine di preferenza del server, prima l'abbonamento e poi le API.

Se i motori sono più di uno, la riga SHALL permettere di cambiarlo sul posto,
senza un sottomenu. Il valore salvato SHALL restare `provider` più `model`.

#### Scenario: un modello, due motori
- **GIVEN** `claude-sonnet-5-5` offerto da Claude Code e da jcode
- **WHEN** l'utente apre il selettore
- **THEN** Sonnet 5.5 compare una volta
- **AND** la riga offre i due motori sul posto

#### Scenario: la scelta non salta
- **GIVEN** una chat salvata su jcode con Sonnet 5.5
- **WHEN** lo snapshot cambia default in Claude Code
- **THEN** la riga resta su jcode

### Requirement: MSEL-06: «Esegui in Topics» è acceso dove si può

La preferenza mai scritta (`null`) SHALL valere acceso per le chat, anche per
quelle che esistono già, e spenta per le card e per il default della board.
Nessun dato SHALL essere riscritto per questo. Il default per ambito SHALL
stare in una costante sola (`TOPICS_ROUTING_DEFAULT`).

Con la preferenza accesa, il bersaglio SHALL essere risolto prima come a
preferenza spenta (Automatico diventa il default), e solo dopo si decide la
strada. Il turno SHALL passare dal motore di Topics quando quel bersaglio è
instradabile. Quando non lo è (un provider fuori dalla famiglia Claude, un
modello che il motore non serve, il motore non connesso), il turno SHALL andare
diretto, e la strada SHALL essere dichiarata sulla riga, nella fascia e sul
turno. La preferenza SHALL NOT bloccare l'invio, e SHALL NOT parcheggiare una
card perché il suo bersaglio non è instradabile.

Ogni lettura della preferenza SHALL passare da una funzione sola, `topicsRoute`.

#### Scenario: chat esistente su Claude Code, mai toccata
- **GIVEN** una chat con `provider: claude-code`, un modello servito dal motore, preferenza `null`
- **WHEN** parte il turno successivo
- **THEN** il turno passa dal motore di Topics
- **AND** un turno già in volo non cambia strada

#### Scenario: chat in Automatico con un default esplicito su Codex
- **GIVEN** una chat in Automatico, preferenza `null`, e il default delle Impostazioni su `codex`
- **WHEN** l'utente invia
- **THEN** il turno va diretto su Codex, come a preferenza spenta
- **AND** la fascia dice «diretto»

#### Scenario: chat su Codex
- **GIVEN** una chat con `provider: codex`, preferenza `null` o accesa
- **WHEN** l'utente invia
- **THEN** il turno parte, diretto su Codex
- **AND** il turno porta «via Codex»

#### Scenario: card mai toccata
- **GIVEN** una card con preferenza `null` e il default della board `null`, su `claude-code:claude-opus-5-5`
- **WHEN** il dispatcher la avvia
- **THEN** la card gira su Claude Code diretto, come oggi

#### Scenario: card Codex con la preferenza accesa
- **GIVEN** una card `codex:gpt-6.1-sol` con la preferenza accesa
- **WHEN** il dispatcher crea il suo topic
- **THEN** il topic nasce e il turno va diretto su Codex
- **AND** la card non si parcheggia

#### Scenario: Automatico delle card con la preferenza accesa
- **GIVEN** una card in Automatico con la preferenza accesa, Claude Code e Codex pronti, il motore pronto
- **WHEN** il dispatcher sceglie il modello
- **THEN** i modelli Codex sono tra i candidati
- **AND** se vince un modello Claude, il turno passa dal motore di Topics
- **AND** il giudice del classificatore è un modello servito dal motore

#### Scenario: sessione riusata con uno 0 scritto
- **GIVEN** una card con preferenza `null` (e default della board `null`) che riusa la sessione di un'altra card, dispacciata a interruttore spento, che contiene 0
- **WHEN** il dispatcher la avvia
- **THEN** la card adotta la strada della sessione e non si parcheggia

#### Scenario: sessione riusata con una preferenza esplicita diversa
- **GIVEN** una card con preferenza `true` che riusa una sessione che contiene 0
- **WHEN** il dispatcher la avvia
- **THEN** la card si parcheggia con il motivo del riuso, come oggi

#### Scenario: una lettura sola
- **GIVEN** una preferenza `null` e lo stesso bersaglio
- **THEN** menu, cancello d'invio, resolver della chat, identità del topic dispacciato, dispatcher e picker automatico danno la stessa strada

### Requirement: MSEL-07: La preferenza si vede e si spiega in una riga

In cima al pannello SHALL esserci una fascia con:
- il titolo «Esegui in Topics»;
- un interruttore;
- una riga di spiegazione leggibile senza passare col mouse, anche sul telefono.

La riga SHALL dire cosa fa (Claude gira dentro Topics col tuo abbonamento,
senza aprire un processo Claude Code per chat) e cosa resta fuori (GPT e Gemini
restano diretti). La riga SHALL NOT promettere né la stessa quota né meno
memoria: la quota è la stessa solo con MSEL-11, e per jcode la memoria non
cambia.

Quando il valore attuale va diretto pur con la preferenza accesa, la fascia
SHALL dire perché.

Il trigger del composer SHALL mostrare un segno quando la strada del valore
attuale passa da Topics.

#### Scenario: acceso e diretto
- **GIVEN** la preferenza accesa e GPT-6.1-Sol selezionato
- **WHEN** l'utente apre il selettore
- **THEN** la fascia dice che questo modello va diretto perché Codex non passa da Topics
- **AND** l'interruttore resta cliccabile

#### Scenario: sul telefono
- **GIVEN** un viewport di 390 px
- **WHEN** l'utente apre il selettore
- **THEN** la riga di spiegazione è visibile senza nessun gesto

### Requirement: MSEL-08: Tastiera e telefono

- ⌘⇧M SHALL aprire e chiudere il selettore del composer con il fuoco, e SHALL
  essere nel catalogo delle scorciatoie.
- Le frecce SHALL attraversare fascia, Automatico, righe e «Altri modelli» di
  tutte le sezioni, senza fermarsi alle intestazioni. Invio sceglie; Esc chiude
  e riporta il fuoco al trigger; `→` e `←` aprono e chiudono la scelta del
  motore sulla riga.
- Sotto 768 px il pannello SHALL essere un foglio dal basso a tutta larghezza,
  con righe alte almeno 44 px e lo scorrimento di sfondo bloccato.

#### Scenario: da Opus a GPT con la tastiera
- **GIVEN** il selettore aperto con il fuoco nella ricerca
- **WHEN** l'utente preme ↓ fino a GPT-6.1-Sol e poi Invio
- **THEN** il valore è Codex con GPT-6.1-Sol e il fuoco torna al trigger

### Requirement: MSEL-09: Il catalogo porta i metadati per modello

Lo snapshot SHALL portare in `modelInfo`, per modello e quando la fonte li ha:
etichetta, descrizione, data di ritiro, sostituto e generazione (corrente o
vecchia). La finestra di contesto SHALL passare dal campo che esiste già,
`modelContextWindows`. Nessun metadato SHALL essere scritto a mano nel client.

#### Scenario: Codex
- **GIVEN** la cache di Codex con `description`, `context_window` e `upgrade`
- **THEN** lo snapshot di Codex porta descrizione e ritiro in `modelInfo`
- **AND** porta `context_window` in `modelContextWindows`

### Requirement: MSEL-10: Anche `/model` legge lo stesso catalogo

`/model <id>` scrive solo il modello della chat, non il motore. Lo slash
command SHALL quindi proporre, mentre si scrive, i modelli del catalogo di
`ModelSelector` che il motore attuale della chat esegue, con le stesse
etichette. Per cambiare motore si usa il selettore.

#### Scenario: completare `/model`
- **GIVEN** una chat su Claude Code
- **WHEN** l'utente scrive `/model op`
- **THEN** vede Opus 5.5 e gli altri Opus di Claude Code
- **AND** non vede modelli di altri motori

### Requirement: MSEL-11: Il motore passa dallo stesso indirizzo di Claude Code

Il motore di Topics SHALL mandare le richieste all'indirizzo che userebbe una
sessione Claude Code lanciata da Topics: prima `ANTHROPIC_BASE_URL` del
processo, poi l'`env` di `~/.claude/settings.json`, infine
`https://api.anthropic.com`. Se quell'indirizzo non risponde, il motore SHALL
NOT ripiegare in silenzio sull'API diretta: l'errore SHALL nominare
l'indirizzo provato.

#### Scenario: un proxy degli account configurato
- **GIVEN** `~/.claude/settings.json` con `env.ANTHROPIC_BASE_URL` = `http://127.0.0.1:3336`
- **WHEN** il motore manda un turno
- **THEN** la richiesta va a `http://127.0.0.1:3336/v1/messages`
