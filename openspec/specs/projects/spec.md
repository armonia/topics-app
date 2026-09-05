# Projects

First-class project entities owning worktrees.

### Requirement: PROJECT-01 — Project Entity Lifecycle

The system SHALL persist a first-class `Project` entity representing a registered codebase or working directory, supporting create, read, update (rename + metadata), archive, restore, and delete operations. Projects are user-global and not space-scoped in this phase.

#### Scenario: Create a project from a directory path
- **GIVEN** the user opens the Project creation flow
- **WHEN** the user provides a name and an absolute filesystem path
- **THEN** the system SHALL persist a new row in the `projects` table with a generated UUID id, a slug derived from the name, and the provided path
- **AND** SHALL broadcast `project:new` over the WebSocket channel to all connected clients
- **AND** the new project SHALL appear in the project list returned by `GET /api/projects`

#### Scenario: Project slug is unique
- **GIVEN** a project named "Topics App" already exists with slug `topics-app`
- **WHEN** another project named "Topics App" is created
- **THEN** the system SHALL reject the request with HTTP 409 and an error payload describing the slug collision
- **AND** the user SHALL be offered an editable slug field to disambiguate

#### Scenario: Project path validation
- **GIVEN** the user is creating a project
- **WHEN** the provided path does not exist on the filesystem at create time
- **THEN** the system SHALL reject the request with HTTP 400 and a clear error message naming the missing path
- **AND** no row SHALL be persisted

#### Scenario: Lookup project by path
- **GIVEN** a project exists at path `/Users/x/code/foo`
- **WHEN** a client calls `GET /api/projects?path=/Users/x/code/foo`
- **THEN** the system SHALL return the matching project record
- **AND** if no match exists, SHALL return HTTP 200 with body `null` (not 404)

#### Scenario: Update project metadata
- **GIVEN** a project exists
- **WHEN** the user issues `PATCH /api/projects/:id` with a new name, color, or icon
- **THEN** the system SHALL persist the update with a new `updated_at` timestamp
- **AND** SHALL broadcast `project:updated` to all clients
- **AND** changing the name SHALL NOT change the slug (slug is immutable)

#### Scenario: Archive project hides it from active list
- **GIVEN** a project is active
- **WHEN** the user archives the project via `POST /api/projects/:id/archive`
- **THEN** the project SHALL be marked `archived=1` in the database
- **AND** SHALL no longer appear in `GET /api/projects` (which defaults to non-archived)
- **AND** SHALL appear in `GET /api/projects?archived=true`
- **AND** SHALL broadcast `project:archived` to all clients

#### Scenario: Restore archived project
- **GIVEN** a project is archived
- **WHEN** the user issues `POST /api/projects/:id/restore`
- **THEN** the project's `archived` flag SHALL flip back to 0
- **AND** SHALL reappear in the default `GET /api/projects` list
- **AND** SHALL broadcast `project:updated`

#### Scenario: Delete project with confirmation
- **GIVEN** a project has zero worktrees and zero topics referring to its path
- **WHEN** the user issues `DELETE /api/projects/:id`
- **THEN** the system SHALL remove the row and SHALL broadcast `project:deleted`

#### Scenario: Delete project blocked when worktrees exist
- **GIVEN** a project has at least one worktree
- **WHEN** the user issues `DELETE /api/projects/:id`
- **THEN** the system SHALL respond HTTP 409 with body listing the dependent worktrees
- **AND** the project SHALL remain unchanged
- **AND** the user SHALL be guided to delete worktrees first

### Requirement: PROJECT-02 — Backward Compatibility With `project_path` Strings

The system SHALL allow existing topics, tasks, and boards that reference a project via the legacy `project_path` / `project_id` string columns to continue functioning without any forced migration to the new `projects` table. Auto-creation of project records is optional and never destructive.

#### Scenario: Legacy topic without a project record
- **GIVEN** a topic exists with `project_path = '/Users/x/code/foo'` and no `projects` row matches that path
- **WHEN** the user opens that topic
- **THEN** all chat, tool, file, and git operations SHALL behave exactly as before this change
- **AND** the topic settings panel SHALL NOT show a Project or Worktree section

#### Scenario: Legacy topic gains a project on user action
- **GIVEN** a topic with `project_path = '/Users/x/code/foo'` and no matching `projects` row
- **WHEN** the user explicitly creates a Project at that path via the new UI
- **THEN** the new `projects` row SHALL be created
- **AND** the existing topic's `project_path` SHALL remain set unchanged
- **AND** subsequent topics opened against that path MAY display the new Project in the topic settings

#### Scenario: Tasks `project_id` string is unaffected
- **GIVEN** the `tasks` table holds rows with `project_id` as a string (often a project path)
- **WHEN** any project is created, modified, or deleted
- **THEN** the `tasks.project_id` column SHALL remain a string with no FK constraint to `projects.id`
- **AND** all existing board APIs SHALL continue to work exactly as today

### Requirement: PROJECT-03 — WebSocket Broadcast Hygiene

All project-mutating endpoints SHALL emit a typed WebSocket broadcast immediately after a successful database commit, using the existing `broadcastToAll` helper, and the broadcast envelope SHALL contain the project's full row plus a `payload_version: 1` field for forward compatibility.

#### Scenario: Broadcast follows the database commit
- **WHEN** any project mutation succeeds
- **THEN** the WebSocket broadcast SHALL be sent within 50 ms of the commit
- **AND** the broadcast envelope SHALL be `{ type: 'project:<verb>', project: <row>, payload_version: 1 }`
- **AND** clients receiving the broadcast SHALL be able to update their cache without a follow-up REST call

#### Scenario: Broadcast does not fire on validation failure
- **GIVEN** a project mutation request is rejected by validation
- **WHEN** the request is processed
- **THEN** no `project:*` broadcast SHALL be emitted
- **AND** no row SHALL be persisted

### Requirement: PROJECT-04 — A Shared Project Says So On Its Tab

A project tab SHALL carry the organisation's mark when, and only when, that project is visible to someone other than the person looking at it. The mark SHALL name the organisation it is shared with, SHALL be anchored by a stable `data-testid` rather than a styling class, and SHALL appear and disappear as the sharing changes, without a reload.

The condition is deliberately narrower than `projects.org_id != null`: every project created on an installation is stamped with that installation's own organisation, so the column is set on projects nobody else can see. The mark follows the warning — "other people can read this" — not the column.

#### Scenario: A project shared with an organisation of several people
- **GIVEN** a project whose `org_id` names a live organisation with more than one live member
- **AND** the project is not marked `incognito`
- **WHEN** its tab is rendered
- **THEN** the tab SHALL show the organisation mark
- **AND** the mark's tooltip SHALL name the organisation

#### Scenario: An organisation whose only member is me is not "shared"
- **GIVEN** a project whose `org_id` names an organisation with exactly one live member
- **WHEN** its tab is rendered
- **THEN** the tab SHALL show no organisation mark
- **AND** the same SHALL hold for a project with `org_id` NULL, for a project marked `incognito`, and for an `org_id` the client cannot resolve to a name

#### Scenario: The mark follows the sharing live
- **GIVEN** a tab showing a shared project
- **WHEN** the project is marked `incognito` and the server emits `project:updated`
- **THEN** the mark SHALL disappear without a page reload
- **AND** clearing `incognito` again SHALL bring it back the same way

### Requirement: PROJECT-05 — L'icona di un progetto si serve solo per cartelle già conosciute

La rotta che serve l'icona di un progetto SHALL accettare un percorso scelto dal
client, e per questo SHALL servirla SOLO per cartelle che il server già conosce
per altra via. Senza quel vincolo la rotta è un modo per enumerare il disco di
chi ospita il server.

L'elenco delle cartelle conosciute SHALL essere l'UNIONE di ogni sorgente in cui
un progetto può comparire — l'indice dei progetti, i percorsi dei topic, i
worktree, le cartelle di lavoro dei terminali, i riferimenti nello stato
dell'interfaccia, e i progetti del workspace che portano un marcatore. Un
cancello sul solo indice dei progetti negherebbe quasi tutto: quasi nessun
progetto è registrato lì.

Il confronto SHALL essere ESATTO e mai per prefisso: «dentro un progetto noto»
aprirebbe ogni discendente all'enumerazione.

L'elenco SHALL essere ricalcolato a ogni richiesta e mai messo in cache: una
cache che memorizza un DINIEGO lo cristallizza, e una cartella appena aperta è
già legittima.

Una cartella conosciuta ma senza icona SHALL rispondere «niente da mostrare»,
non «non esiste»: sono due fatti diversi e il secondo sarebbe falso.

#### Scenario: una cartella che diventa nota
- **GIVEN** una cartella rifiutata perché sconosciuta
- **WHEN** diventa nota per una qualunque delle sorgenti
- **THEN** l'icona SHALL essere servita, senza bisogno di ricostruire niente

#### Scenario: una sottocartella
- **GIVEN** un progetto noto e una sua sottocartella
- **THEN** il progetto SHALL essere servito e la sottocartella SHALL essere rifiutata

#### Scenario: nota ma senza icona
- **GIVEN** una cartella nota che non porta nessuna icona
- **THEN** la risposta SHALL dire «niente», non «non trovato»

### Requirement: PROJECT-06 — Il percorso di un progetto si ri-deduce, e non si indovina mai

L'identificativo di un progetto SHALL essere ricondotto al suo percorso
ri-calcolando l'identificativo di ogni candidato, e NON tenendo una mappa
inversa: una mappa è una seconda verità che un giorno diverge.

Il riconoscimento di una cartella come progetto SHALL richiedere un MARCATORE, e
l'elenco delle cartelle nascoste da escludere SHALL essere dichiarato per nome —
con l'eccezione, esplicita, della cartella di lavoro dell'agente, i cui figli
sono progetti legittimi.

Dedurre un percorso da una CONVERSAZIONE SHALL avvenire in due giri: prima si
cerca un percorso che ESISTE ed è una cartella, su tutto il testo; poi, solo sui
messaggi di una PERSONA, un percorso che ancora non esiste ma il cui genitore sì
— è il caso di «creami un progetto in…».

Il secondo giro NON SHALL poter contraddire il primo: un percorso che esiste ma
NON è una cartella SHALL essere saltato, mai restituito. Senza questa regola un
eseguibile da sedici kilobyte è diventato un progetto fantasma.

Senza nessun riscontro la risposta SHALL essere «non lo so», mai un default.

La cartella in cui NASCE un progetto nuovo SHALL essere dedotta dal genitore
comune dei progetti già noti, SHALL richiedere una maggioranza di almeno due, e
il genitore scelto SHALL esistere. Le cartelle nascoste e la home nuda NON SHALL
essere candidate.

Le chiavi derivate da un percorso SHALL essere calcolate in UN punto solo. Erano
in tre copie indipendenti, e una derivazione fuori sincrono fa sparire una pane
senza nessun errore.

#### Scenario: un file che sembra un progetto
- **GIVEN** un testo che nomina un percorso esistente che è un file
- **THEN** NON SHALL essere restituito come progetto

#### Scenario: un solo progetto conosciuto
- **GIVEN** un solo progetto noto
- **THEN** la cartella per i nuovi NON SHALL essere dedotta dal suo genitore

### Requirement: PROJECT-07 — Incognito vuol dire NESSUNO, e chi non vede riceve solo l'identificativo

La visibilità di un progetto SHALL essere decisa per OSSERVATORE. Un progetto
marcato INCOGNITO SHALL essere visibile SOLO a chi l'ha marcato — nemmeno ai
compagni della stessa organizzazione, e nemmeno al proprietario
dell'installazione se il progetto appartiene a un'altra persona.

Due identità ASSENTI NON SHALL valere come la stessa persona: il vuoto non è un
identificativo.

La macchina stessa SHALL vedere tutto, incogniti compresi.

**Chi NON vede un progetto SHALL ricevere un annuncio col SOLO identificativo** —
niente nome, niente percorso. Un annuncio completo mandato a tutti rivela, con i
suoi campi, esattamente ciò che l'incognito doveva nascondere. La regola SHALL
valere su TUTTI gli annunci che riguardano un progetto, quello di creazione
compreso: proteggere solo la modifica lascia aperta la nascita.

Un progetto senza organizzazione SHALL restare visibile a chi lo possiede e al
proprietario dell'installazione, com'era prima che esistessero le colonne della
condivisione.

#### Scenario: un compagno di organizzazione
- **GIVEN** un progetto incognito e una persona della stessa organizzazione
- **THEN** NON SHALL vederlo

#### Scenario: annuncio a chi non vede
- **GIVEN** un annuncio di progetto verso chi non ha visibilità
- **THEN** SHALL contenere il solo identificativo

### Requirement: PROJECT-08 — «Apri il progetto Pix» si risolve senza toccare il disco, e le omonimie si dichiarano tutte

Un riferimento UMANO a un progetto — il nome che gli ha dato chi lo usa, la sua
sigla, il nome della cartella — SHALL essere risolto contro un elenco di
candidati SENZA toccare il filesystem: la verifica su disco appartiene a chi
costruisce l'elenco, non a chi confronta.

Il confronto SHALL ignorare le maiuscole e SHALL provare nell'ordine: sigla
esatta, nome esatto, nome della cartella. La FORZA del livello SHALL essere
mantenuta: una corrispondenza di sigla viene prima di una di nome, che viene
prima di una di cartella — così una corrispondenza casuale sul nome della
cartella non scavalca quella che chi parla intendeva.

**Le omonimie SHALL essere restituite TUTTE**, nell'ordine dei candidati: due
progetti che si chiamano allo stesso modo esistono davvero, e sceglierne uno per
conto di chi ha parlato è indovinare. I percorsi ripetuti SHALL essere
deduplicati — molti topic legati allo stesso repo sono lo stesso progetto.

Un riferimento sconosciuto o vuoto SHALL dare NIENTE.

#### Scenario: due progetti con lo stesso nome di cartella
- **GIVEN** due candidati la cui cartella si chiama allo stesso modo
- **THEN** SHALL essere restituiti entrambi, nell'ordine dei candidati

#### Scenario: sigla contro cartella
- **GIVEN** una corrispondenza di sigla e una di nome cartella più avanti nell'elenco
- **THEN** SHALL vincere la sigla

### Requirement: PROJECT-09 — L'icona di un progetto si cerca dove i progetti veri la mettono

L'immagine che rappresenta un progetto SHALL essere cercata per PRIORITÀ
dichiarata: prima i file convenzionali dei vari impianti, poi le icone
dichiarate in un manifesto, poi il collegamento nella pagina iniziale, e infine
una scansione per nome nelle cartelle di risorse più comuni — che è ciò che
trova i file di marchio nominati liberamente, spediti senza nessuna impalcatura
attorno.

Fra le icone di un manifesto SHALL essere scelta la PIÙ GRANDE dichiarata.

Le sorgenti REMOTE SHALL essere ignorate, sia nel manifesto sia nel collegamento
della pagina: servire un'immagine presa dalla rete per conto di un progetto è
un'altra cosa da mostrare la sua icona.

Un'icona INCORPORATA nel collegamento SHALL essere servita — è uno schema molto
comune — e SHALL funzionare anche quando contiene virgolette singole e caratteri
di parentesi angolare al proprio interno. Un contenuto incorporato che NON è
un'immagine SHALL essere rifiutato.

La lettura del collegamento SHALL reggere l'ordine degli attributi invertito, e
SHALL saltare i collegamenti che non sono icone senza fermarsi al primo trovato.

Un manifesto malformato NON SHALL far fallire la ricerca: si passa alla fonte
successiva.

Una cartella qualunque SHALL dare NIENTE, non un'icona inventata.

#### Scenario: un'icona incorporata con caratteri ostili
- **GIVEN** un'icona incorporata che contiene virgolette e parentesi angolari
- **THEN** SHALL essere servita intera

#### Scenario: un manifesto rotto
- **GIVEN** un manifesto che non si riesce a interpretare
- **THEN** la ricerca SHALL proseguire con le fonti successive

### Requirement: PROJECT-10 — Aprire un percorso dal sistema: una cartella è un progetto, un file è il progetto che lo contiene

Un percorso consegnato dal sistema operativo SHALL essere risolto in una scheda:
una CARTELLA SHALL diventare un progetto; un FILE SHALL aprire il progetto che
lo CONTIENE, con quel file a fuoco.

La regola SHALL essere PURA e condivisa fra i due lati: la sonda che tocca il
disco SHALL essere separata dalla decisione, o la decisione non si può verificare
senza un disco.

Dentro un insieme di pacchetti SHALL vincere la RADICE che porta il marcatore del
sistema di versione, non il pacchetto più vicino al file.

Un progetto GIÀ APERTO SHALL vincere sui marcatori: aprire lo stesso lavoro due
volte con due radici diverse è come nascono i doppioni.

Un file SCIOLTO — senza nessuna radice sopra di sé — SHALL aprire la cartella che
lo contiene.

La forma con cui il gestore di file del sistema consegna un percorso SHALL
passare dalla STESSA porta: due strade producono due comportamenti.

Un percorso che NON ESISTE, e un percorso RELATIVO, NON SHALL aprire niente.

La risalita verso l'alto SHALL fermarsi a un tetto di antenati: senza, un file
fuori posto fa risalire fino alla radice del disco.

#### Scenario: un file dentro un insieme di pacchetti
- **GIVEN** un file dentro un pacchetto, sotto una radice col marcatore
- **THEN** SHALL essere aperta la radice, col file a fuoco

#### Scenario: un percorso relativo
- **GIVEN** un percorso non assoluto
- **THEN** NON SHALL essere aperto niente

### Requirement: PROJECT-11 — Il confine dei percorsi è l'insieme dei progetti CONOSCIUTI, ricalcolato

Un percorso che arriva dal client SHALL essere accettato solo se sta DENTRO un
progetto CONOSCIUTO. Il confine SHALL essere l'UNIONE di più sorgenti — i
discorsi, le copie di lavoro, le cartelle dei terminali, i riferimenti nello stato
dell'interfaccia, e i progetti enumerati nello spazio di lavoro con il proprio
MARCATORE.

Troppo stretto fa sparire l'icona di progetti veri; troppo largo permette di
enumerare il disco.

Una cartella senza marcatore NON SHALL entrare.

Il confine SHALL essere RICALCOLATO: ciò che diventa un progetto DOPO un diniego
SHALL entrare al giro successivo. Una risposta memorizzata lo terrebbe fuori per
sempre.

Il confronto SHALL rispettare il SEPARATORE: la cartella stessa e i suoi
discendenti sì, un fratello che ne condivide il prefisso del nome NO.

Senza uno spazio di lavoro dichiarato SHALL essere dedotto dall'ambiente: le porte
dei file non lo ricevono.

Le sorgenti che si SCRIVONO con una richiesta — la cartella di un terminale, un
progetto registrato, il progetto di un discorso, un riferimento nello stato
dell'interfaccia — SHALL accettare da un dispositivo APPAIATO solo un percorso
già DENTRO un progetto conosciuto (o il valore predefinito troppo ampio, che il
confine scarta comunque). Altrimenti bastano DUE chiamate: si nomina la cartella
delle chiavi come progetto, e la si rilegge dalla porta dei file. Il permesso
SHALL essere lo STESSO per tutte e quattro, e NON SHALL valere per chi è già
sulla macchina (nessun dispositivo) né per un agente col proprio gettone: a loro
non toglierebbe niente.

Un riferimento a una cartella SPARITA NON SHALL far fallire la scrittura: non
aggiunge nessuna radice, e rifiutarlo bloccherebbe la sincronizzazione di un
dispositivo per una fotografia vecchia.

#### Scenario: un dispositivo appaiato registra la cartella delle chiavi
- **GIVEN** un percorso fuori da ogni progetto conosciuto
- **THEN** SHALL essere rifiutato, e il file dentro quella cartella SHALL restare irraggiungibile

#### Scenario: la stessa richiesta da chi è sulla macchina
- **GIVEN** nessun dispositivo appaiato
- **THEN** SHALL passare

#### Scenario: una cartella diventata progetto dopo un diniego
- **GIVEN** un secondo tentativo
- **THEN** SHALL essere accettata

#### Scenario: un fratello con lo stesso prefisso
- **GIVEN** una cartella accanto con un nome che comincia uguale
- **THEN** NON SHALL essere considerata dentro

### Requirement: PROJ-ID-01 — la cartella è il progetto, non la strada per arrivarci

Quando un percorso di progetto viene memorizzato su un topic, DEVE essere canonicalizzato
(link risolti, `~` espanso, barra finale tolta). Due percorsi che puntano alla stessa
cartella DEVONO produrre lo stesso `projectId` e le stesse chiavi `ui_state`.

#### Scenario: un topic creato su un symlink
- **GIVEN** `~/link-al-progetto` è un link a `~/Projects/progetto`
- **WHEN** si crea un topic con `projectPath: "~/link-al-progetto"`
- **THEN** il topic risulta legato a `~/Projects/progetto`, e nella sidebar c'è una voce sola

#### Scenario: una cartella non ancora creata
- **WHEN** si crea un topic con un `projectPath` che non esiste
- **THEN** il percorso si conserva com'è e la creazione riesce

### Requirement: PROJ-ID-02 — ciò che è già scritto si fonde solo su richiesta

La canonicalizzazione NON DEVE riscrivere percorsi già memorizzati. La fusione delle
identità doppie esistenti DEVE essere un'operazione esplicita, che per default si limita
a elencare cosa cambierebbe.

#### Scenario: la prova non scrive
- **WHEN** si esegue lo script senza `--esegui`
- **THEN** stampa vecchio e nuovo id con i conteggi, e il database resta invariato

#### Scenario: la fusione scrive solo con `--esegui`
- **WHEN** si esegue lo script con `--esegui` su un percorso salvato che è un link
- **THEN** i topic, le righe `tasks` e le chiavi `ui_state` passano sotto l'identità della cartella vera, in una transazione sola

### Requirement: PROJ-ID-03 — Il pannello di una cartella sparita confluisce nel gemello, e si RIMAPPA

Quando lo stato dei pannelli (`pane-store-v2`) viene SCRITTO dal client, un pannello
di progetto il cui percorso NON esiste più e che ha un gemello in `~/Projects` con lo
stesso nome DEVE confluire nel pannello del gemello. Ripulire il database non basta: il
client rispinge il proprio `pane-store-v2` da localStorage e il doppione torna. Il
filtro sta quindi sulla scrittura, non su una bonifica.

La rimappatura DEVE toccare anche la fila delle tab (`groups.*.paneIds`) e un
`projectPath` scritto per esteso: cancellare il solo pannello lascia una tab che punta
a niente, ed è quella tab a comparire doppia.

Una cartella sparita SENZA gemello NON DEVE essere toccata: un disco esterno smontato
non perde i propri pannelli.

#### Scenario: il pannello del percorso sparito confluisce in quello vero
- **GIVEN** uno stato con un pannello su `~/.openclaw/workspace/x` (non esiste più) e uno su `~/Projects/x`
- **WHEN** il client scrive `pane-store-v2`
- **THEN** resta il solo pannello di `~/Projects/x`, con il proprio contenuto
- **AND** nella fila delle tab l'id vecchio è sostituito da quello vero, non rimosso

#### Scenario: un disco smontato non perde i pannelli
- **GIVEN** un pannello su un percorso che non esiste e non ha un gemello in `~/Projects`
- **WHEN** il client scrive `pane-store-v2`
- **THEN** il pannello resta com'è

### Requirement: PROJECT-12 — Zero modifiche git non è un numero da mostrare: è una sezione che non c'è

Le superfici che raccontano le modifiche git NON SHALL comparire quando le modifiche
sono zero. Un riquadro intitolato «modifiche git» con scritto «0 file» spende una riga
per dire che non è successo niente, e la riga vale più di quell'informazione.

Nella sidebar del progetto la sezione git (e il suo bottone nella striscia compatta)
SHALL comparire solo quando il repository ha qualcosa da dire: file non committati,
oppure commit avanti o indietro rispetto al remoto. I commit non spinti restano dentro
perché sono lavoro in volo, non pulizia.

La condizione SHALL essere VIVA: la sezione torna da sola alla prima modifica, senza
riaprire il progetto.

Sulla card della board la pastiglia delle modifiche git SHALL sparire quando il
conteggio letto è zero. Un conteggio ANCORA NON MISURATO non è uno zero: durante un
turno in corso la pastiglia resta, senza numero, perché «non l'ho ancora contato» e
«non è cambiato niente» sono due frasi diverse.

Quando invece le modifiche ci sono, conteggi e pastiglie SHALL restare esattamente
com'erano.

#### Scenario: un progetto pulito
- **GIVEN** un repository senza modifiche e allineato al remoto
- **THEN** nella sidebar non c'è nessuna sezione «modifiche git», né il suo bottone

#### Scenario: la prima modifica la fa tornare
- **GIVEN** lo stesso progetto pulito
- **WHEN** un file cambia sul disco
- **THEN** la sezione compare, col conteggio di sempre

#### Scenario: commit non spinti
- **GIVEN** un repository senza modifiche ma con un commit avanti al remoto
- **THEN** la sezione resta visibile

#### Scenario: la card di un turno in corso
- **GIVEN** una consegna che non ha ancora un conteggio
- **THEN** la pastiglia resta, e sparisce solo se il conteggio letto è zero
