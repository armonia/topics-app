# model-selector Specification

## Purpose
TBD - created by archiving change model-selector. Update Purpose after archive.

## Requirements

### Requirement: MSEL-01: Un componente solo, con tre varianti dichiarate

Ogni superficie che sceglie provider e modello per una chat o una card SHALL usare
`ModelSelector`. Le superfici sono: composer della chat, composer delle card,
cassetto della card, impostazioni della board, impostazioni della chat, card della
board. Il modello di default di un provider SHALL scegliersi nel dettaglio del suo
account, come elenco di radio in linea costruito dallo stesso catalogo del
selettore (stesse etichette, stesse generazioni), senza aprire un secondo
selettore (emendamento del 04/10, revisione §5.5: una porta che riapre lo stesso
pannello sopra se stesso).

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

#### Scenario: il modello di default di un provider
- **GIVEN** il dettaglio di Claude Code in «Provider e chiavi»
- **WHEN** l'utente sceglie Sonnet 5.5 fra le radio del «Modello di default»
- **THEN** `claudeModel` vale `claude-sonnet-5-5`, e nessun altro popover si è aperto

### Requirement: MSEL-02: Tutte le aziende in una vista, senza sottomenu

Aperto il selettore, i modelli correnti di ogni azienda presente nello snapshot
SHALL essere visibili nello stesso pannello, senza passare da un livello
intermedio. Le sezioni sono per azienda, e ogni sezione SHALL portare il nome di
un'azienda o, per un'azienda sconosciuta, il nome del provider che offre il
modello. Nessuna sezione SHALL raccogliere ciò che resta («Altri», «Other») né
raggruppare per tipo di connessione (emendamento del 04/10, revisione).
Anthropic, OpenAI e Google SHALL essere le prime tre colonne, sempre in
quest'ordine. Con più di quattro sezioni, le aziende successive SHALL stare
impilate nella quarta colonna, ognuna col suo titolo.

Da 720 px di finestra in su le sezioni SHALL essere colonne affiancate, una per
azienda, tutte in vista insieme senza scorrere il pannello di lato; una colonna
più lunga dello spazio SHALL scorrere da sola, con l'intestazione ferma. Sotto
i 720 px le sezioni SHALL essere una lista sola, e l'intestazione di ciascuna
SHALL restare in vista mentre si scorre.

Il pannello SHALL restare dentro il viewport e SHALL aprirsi dal lato del trigger
con più spazio quando non ci sta da nessuno dei due. Quando le righe non ci stanno,
SHALL scorrere solo l'area delle sezioni, e fascia, ricerca e Automatico SHALL
restare ferme.

Le generazioni non correnti SHALL stare in una riga «Precedenti (n)» in fondo
alla loro sezione, che si apre sul posto. Una generazione dichiarata dal provider
vince; senza dichiarazione, è corrente la versione più alta di ogni famiglia
della stessa azienda.

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
- **AND** compare aprendo «Precedenti», o cercandolo

#### Scenario: nessun gruppo di ripiego
- **GIVEN** Ollama con `gpt-oss:20b`, `gemma3:27b` e `llama3.3:70b`, e OpenClaw con `openclaw`
- **WHEN** l'utente apre il selettore
- **THEN** `gpt-oss:20b` sta nella sezione OpenAI, `gemma3:27b` in Google, `llama3.3:70b` in Meta e `openclaw` in una sezione «OpenClaw»
- **AND** nessuna sezione si chiama «Altri», «Other» o con un tipo di connessione

#### Scenario: chat vuota, composer a metà schermo
- **GIVEN** una finestra di 1024 × 768 px e il composer di una chat vuota a metà altezza
- **WHEN** l'utente apre il selettore
- **THEN** il pannello si apre dal lato con più spazio, sta dentro il viewport e non copre il chip

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
- la finestra di contesto, solo nello `scope` `chat` e solo se è nota;
- chi la esegue («via Topics», «via Codex», …) solo quando è diverso da quello
  scritto nel titolo della sua sezione (emendamento del 04/10: il titolo lo dice
  per tutte);
- la spunta se è il valore attuale.

Nella variante `full` SHALL mostrare anche la descrizione, quando il catalogo ne
ha una. Un modello con data di ritiro SHALL dirla.

La finestra dichiarata dal provider (`modelContextWindows`, già nello snapshot)
SHALL battere la tabella statica. Codex SHALL dichiarare `context_window` della
sua cache.

Una riga non utilizzabile SHALL restare visibile e disabilitata, con il motivo e
l'azione «Sistema ›», che apre il dettaglio del suo motore. Un valore salvato che non è più nel catalogo
SHALL restare selezionato e disabilitato, mai sostituito in silenzio
(MP-TASK-06).

#### Scenario: la finestra dei GPT
- **GIVEN** la cache di Codex che dichiara 272000 per `gpt-6.1-sol`
- **WHEN** l'utente apre il selettore in chat
- **THEN** la riga mostra 272k, non ≈1M

#### Scenario: un modello in ritiro
- **GIVEN** `gpt-5.5` con `upgrade.retirement_at` al 14/10/2026
- **THEN** la sua riga dice «si ritira il 14/10»

### Requirement: MSEL-05: Una riga per modello, il motore nel titolo della sezione

Lo stesso modello offerto da più motori SHALL essere una riga sola, anche quando
gli id differiscono solo per `vendor/`, `:tag`, punti o una data finale
(`gpt-oss:20b` e `openai/gpt-oss-20b`). Il motore di una sezione SHALL essere
deciso da una regola sola e ripetibile:
1. quello già salvato, se la riga salvata sta nella sezione;
2. il default dello snapshot, se serve una riga della sezione;
3. l'ordine di preferenza del server, prima l'abbonamento e poi le API.

Una riga SHALL usare il motore della sezione se lo serve, altrimenti il primo che
la serve nello stesso ordine. Se i motori della sezione sono più di uno, il
titolo della sezione SHALL permettere di cambiarlo sul posto, senza un sottomenu
né un popover (emendamento del 04/10: prima lo faceva la riga). Il valore salvato
SHALL restare `provider` più `model`.

#### Scenario: un modello, due motori
- **GIVEN** `claude-sonnet-5-5` offerto da Claude Code e da jcode
- **WHEN** l'utente apre il selettore
- **THEN** Sonnet 5.5 compare una volta
- **AND** il titolo della sezione Anthropic offre i due motori sul posto

#### Scenario: due id, un modello
- **GIVEN** Ollama con `gpt-oss:20b` e jcode con `openai/gpt-oss-20b`
- **WHEN** l'utente apre il selettore
- **THEN** la sezione OpenAI ha una riga sola «GPT-OSS 20B» servita da due motori

#### Scenario: la scelta non salta
- **GIVEN** una chat salvata su jcode con Sonnet 5.5
- **WHEN** lo snapshot cambia default in Claude Code
- **THEN** la sezione Anthropic resta su jcode, e così la riga

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
- **AND** la fascia dice «diretto»

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
senza aprire un processo Claude Code per chat) e cosa resta fuori («Gli altri
vanno diretti»: emendamento del 04/10, perché sotto la fascia ci sono anche Meta,
Mistral e le altre aziende). La riga SHALL NOT promettere né la stessa quota né meno
memoria: la quota è la stessa solo con MSEL-11, e per jcode la memoria non
cambia.

Quando il valore attuale va diretto pur con la preferenza accesa, la fascia
SHALL dire perché.

Il trigger del composer SHALL mostrare un segno quando la strada del valore
attuale passa da Topics. Ogni trigger chiuso SHALL scrivere il valore nello
stesso formato, «etichetta · chi esegue» («Automatico · chi decide» per la scelta
automatica).

#### Scenario: Automatico nomina il predefinito, non il motore attuale
- **GIVEN** una chat su Codex con GPT-6.1-Sol e il predefinito delle Impostazioni su Claude Code
- **WHEN** l'utente apre il selettore del composer o quello delle impostazioni della chat
- **THEN** Automatico dice «Automatico · Claude Code» e la frase «Usa il predefinito: Claude Code»
- **AND** sceglierlo lascia il chip su «Automatico · Claude Code»

#### Scenario: Automatico dentro un motore senza modelli
- **GIVEN** Gemini CLI pronto senza modelli e una chat, salvata o nuova, che ha scelto la sua riga «Automatico»
- **THEN** il chip dice «Automatico · Gemini CLI»
- **AND** riaprendo il selettore è premuta la riga di Gemini CLI, non l'Automatico in alto

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
- ↓ e ↑ SHALL attraversare fascia, Automatico, righe e «Precedenti» di tutte le
  sezioni, senza fermarsi sul testo delle intestazioni; il bottone del motore di
  un'intestazione è una fermata solo quando offre una scelta. Invio sceglie; Esc
  chiude e riporta il fuoco al trigger. A colonne, `→` e `←` SHALL passare alla
  colonna accanto, e Tab SHALL fermarsi una volta per colonna (emendamento del
  04/10: la scelta del motore è nel titolo, e si apre con Invio sul suo bottone).
  Con la scelta del motore aperta, le frecce SHALL muoversi fra i suoi motori e
  Invio o Spazio SHALL scegliere quello col fuoco; dopo la scelta il fuoco torna
  al bottone del motore (emendamento del 04/10, design §9.5).
- Sotto 768 px il pannello SHALL essere un foglio dal basso a tutta larghezza,
  con righe alte almeno 44 px e lo scorrimento di sfondo bloccato.

#### Scenario: da Opus a GPT con la tastiera
- **GIVEN** il selettore aperto con il fuoco nella ricerca
- **WHEN** l'utente preme ↓ fino a GPT-6.1-Sol e poi Invio
- **THEN** il valore è Codex con GPT-6.1-Sol e il fuoco torna al trigger

#### Scenario: il motore di un'azienda dalla tastiera
- **GIVEN** il selettore aperto su Opus 5.5 con Claude Code, e il fuoco sul bottone «via Topics ⌄» di Anthropic
- **WHEN** l'utente preme Invio, poi ↓ fino a «Claude API» e Invio
- **THEN** il valore è Claude API con Opus 5.5, il pannello resta aperto e il fuoco torna al bottone del motore

#### Scenario: le impostazioni della chat sul telefono
- **GIVEN** una chat aperta su uno schermo largo 390 px, dove al posto delle tab c'è il nome della chat
- **WHEN** l'utente tiene premuto il nome e sceglie «Impostazioni della chat»
- **THEN** il trigger del modello scrive «etichetta · chi esegue» e apre il selettore come foglio dal basso
- **AND** Esc chiude il foglio e lascia le impostazioni aperte, col fuoco sul trigger

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
