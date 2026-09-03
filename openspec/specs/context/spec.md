## Purpose

Specifies behavioral scenarios for the context inspector, token budget management, context source toggling, context pills in chat input, and topic-level and global memory CRUD operations.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- A topic exists and is selected with an active chat session
- The context inspector is accessible from the chat panel
- Memory entries can exist at both topic level and global level

## Requirements

### Requirement: CTX-01 — Inspector, Budget Bar, Source Toggle & Memory CRUD

The system SHALL provide a context inspector that displays context sources with token counts, a budget bar showing total usage, the ability to toggle sources on and off, context pills in chat input, and inline CRUD operations for topic and global memory entries.

#### Scenario: Context inspector displays list of context sources
- **GIVEN** a topic is selected with an active chat session
- **WHEN** the user opens the context inspector
- **THEN** a list of context sources is displayed
- **AND** each source shows its name and category

#### Scenario: Each context source displays token count
- **GIVEN** the context inspector is open
- **WHEN** the user views the source list
- **THEN** each context source row displays its token count in a human-readable format
- **AND** sources include system prompt, topic memory, global memory, and attached files

#### Scenario: Inspector shows at least four default context sources
- **GIVEN** a topic exists with default configuration
- **WHEN** the user opens the context inspector
- **THEN** at least four source rows are visible
- **AND** sources include SOUL.md, Topic Memory, Global Memory, and System Prompt

#### Scenario: Budget bar shows total token usage as a percentage
- **GIVEN** the context inspector is open
- **WHEN** the user views the budget section
- **THEN** a budget bar is visible showing total token usage
- **AND** the usage percentage is displayed as a number

#### Scenario: Budget bar reflects low usage with appropriate visual indicator
- **GIVEN** the total context token usage is below 50% of the budget
- **WHEN** the user views the budget bar
- **THEN** the bar displays with a low-usage visual indicator
- **AND** the percentage text reflects the actual usage

#### Scenario: Budget bar reflects high usage with warning indicator
- **GIVEN** the total context token usage exceeds 80% of the budget
- **WHEN** the user views the budget bar
- **THEN** the bar displays with a high-usage visual indicator
- **AND** the percentage text reflects the elevated usage

#### Scenario: Context warning appears when budget usage is critical
- **GIVEN** the context analysis reports usage above 80% with warnings
- **WHEN** the user opens the context inspector
- **THEN** a warnings section is visible with a warning indicator
- **AND** clicking the warnings section expands to show budget details
- **AND** the warning text references the percentage and budget

#### Scenario: Budget bar handles zero budget without displaying invalid values
- **GIVEN** the context budget is set to zero or is undefined
- **WHEN** the user opens the context inspector
- **THEN** the budget bar does not display NaN or Infinity
- **AND** a sensible fallback value is shown

> Note: Zero budget edge case has limited dedicated test coverage.

#### Scenario: Toggle context source off removes it from active context
- **GIVEN** the context inspector is open with all sources enabled
- **WHEN** the user clicks the disable button on a context source
- **THEN** a request is sent to update the topic's disabled context sources
- **AND** the disabled source is included in the list of disabled sources

#### Scenario: Toggle context source on restores it to active context
- **GIVEN** the context inspector is open with a source previously disabled
- **WHEN** the user clicks the enable button on that context source
- **THEN** a request is sent to update the topic's disabled context sources
- **AND** the source is removed from the list of disabled sources

#### Scenario: Toggled source state persists across inspector reopening
- **GIVEN** the user has disabled a context source
- **WHEN** the user closes and reopens the context inspector
- **THEN** the previously disabled source still shows as disabled

> Note: Persistence is mediated by server PATCH on the topic record.

#### Scenario: Rapid context source toggles apply correctly
- **GIVEN** the context inspector is open with multiple sources visible
- **WHEN** the user rapidly toggles multiple sources on and off
- **THEN** each toggle sends the correct accumulated state to the server
- **AND** no race conditions cause incorrect source states

> Note: Race condition handling has limited explicit test coverage.

#### Scenario: Topic memory list shows existing entries
- **GIVEN** the topic has a memory entry with content
- **WHEN** the user opens the context inspector
- **THEN** the Topic Memory source row is visible
- **AND** the memory content is accessible via the expand or edit action

#### Scenario: Edit topic memory entry inline
- **GIVEN** the context inspector is open with Topic Memory visible
- **WHEN** the user clicks the edit button on the Topic Memory row
- **THEN** a textarea appears with the current memory content
- **AND** the user can modify the text

#### Scenario: Save edited topic memory content
- **GIVEN** the user has edited topic memory content in the textarea
- **WHEN** the user clicks the Save button
- **THEN** a PUT request is sent to the topic memory endpoint
- **AND** the request body contains the updated content

#### Scenario: Global memory list shows shared entries
- **GIVEN** global memory exists with content
- **WHEN** the user opens the context inspector
- **THEN** the Global Memory source row is visible
- **AND** the memory content is accessible via the expand or edit action

#### Scenario: Edit global memory entry inline
- **GIVEN** the context inspector is open with Global Memory visible
- **WHEN** the user clicks the edit button on the Global Memory row
- **THEN** a textarea appears with the current global memory content
- **AND** the user can modify the text

#### Scenario: Save edited global memory content
- **GIVEN** the user has edited global memory content in the textarea
- **WHEN** the user clicks the Save button
- **THEN** a PUT request is sent to the global memory endpoint
- **AND** the request body contains the updated content

#### Scenario: Context pills in chat input show attached context filenames
- **GIVEN** a topic has context files attached
- **WHEN** the user views the chat input area for that topic
- **THEN** context pills are displayed near the input
- **AND** each pill shows the filename of an attached context file

#### Scenario: Context pills reflect all attached files
- **GIVEN** a topic has two context files attached
- **WHEN** the user views the context pills
- **THEN** at least two pills are visible
- **AND** each pill corresponds to one of the attached file names

#### Scenario: Context pills update when context files change
- **GIVEN** a topic is displayed with context pills showing current files
- **WHEN** the attached context files are updated on the topic
- **THEN** the context pills update to reflect the new file set

> Note: Dynamic pill updates have limited test coverage; pills are verified after initial topic load.

#### Scenario: Context inspector closes cleanly
- **GIVEN** the context inspector is open
- **WHEN** the user closes the inspector
- **THEN** the inspector panel is no longer visible
- **AND** the chat interface returns to its normal layout

#### Scenario: Memory edit cancellation discards changes
- **GIVEN** the user has opened the memory editor and modified the text
- **WHEN** the user navigates away or closes the editor without saving
- **THEN** the original memory content is preserved
- **AND** no PUT request is sent to the server

> Note: Explicit cancel/discard behavior has limited test coverage; tests focus on the save path.

### Requirement: CTX-DEDUP-01 — Il preambolo inline porta solo ciò che è cambiato

Per la sola strategia `inline-system`, il sistema SHALL anteporre al messaggio utente uno
slot di contesto composto se e solo se la sessione CLI corrente non ha già ricevuto quello
slot con contenuto identico. L'identità è l'hash del contenuto composto dello slot.

#### Scenario: Il primo turno di una sessione porta il contesto completo

- **GIVEN** un topic su provider `claude-code` senza slot registrati come inviati
- **WHEN** l'utente invia il primo messaggio
- **THEN** il preambolo `<context>` contiene tutti gli slot abilitati
- **AND** il contenuto è byte-identico a quello prodotto senza deduplicazione

#### Scenario: Un turno successivo senza cambiamenti non ripete il preambolo

- **GIVEN** una sessione in cui tutti gli slot abilitati risultano già inviati con lo stesso hash
- **WHEN** l'utente invia un altro messaggio
- **THEN** il contenuto inviato al provider è il messaggio utente senza alcun blocco `<context>`
- **AND** le note di adattamento riportano quanti slot sono stati saltati e i token risparmiati

#### Scenario: Uno slot il cui contenuto cambia viene rimandato per intero

- **GIVEN** una sessione in cui lo slot `template` risulta già inviato
- **AND** un file di progetto incluso in quello slot viene modificato
- **WHEN** l'utente invia un messaggio
- **THEN** il preambolo contiene lo slot `template` completo, non il solo file modificato
- **AND** gli altri slot invariati restano esclusi

#### Scenario: Lo slot modale plan-mode non viene mai deduplicato

- **GIVEN** una sessione con plan mode attivo e lo slot `plan-mode` già inviato
- **WHEN** l'utente invia un altro messaggio con plan mode ancora attivo
- **THEN** il preambolo contiene lo slot `plan-mode`

#### Scenario: Le strategie non-inline restano invariate

- **GIVEN** un topic su un provider `history-aware` o `gateway-stateful`
- **WHEN** viene assemblato il payload
- **THEN** i messaggi di sistema sono anteposti alla history esattamente come senza deduplicazione

#### Scenario: La deduplicazione si può disattivare

- **GIVEN** la variabile d'ambiente `TOPICS_INLINE_CONTEXT_DEDUP` valorizzata a `0`
- **WHEN** l'utente invia un messaggio qualsiasi su provider `inline-system`
- **THEN** il preambolo contiene tutti gli slot abilitati ad ogni turno

### Requirement: CTX-GOAL-01 — L'obiettivo del topic raggiunge il modello

Il sistema SHALL includere il blocco dell'obiettivo attivo del topic fra i contenuti
inviati al provider, coerentemente con il fatto che l'ispettore lo mostra e lo conta nel
budget del contesto.

#### Scenario: Un obiettivo attivo viene inviato

- **GIVEN** un topic con un obiettivo attivo
- **WHEN** viene composto il contesto da inviare
- **THEN** il contenuto dell'obiettivo è presente fra i messaggi di sistema composti

#### Scenario: Un obiettivo completato viene dichiarato non più in vigore

- **GIVEN** una sessione `inline-system` in cui l'obiettivo era già stato inviato
- **WHEN** l'obiettivo non è più attivo e l'utente invia un messaggio
- **THEN** il preambolo dichiara l'obiettivo non più in vigore

### Requirement: CTX-GOAL-02 — L'agente può leggere e chiudere il goal

Il sistema SHALL offrire all'agente, con i tool `get_goal` e `close_goal`, la
lettura del goal attivo del proprio topic e la sua chiusura come `achieved` o
`abandoned`, risolvendo il topic dalla session key. La chiusura SHALL essere la
stessa operazione del pannello (stesso servizio, stesso annuncio `goal:updated`).
I due tool SHALL restare fuori dal profilo `dispatch`.

> **Perché.** Fino al 2026-09-03 un goal poteva essere assegnato all'agente ma
> non chiuso da lui: il messaggio «dovresti essere anche in grado di chiudere
> goal, c'è goal attivo» è arrivato in una chat che non aveva il tool per farlo.

#### Scenario: Lettura per session key
- **GIVEN** un topic con un goal attivo e la sua session key
- **WHEN** l'agente chiama `get_goal`
- **THEN** riceve il testo del goal, i passi con il loro stato e il numero di goal passati

#### Scenario: Chiusura
- **GIVEN** un topic con un goal attivo
- **WHEN** l'agente chiama `close_goal` con `status` e `summary`
- **THEN** il goal non è più attivo, ha lo stato richiesto, e il client riceve `goal:updated`

#### Scenario: Senza goal
- **GIVEN** un topic senza goal attivo
- **WHEN** l'agente chiama `close_goal`
- **THEN** la chiamata fallisce con 404 e nessun goal cambia

#### Scenario: Fuori dal profilo dispatch
- **GIVEN** una sessione con profilo `dispatch`
- **THEN** `get_goal` e `close_goal` non compaiono fra i tool pubblicati

### Requirement: CTX-DEDUP-02 — Lo stato di invio è valido solo per la conversazione CLI corrente

Il sistema SHALL legare gli slot registrati come inviati a uno scope composto
dall'identificativo della sessione CLI e dal numero di compattazioni della sessione, e
SHALL scartare l'intero stato quando lo scope osservato differisce da quello memorizzato.

#### Scenario: Una nuova sessione CLI riparte dal contesto completo

- **GIVEN** una sessione con tutti gli slot registrati come inviati
- **WHEN** l'identificativo della sessione CLI cambia
- **AND** l'utente invia un messaggio
- **THEN** il preambolo contiene tutti gli slot abilitati

#### Scenario: Dopo una compattazione il contesto viene rimandato

- **GIVEN** una sessione con tutti gli slot registrati come inviati
- **WHEN** viene registrato un nuovo marker di compattazione per quella sessione
- **AND** l'utente invia un messaggio
- **THEN** il preambolo contiene tutti gli slot abilitati

#### Scenario: Un invio fallito non consuma lo stato

- **GIVEN** una sessione senza slot registrati come inviati
- **WHEN** un turno viene composto e l'invio al provider fallisce
- **AND** l'utente invia di nuovo un messaggio
- **THEN** il preambolo contiene tutti gli slot abilitati

### Requirement: CTX-DEDUP-03 — Uno slot ritirato viene dichiarato

Quando uno slot precedentemente inviato non è più presente tra quelli composti, il sistema
SHALL dichiararlo esplicitamente nel preambolo e SHALL rimuoverlo dallo stato di invio.

#### Scenario: La disattivazione del plan mode viene comunicata al modello

- **GIVEN** una sessione con lo slot `plan-mode` registrato come inviato
- **WHEN** l'utente invia un messaggio con plan mode disattivato
- **THEN** il preambolo contiene una riga che dichiara `plan-mode` non più in vigore

#### Scenario: Un ritiro già dichiarato non viene ripetuto

- **GIVEN** una sessione in cui il ritiro dello slot `plan-mode` è già stato dichiarato
- **WHEN** l'utente invia un altro messaggio con plan mode ancora disattivato
- **THEN** il preambolo non contiene alcuna riga di ritiro per `plan-mode`

### Requirement: CTX-ADAPT-01 — L'unità è lo SLOT COMPOSTO, e l'ordine è canonico qualunque sia l'ordine d'arrivo

I blocchi di contesto SHALL essere aggregati in SLOT COMPOSTI prima di diventare
messaggi: tutti i file in uno, la consapevolezza del progetto insieme ai suoi
modelli in un altro. L'unità NON SHALL essere il singolo blocco — riemettere
l'intestazione «i file di contesto per questo discorso» con dentro il solo file
cambiato è una frase FALSA rispetto a ciò che la sessione ha già. Uno slot
riparte INTERO, e resta coerente per costruzione.

L'ordine dei messaggi prodotti SHALL essere CANONICO e indipendente dall'ordine
in cui i blocchi arrivano. Il messaggio di sistema principale SHALL essere il
PRIMO.

I blocchi INFORMATIVI — quelli che l'app mostra ma non inietta — e quelli
DISATTIVATI NON SHALL diventare messaggi: l'interruttore nell'ispettore SHALL
avere effetto sul carico reale, o l'ispettore mente.

Un aggregato senza contenuto SHALL degradare in modo dichiarato: con i modelli
si usano i modelli, senza modelli si ripiega sull'elenco, senza nessuno dei due
resta la sola frase nuda — mai un'intestazione seguita dal vuoto.

Con ZERO blocchi la cronologia SHALL essere quella di partenza e il testo
dell'utente SHALL passare VERBATIM. Con dei blocchi la cronologia SHALL
cominciare con i messaggi di sistema e proseguire con quella di partenza.

I turni SCARTATI per far posto SHALL essere DICHIARATI nelle note: un contesto
tagliato in silenzio è la ragione per cui una risposta sembra amnesica senza che
nessuno sappia perché.

Il carico prodotto SHALL restare IDENTICO a quello del percorso che ha
sostituito, e questo SHALL essere verificato da un banco che confronta i due,
non dedotto: è l'unica prova che la riscrittura non ha cambiato ciò che il
modello legge.

#### Scenario: blocchi in ordine sparso
- **GIVEN** gli stessi blocchi consegnati in ordine diverso
- **THEN** i messaggi prodotti SHALL essere identici, nell'ordine canonico

#### Scenario: un modello disattivato nell'ispettore
- **GIVEN** un blocco disattivato
- **THEN** NON SHALL comparire nel carico

### Requirement: CTX-STRAT-01 — La strategia si DICHIARA, e il ripiego non concede mai quella che va chiesta

Ogni fornitore SHALL DICHIARARE la propria strategia di contesto, e la
dichiarazione esplicita SHALL avere la precedenza.

Le strategie SHALL restare DISTINTE: chi accetta una cronologia riceve i messaggi
di sistema in testa alla cronologia; chi tiene la sessione per conto suo li
riceve concatenati DENTRO il turno, senza cronologia; chi passa da un
intermediario con stato riceve la stessa forma del primo ma con note proprie e
SENZA i blocchi che riguardano strumenti che non può raggiungere.

Per un fornitore che NON dichiara niente, la strategia SHALL essere DEDOTTA
dalla presenza della capacità di gestire una cronologia.

Il ripiego NON SHALL MAI restituire la strategia dell'intermediario con stato:
quella va CHIESTA esplicitamente. Concederla per deduzione manderebbe a un
intermediario un carico costruito per lui senza che nessuno l'abbia deciso.

#### Scenario: un fornitore che non dichiara niente
- **GIVEN** un fornitore senza dichiarazione, con la capacità di cronologia
- **THEN** SHALL essere dedotta la strategia con cronologia

#### Scenario: l'intermediario con stato
- **GIVEN** un fornitore senza dichiarazione
- **THEN** NON SHALL essere dedotta la strategia dell'intermediario con stato

### Requirement: CTX-OVERRIDE-01 — Rigenerare vuol dire che il modello NON vede la risposta che sta sostituendo

Quando un turno viene modificato o rigenerato, la cronologia consegnata SHALL
essere quella SOSTITUITA, non quella a database: il modello NON SHALL vedere la
risposta che sta rimpiazzando, o rigenerare significa chiedergli di ripetersi.

In assenza di sostituzione la cronologia SHALL venire dal discorso a database.

Il CONTEGGIO dei messaggi riportato SHALL riflettere la sostituzione: un numero
che descrive la cronologia scartata non corrisponde a niente di ciò che il
modello ha letto.

Il preambolo SHALL essere quello CANONICO, con dentro la consapevolezza del
progetto: la vecchia ricostruzione a mano non la emetteva, e modifica e
rigenerazione erano gli unici due percorsi che ne restavano privi.

Gli interruttori dell'ispettore SHALL valere anche su questo percorso: ciò che è
disattivato NON SHALL rientrare dalla porta di servizio.

#### Scenario: rigenerare una risposta
- **GIVEN** un turno rigenerato
- **THEN** la risposta sostituita NON SHALL comparire nella cronologia consegnata

#### Scenario: un blocco disattivato, su questo percorso
- **GIVEN** un blocco disattivato nell'ispettore
- **THEN** NON SHALL rientrare nel carico della rigenerazione

### Requirement: CTX-SNAP-01 — Gli scatti sono un anello per discorso, e ciò che si consegna è una COPIA

Gli scatti del contesto SHALL essere conservati in un ANELLO di dimensione
LIMITATA per discorso: oltre il tetto, i più vecchi escono. Senza tetto una
diagnosi lasciata accesa diventa una perdita di memoria.

SHALL essere restituiti in ordine CRONOLOGICO.

Due discorsi SHALL essere ISOLATI: nessuno scatto di uno SHALL comparire
nell'altro.

Ciò che viene restituito SHALL essere una COPIA DIFENSIVA: modificarla NON SHALL
toccare ciò che è conservato.

Un discorso SCONOSCIUTO SHALL restituire un elenco VUOTO, mai «non definito»:
sono due cose che si trattano diversamente e una delle due fa cadere chi legge.

Uno scatto con identificativo VUOTO SHALL essere un non-fare: senza questa
regola tutti gli scatti senza discorso si accumulano sotto la stessa chiave, e
diventano visibili a chiunque la chieda.

Lo svuotamento SHALL poter colpire UN discorso solo — restituendo quanti ne ha
tolti — oppure TUTTO.

#### Scenario: oltre il tetto dell'anello
- **GIVEN** più scatti del tetto
- **THEN** SHALL restare gli ultimi, in ordine cronologico

#### Scenario: uno scatto senza discorso
- **GIVEN** uno scatto con identificativo vuoto
- **THEN** NON SHALL essere conservato sotto nessuna chiave

### Requirement: CTX-PREVIEW-01 — L'anteprima del contesto e l'anello degli scatti sono raggiungibili dall'esterno

Il contesto di un discorso SHALL essere ISPEZIONABILE dall'esterno: la busta
canonica E il carico che il fornitore riceverà.

Un discorso SCONOSCIUTO SHALL essere dichiarato assente.

L'anello degli scatti SHALL essere leggibile per discorso — vuoto all'inizio, con
dentro ciò che è stato registrato — e SHALL essere SVUOTABILE per discorso.

I percorsi che non appartengono a questa superficie SHALL essere LASCIATI PASSARE,
o un instradatore a catena si mangia le rotte di quelli dopo.

#### Scenario: un discorso sconosciuto
- **GIVEN** un identificativo che non esiste
- **THEN** SHALL essere dichiarato assente

#### Scenario: un percorso di qualcun altro
- **GIVEN** una richiesta non di questa superficie
- **THEN** SHALL essere lasciata passare
