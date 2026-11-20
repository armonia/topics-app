# remote-access Specification

## Purpose
TBD - created by archiving change complete-spec-coverage. Update Purpose after archive.
## Requirements
### Requirement: AUTHGATE-01 — Un nome che COMINCIA per «127.» non è il loopback, e il rebinding è la prova

Il riconoscimento dell'indirizzo locale SHALL essere per valore LETTERALE, mai
per prefisso. Un nome pubblico che comincia con le cifre del loopback, o col nome
della macchina locale seguito da altro, NON SHALL essere trattato come locale.

Non è teoria: esistono servizi di nomi con jolly gratuiti che risolvono
`<qualunque-cosa>` su `127.0.0.1`. Con il riconoscimento per prefisso, un sito
ostile che punta a uno di quei nomi otteneva **200 sul server vivo** su una rotta
che esegue comandi. La stessa protezione SHALL valere anche sulle LETTURE: chi
riesce a leggere la risposta ha già ottenuto ciò che voleva.

Un nome ribattezzato sull'indirizzo locale SHALL essere rifiutato **anche con
un'identità VALIDA**: l'identità dice chi sei, non da dove stai chiamando.

La sentinella interna che rappresenta «locale» NON SHALL poter essere inviata
come intestazione: un valore che collide con un marcatore interno è un modo di
entrare.

L'intestazione dell'ospite ASSENTE SHALL passare — chi è già sulla macchina non
la manda — ma assente INSIEME a un'origine dichiarata, su una richiesta che
MODIFICA, SHALL essere rifiutata.

Il controllo dell'origine SHALL coprire anche il socket PRIMARIO, non solo i suoi
sotto-percorsi: è il buco più facile da lasciare, perché il percorso nudo non
somiglia agli altri.

Un'origine OPACA SHALL essere rifiutata: una pagina che nasconde la propria
provenienza non ha diritto di scrivere.

I nomi della propria macchina SHALL essere riconosciuti anche SENZA punti e anche
PIENAMENTE QUALIFICATI col punto finale: sono le due forme che i sistemi di
scoperta locale producono, e rifiutarle chiude fuori il telefono di casa.

L'elenco delle origini ammesse SHALL essere riletto A OGNI CHIAMATA: metterlo in
cache al primo uso rende impossibile cambiarlo senza riavviare. E SHALL ammettere
SOLO ciò che elenca: nessun sosia per suffisso, nessuno schema declassato,
nessuna porta diversa.

#### Scenario: un nome jolly che risolve sul loopback
- **GIVEN** una richiesta il cui ospite dichiarato risolve sull'indirizzo locale ma non lo è letteralmente
- **THEN** SHALL essere rifiutata, anche con un'identità valida

#### Scenario: il socket primario
- **GIVEN** una connessione al percorso nudo del socket con origine forestiera
- **THEN** SHALL essere rifiutata

### Requirement: AUTHGATE-02 — Il caricamento accetta solo dentro le radici, e il percorso si risolve PRIMA

Un file caricato SHALL poter atterrare SOLO dentro una radice consentita, e il
confronto SHALL avvenire sul percorso RISOLTO, non sulla stringa.

Un fratello che condivide il PREFISSO del nome NON SHALL passare: la
somiglianza testuale non è contenimento. I salti verso l'alto SHALL essere
normalizzati prima del confronto.

Un collegamento simbolico che a stringa sembra dentro la radice ma RISOLVE fuori
SHALL essere rifiutato: è il modo con cui una cartella consentita diventa una
finestra su chiavi private.

**Senza nessuna radice configurata SHALL essere rifiutato TUTTO, non consentito
tutto.** Una configurazione mancante non è un permesso.

Le radici vuote e la radice assoluta SHALL essere scartate: accettare la radice
del disco apre l'intero sistema.

#### Scenario: un collegamento che punta fuori
- **GIVEN** un collegamento dentro la radice che risolve altrove
- **THEN** SHALL essere rifiutato

#### Scenario: nessuna radice configurata
- **GIVEN** una configurazione senza radici
- **THEN** ogni percorso SHALL essere rifiutato

### Requirement: PAIRING-01 — Chi bussa si presenta con un FATTO, e l'installazione ha un nome

La schermata che chiede di autorizzare un dispositivo SHALL dire DA DOVE arriva
la richiesta in parole, non solo con un numero: questa macchina, la rete di casa,
Internet, oppure sconosciuto.

Un indirizzo privato e uno pubblico si leggono allo stesso modo se non si sa
cosa significhi il prefisso — e distinguerli non è una cosa che chi possiede il
computer debba sapere per decidere se far entrare qualcuno. La differenza conta:
un dispositivo sulla rete locale è già dentro casa; qualcosa che arriva dal ponte
può essere il proprio telefono fuori casa oppure chiunque abbia ricevuto un link.

Il riconoscimento SHALL leggere gli ottetti come NUMERI, non come prefisso di
testo: l'intervallo privato che comincia con lo stesso ottetto di indirizzi
pubblici si distingue solo guardando il secondo.

Il rivestimento che incapsula un indirizzo vecchio dentro uno nuovo NON SHALL
cambiare la risposta.

Ciò che non si riconosce SHALL restare SCONOSCIUTO e NON SHALL diventare
«Internet»: non sapere non è la stessa cosa che sapere il caso peggiore.

Questo giudizio NON SHALL essere una decisione di accesso: nessun ramo di
autorizzazione SHALL leggerlo. Serve a mettere una frase accanto a un numero, e
la decisione resta di chi possiede la macchina. Per la stessa ragione il
riconoscimento del «locale» SHALL essere un DOPPIONE deliberato di quello che
governa il cancello: quello tiene una porta e non deve poter cambiare per ragioni
di presentazione — e questo è quello che qualcuno sarà tentato di allargare.

L'installazione SHALL avere un NOME leggibile. Finché ne esiste una sola la
domanda non si pone; dal momento che ce ne sono due — un portatile e un fisso,
l'installazione di prova accanto a quella vera, due persone sulla stessa rete —
«autorizza» diventa una richiesta senza soggetto.

Il nome SHALL stare in UNA riga: senza caratteri di controllo, senza a-capo, e
non più lungo di un limite dichiarato. Il suffisso che i sistemi di scoperta
locale appendono NON SHALL arrivare a chi legge. Il costo per ricavarlo SHALL
essere pagato UNA volta sola.

#### Scenario: un indirizzo pubblico che comincia come uno privato
- **GIVEN** un indirizzo il cui primo ottetto coincide con quello di un intervallo privato ma il secondo no
- **THEN** SHALL essere classificato come Internet

#### Scenario: un indirizzo che non si riconosce
- **GIVEN** un indirizzo assente o non riconosciuto
- **THEN** SHALL restare sconosciuto, NON «Internet»

### Requirement: PAIRING-02 — La coda dell'accoppiamento non si rifiuta MAI: si sfratta

Una richiesta di accoppiamento NON SHALL essere rifiutata perché «la coda è
piena». Misurato attraverso il ponte il 21/08/2026: la prima richiesta passava,
ogni successiva veniva respinta — e a essere respinto era il telefono di chi
possiede la macchina, non l'attaccante.

Il tetto totale SHALL essere alto abbastanza da non scattare nell'uso normale, e
quando si raggiunge SHALL essere SFRATTATA una richiesta, non rifiutata quella
nuova.

Lo sfratto SHALL colpire la più vecchia del gruppo PIÙ NUMEROSO — cioè di chi sta
inondando — e a parità di numero la più vecchia in assoluto. Una richiesta
legittima NON SHALL essere sfrattata finché esiste un gruppo più lungo del suo.

Il limite PER INDIRIZZO SHALL restare basso, e SHALL continuare a valere: lo
sfratto NON SHALL trasformarsi in un innalzamento del limite. Chi arriva al
proprio tetto NON SHALL toccare le richieste di un ALTRO indirizzo.

Gli indirizzi SCONOSCIUTI NON SHALL condividere una quota fra loro: due
sconosciuti non devono potersi sfrattare a vicenda.

Su una coda vuota non c'è niente da sfrattare, e sotto il tetto NON SHALL essere
sfrattato niente.

> Limite accettato e dichiarato: a una richiesta per indirizzo, chi inonda da
> molti indirizzi diversi a bassa intensità non è distinguibile da molte persone
> vere. È una scelta, non una svista.

#### Scenario: la coda è piena e arriva chi bussa una volta sola
- **GIVEN** la coda al tetto totale e una richiesta da un indirizzo nuovo
- **THEN** SHALL entrare, e a uscire SHALL essere una del gruppo più numeroso

#### Scenario: due indirizzi, uno al proprio tetto
- **GIVEN** un indirizzo che ha raggiunto il proprio limite
- **THEN** le richieste dell'altro indirizzo NON SHALL essere toccate

### Requirement: PAIRING-03 — Lo schermo di appaiamento è RAGGIUNGIBILE su uno schermo corto, e dice CHI È

Lo schermo di appaiamento SHALL SCORRERE, e la sua altezza minima SHALL seguire
l'altezza VIVA della finestra: misurato su uno schermo corto, il contenuto finiva
oltre il bordo visibile con nessun modo di raggiungerlo.

SHALL centrarsi SOLO quando avanza spazio: una centratura simmetrica taglia anche
la testata.

SHALL DIRE chi è — l'icona dell'applicazione, la versione e lo stato della chiave
— perché è la prima schermata che una persona vede e non deve sembrare una pagina
qualunque.

Il messaggio d'errore NON SHALL essere azzerato a ogni tentativo prima della
richiesta: produrrebbe un lampeggio a ogni ritentativo. SHALL essere azzerato al
successo.

#### Scenario: uno schermo corto
- **GIVEN** una finestra più bassa del contenuto
- **THEN** il contenuto SHALL essere raggiungibile scorrendo

#### Scenario: un ritentativo
- **GIVEN** un errore mostrato e un nuovo tentativo
- **THEN** il messaggio NON SHALL lampeggiare

### Requirement: PAIRING-04 — Chi chiede riceve un codice DA MOSTRARE, e la coda non chiude fuori chi arriva

Chi chiede di appaiarsi SHALL ricevere un codice DA MOSTRARE, non un campo dove
scriverlo, e il codice NON SHALL contenere caratteri ambigui.

Dallo stesso indirizzo SHALL essere SEMPRE possibile chiedere: oltre il tetto la
richiesta più VECCHIA lascia il posto, e il suo orologio SHALL SPEGNERSI invece di
restare armato per sempre. Applicato come RIFIUTO, bastavano pochi indirizzi con
poche richieste a testa perché da lì in poi non entrasse più NESSUNO — compreso il
proprietario col proprio telefono.

Il segreto per ritirare SHALL essere obbligatorio, e sbagliarlo SHALL essere
INDISTINGUIBILE dal non esistere: un identificativo inventato, un segreto
mancante e uno sbagliato SHALL dare la STESSA risposta. Il segreto NON SHALL MAI
comparire nel messaggio che annuncia l'appaiamento.

Una condivisione verso un PROPRIETARIO SHALL essere rifiutata — vede già tutto — e
il ruolo SHALL DISCENDERE dalla persona, mai risalire. Un ospite SHALL ricevere
SOLO ciò che gli è stato concesso, e l'elenco delle risorse permesse NON SHALL
contenere la porta che le espone tutte.

Togliere una condivisione SHALL togliere la riga; REVOCARE SHALL marcarla. Sono
due gesti diversi.

Con il canale remoto SPENTO NON SHALL essere più coniato niente, ma SHALL essere
ancora possibile REVOCARE: un interruttore che nasconde senza spegnere lascia
credere che sia chiuso.

La chiave SHALL uscire UNA volta sola, e l'elenco NON SHALL riproporla.

Il proprietario dell'installazione NON SHALL essere cancellabile, e chi ha ancora
un dispositivo VIVO NON SHALL essere cancellato.

Un membro SHALL dichiarare quando si è fatto vivo l'ultima volta, e un dispositivo
REVOCATO SHALL azzerare quella presenza.

#### Scenario: la coda delle richieste è piena
- **GIVEN** molti indirizzi che hanno già chiesto
- **THEN** una richiesta nuova SHALL comunque entrare, sfrattando la più vecchia

#### Scenario: un segreto sbagliato
- **GIVEN** un ritiro con il segreto errato
- **THEN** la risposta SHALL essere identica a quella di un identificativo inesistente

### Requirement: LOOPBACK-01 — La sonda del ciclo interno non è un cercatore di porte

La porta SHALL essere estratta dalle varie forme del ciclo interno, forma
esplicita compresa, e la porta IMPLICITA SHALL contare: una scheda su un indirizzo
locale senza porta è la porta predefinita del suo schema.

**Tutto ciò che NON è il ciclo interno SHALL valere NIENTE**: questa rotta non è
un cercatore di porte, e non deve poter diventarlo.

Il controllo di ascolto SHALL essere VERO mentre un server è su e FALSO appena si
spegne. Un server in ascolto SOLO sulla forma estesa dell'indirizzo locale NON
SHALL essere dato per morto: sono due indirizzi dello stesso posto.

Una porta LIBERA NON SHALL far aspettare l'intera scadenza: una diagnosi che
impiega quanto un guasto non è una diagnosi.

#### Scenario: un indirizzo che non è locale
- **GIVEN** un host esterno
- **THEN** NON SHALL essere estratta nessuna porta

#### Scenario: un server sulla sola forma estesa dell'indirizzo locale
- **GIVEN** un ascolto su quella forma
- **THEN** SHALL risultare vivo

### Requirement: LANGATE-01 — Il cancello d'origine si prova sul server VERO, o non si prova affatto

Togliere la barriera di rete locale NON produce nessun rosso nel resto della
suite: gira tutta su un'origine coerente con l'host, e nessuna prova asseriva un
rifiuto del cancello. Un cancello che nessuno vede mordere non è un cancello.

Una MUTAZIONE da un'origine ESTRANEA SHALL essere rifiutata; una dalla stessa
origine SHALL passare.

Una LETTURA senza credenziali e senza origine SHALL passare: nessun rifiuto è
sopravvissuto su quel ramo, e va dichiarato invece che scoperto.

Una MUTAZIONE senza l'intestazione di origine SHALL passare: chi non la manda non
è un browser.

Il patto della condivisione fra origini SHALL reggere: una lettura da un'altra
origine NON SHALL ricevere il permesso di leggerne la risposta.

Un aggiornamento a socket da un'origine estranea SHALL essere rifiutato.

#### Scenario: una mutazione da un'origine estranea
- **GIVEN** una richiesta con origine diversa
- **THEN** SHALL essere rifiutata

#### Scenario: una lettura da un'altra origine
- **GIVEN** una richiesta di sola lettura cross-origine
- **THEN** NON SHALL ricevere il permesso di leggerne la risposta

### Requirement: DEVICEUI-01 — Una revoca che non è passata non somiglia a una revoca riuscita

È la superficie di sicurezza: esiste perché «authorization is per device and can
be revoked at any time» sia vero anche per chi non usa `curl`. Revoca e
rinomina non leggevano mai `r.ok`, e il rifiuto scritto nella stessa banda del
caricamento veniva cancellato entro un secondo dal giro di ricarica che segue
ogni gesto.

Un gesto rifiutato SHALL lasciare il blocco d'errore del pannello, con il suo
«Riprova», e quel blocco SHALL sopravvivere alla ricarica che il gesto stesso
scatena.

Una rinomina rifiutata NON SHALL chiudere il campo: il nome digitato resta.

#### Scenario: la revoca viene rifiutata
- **GIVEN** un dispositivo in elenco e la rotta che risponde con un rifiuto
- **WHEN** si conferma il cestino
- **THEN** SHALL comparire il blocco d'errore con «Riprova»
- **AND** SHALL essere ancora lì dopo la ricarica dell'elenco

### Requirement: LAN-OPEN-01 - The origin axis is decided on the request's origin alone

For a gated path the server SHALL make exactly one decision on the ORIGIN axis, on
the request's origin, independent of the identity axis (`AUTH-01`): passing one
never substitutes for the other, and the origin check SHALL NOT demand a token,
a pairing credential or a peer-address property.

The server SHALL allow the request on this axis when any of the following holds,
evaluated in order: the `TOPICS_AUTH_OFF` kill-switch is set; the request is neither
a mutating method nor a WebSocket upgrade; the request carries no `Origin` header;
the request's `Origin` is same-site with its `Host`; or the request's `Origin`
appears in the operator-configured allowed-origins list. Otherwise the server
SHALL respond `403` with reason `cross-site origin blocked`.

Same-site SHALL be decided on the canonicalized hostname, ignoring scheme, with
`localhost`, `127.0.0.0/8`, `::1` and any `*.localhost` name collapsed into a single
local equivalence class. The allowed-origins list SHALL be read from configuration
on every evaluation, without caching.

#### Scenario: A hostile website cannot forge a mutating request
- **GIVEN** a page served from an origin whose hostname differs from the server's `Host`
- **WHEN** it issues a mutating request or a WebSocket upgrade to the server
- **THEN** the server SHALL respond `403` with reason `cross-site origin blocked`

#### Scenario: An opaque origin is not same-site
- **GIVEN** a document that sends the literal `Origin: null`
- **WHEN** it issues a mutating request
- **THEN** the server SHALL respond `403`

#### Scenario: A non-browser client without an Origin header is served on this axis
- **GIVEN** a client that sends no `Origin` header (the CLI, an MCP tool, an HTTP hook)
- **WHEN** it issues a mutating request
- **THEN** the origin check SHALL NOT refuse it

#### Scenario: The desktop shell and the dev proxy are same-site
- **GIVEN** the Tauri shell (`Origin: tauri://localhost`, `Host: 127.0.0.1:13333`) or the Vite dev proxy
- **WHEN** either issues a mutating request
- **THEN** both sides SHALL canonicalize to the local equivalence class and pass

#### Scenario: Cross-origin reads stay unreadable
- **GIVEN** a page on a foreign origin issues a non-mutating `GET` to a gated path
- **WHEN** the server responds
- **THEN** the response SHALL NOT carry an `Access-Control-Allow-Origin` header for that origin

### Requirement: AUTH-01 - Every request from another machine carries an identity

The server SHALL require an identity for every gated path - the API, WebSocket
upgrades, and the file-serving roots - when the request does not come from the
machine the server runs on. Requests from that machine SHALL be trusted by
transport, so the owner can never be locked out.

The identity decision SHALL be made for **every** method, including reads. The
server SHALL NOT exempt non-mutating requests from it: the absence of a
cross-origin read permission stops a web page, but it does not stop a command-line
client on the network.

The identity axis and the origin axis SHALL both be satisfied. A request carrying
a valid session but driven from a foreign origin SHALL still be refused, because a
valid session driven by a page the owner did not open is precisely the attack the
origin check exists for.

A refusal for identity SHALL be distinguishable from a refusal for origin, so the
client can offer the authorization flow instead of failing silently.

#### Scenario: An unknown device is refused, on reads too
- **GIVEN** a device on the network that has never been authorized
- **WHEN** it requests any gated path, including a read
- **THEN** the server SHALL refuse it
- **AND** the refusal SHALL identify itself as an identity problem

#### Scenario: The machine running Topics is always trusted
- **GIVEN** a request originating from the machine the server runs on
- **WHEN** it reaches any gated path
- **THEN** the server SHALL serve it without any credential

#### Scenario: A valid session does not defeat the origin check
- **GIVEN** an authorized device
- **WHEN** a page from a foreign origin drives it into a mutating request
- **THEN** the server SHALL refuse the request

#### Scenario: The session travels without the client arranging it
- **GIVEN** an authorized device
- **WHEN** it issues any request, opens the WebSocket, or loads a file from a gated root
- **THEN** the session SHALL accompany the request without per-call-site handling

### Requirement: AUTH-02 - A new device is authorized by the trusted machine, not by guessing

To gain access, a new device SHALL display a short verification code, and the
machine that already holds access SHALL display the same request and approve or
refuse it. The new device SHALL NOT be asked to enter a secret.

The verification code SHALL avoid characters that a person can confuse when
comparing two screens. A pending request SHALL expire, and an expired request
SHALL NOT be approvable.

The request for approval SHALL reach the trusted machine wherever the user is
looking, not only inside a settings surface.

#### Scenario: The two screens show the same code
- **GIVEN** a new device asks for access
- **WHEN** the trusted machine displays the request
- **THEN** the code shown on both SHALL be identical

#### Scenario: Approval grants access to that device only
- **GIVEN** a pending request that the owner approves
- **WHEN** the new device continues
- **THEN** it SHALL gain access
- **AND** no other device SHALL gain access from that approval

#### Scenario: A refusal is told, not left hanging
- **GIVEN** a pending request that the owner refuses
- **WHEN** the new device polls
- **THEN** it SHALL be told it was refused
- **AND** SHALL be able to ask again

#### Scenario: An expired request cannot be approved
- **GIVEN** a request older than its expiry
- **WHEN** approval is attempted
- **THEN** the server SHALL refuse it

### Requirement: AUTH-03 - Access is revocable, and revocation takes effect at once

The system SHALL let the owner revoke an authorized device. A revoked device SHALL
lose access on its next request, without waiting for anything to expire, and its
refusal SHALL say it was revoked rather than that it was never known. The record of
a revoked device SHALL be retained rather than erased.

#### Scenario: Revocation is immediate
- **GIVEN** an authorized device
- **WHEN** the owner revokes it
- **THEN** its next request SHALL be refused

#### Scenario: A revoked device is told why
- **GIVEN** a revoked device
- **WHEN** it is refused
- **THEN** the refusal SHALL distinguish revocation from never having been authorized

#### Scenario: Revoking one device does not affect the others
- **GIVEN** two authorized devices
- **WHEN** one is revoked
- **THEN** the other SHALL keep working

### Requirement: RELAY-02 - Idle connections cost nothing

The relay SHALL hold connections in a hibernatable form, so that a connection
with no traffic incurs no duration cost.

This is a requirement and not an optimization: for the same workload, holding
the socket awake instead of hibernating it costs roughly **forty times** more.
The economics of the whole feature depend on this single choice, so it SHALL be
verified rather than assumed.

Pixel-level co-browsing SHALL NOT travel through the relay's stateful objects.
It SHALL remain peer-to-peer.

#### Scenario: An idle session is not billed for duration
- **GIVEN** a registered installation with no traffic
- **WHEN** the billing period is measured
- **THEN** no duration SHALL accrue for that connection

#### Scenario: Screen streams do not enter the relay
- **GIVEN** a co-browsing session between two participants
- **WHEN** its transport is inspected
- **THEN** the pixel stream SHALL NOT pass through the relay's stateful objects

### Requirement: RELAY-04 - Reaching a thing is not the same as being allowed to see it

The relay SHALL establish reachability only. Every existing rule about identity
and permission SHALL continue to be enforced by the installation itself: who the
requester is, what has been granted to them, and that a guest may only read.

The relay SHALL NOT introduce a second system that decides who someone is. Two
authorities on identity must be kept in agreement forever, and the one that
disagrees silently is the one nobody is looking at.

#### Scenario: Arriving through the relay grants nothing by itself
- **GIVEN** a request that reaches an installation through the relay
- **WHEN** it asks for something that was not shared with it
- **THEN** it SHALL be refused exactly as it would be on the local network

#### Scenario: A guest still cannot write
- **GIVEN** a guest reaching a shared resource through the relay
- **WHEN** it attempts a write
- **THEN** it SHALL be refused

### Requirement: RELAY-05 - When the machine is off, the interface says so

While an installation is not connected, anything shared from it SHALL be
presented as **temporarily unreachable**, naming the reason, rather than as
empty or broken.

Continuing a session elsewhere when the machine goes offline is explicitly not
part of this: it would move the work off the owner's machine, which is the one
property the product is built on. Should it ever be offered, it SHALL be an
explicit, separately chosen service - never a default, and never a silent
fallback.

#### Scenario: A guest opening a link to a sleeping machine
- **GIVEN** a shared link whose installation is offline
- **WHEN** a guest opens it
- **THEN** the interface SHALL say the machine is not reachable right now
- **AND** it SHALL NOT present an empty result as if nothing had been shared

### Requirement: ORG-01 - A request resolves to a bounded set of principals

The system SHALL resolve a remote request's identity into a set of **principals**
of depth at most two: the device, the person it belongs to, and the non-revoked
organizations that person is a non-revoked, non-locally-blocked member of.

Nested organizations SHALL NOT be admitted. The bounded depth is the **condition
of validity** for resolving at read time rather than materializing, not a default
that may later be relaxed: a fixed-length path is a join, an unbounded one is a
graph walk, and the argument for this design does not survive the change. A test
SHALL fail if a parent column appears on the organization table.

Every revocation column SHALL be read on every resolution. A revocation column
that exists and is never read is worse than none: it makes a revocation look
performed.

#### Scenario: Two devices of one person share what that person was granted
- **GIVEN** a person with two paired devices and a grant to that person
- **WHEN** either device requests the resource
- **THEN** the server SHALL serve it

#### Scenario: Removing someone from an organization withdraws access at once
- **GIVEN** a resource granted to an organization and a member with a device
- **WHEN** the membership is revoked
- **THEN** the next request from that device SHALL be refused
- **AND** no reconciliation pass SHALL be required for this to hold

#### Scenario: Nesting is refused by construction
- **GIVEN** the organization table
- **WHEN** a migration introduces a parent column on it
- **THEN** a test SHALL fail

### Requirement: ORG-02 - Ownership of the installation is local, and never conferred by an organization

The system SHALL derive whether a device is confined **only** from: the presence
of a person, that person not being revoked, and that person belonging to the
installation's local owner set. Membership of an organization SHALL NOT confer
ownership of the machine.

The reason is that organization membership will be a replica whose authority is
remote - it is the licence and the billing relationship - while the machine, its
filesystem, its terminals and its subscription are not. Were ownership to depend
on it, a declined payment or a row removed in a panel would demote the owner to a
guest **on their own machine**, and the failure would arrive through a channel
the owner does not control.

The local owner set SHALL NOT be writable by any synchronization process, and
SHALL carry no remote-identity column.

A device with no person SHALL be treated as confined. Every branch SHALL fail
towards fewer powers: an unrecognized subject counts as a guest, never as an
owner.

#### Scenario: A teammate is a guest on someone else's machine
- **GIVEN** two people in the same organization, one of whom owns the installation
- **WHEN** the other opens that installation from their own device
- **THEN** they SHALL be confined to what has been shared with them

#### Scenario: Losing the organization does not lose the machine
- **GIVEN** the owner's person record, and their organization membership removed
- **WHEN** they use their own installation
- **THEN** they SHALL still be its owner

#### Scenario: Synchronization cannot grant ownership
- **GIVEN** a synchronization process with write access to the replicated tables
- **WHEN** it runs
- **THEN** it SHALL NOT be able to alter who owns the installation

### Requirement: ORG-03 - One door for every question asked of the grant table

Every read and write of the grant relation SHALL pass through a single module. A
test SHALL fail if the relation or its subject column is named anywhere else.

This is a requirement and not a convention because the failure it prevents is
silent in the safe direction: a reader left behind, still filtering for the old
subject kind, returns **less** rather than more. It fails closed, which means
nothing breaks loudly and the gap can persist unnoticed.

Deciding whether a principal may read a resource SHALL be one indexed lookup, and
a denial SHALL take precedence over any permission.

The system SHALL be able to answer, for a resource, both **who was granted it**
and the **effective** set that expands to, and SHALL be able to enumerate *all*
the reasons a principal sees something rather than the first one found.

#### Scenario: A denial outranks a permission
- **GIVEN** a principal granted a resource through one path and denied it through another
- **WHEN** access is decided
- **THEN** it SHALL be refused

#### Scenario: The interface can explain an access
- **GIVEN** a principal that can see a resource through more than one path
- **WHEN** the reasons are requested
- **THEN** all of them SHALL be returned

### Requirement: ORG-04 - A person can be granted something before they have any device

The system SHALL allow granting a resource to a person who has not yet paired any
device, and that grant SHALL take effect on the first device they pair **without
any grant row being written** at that moment.

Today the ordering is reversed: a recipient who has not paired is not
representable at all, so inviting someone means waiting for their device to
appear and only then sharing. That is not the order in which anyone would
describe the act.

Reassigning a device to a different person SHALL be possible from the interface,
and SHALL NOT modify any existing grant.

#### Scenario: Sharing precedes pairing
- **GIVEN** a person with no devices, granted a resource
- **WHEN** they pair their first device
- **THEN** they SHALL see the resource
- **AND** no grant row SHALL have been written at pairing time

#### Scenario: A device paired to the wrong person can be moved
- **GIVEN** a device attributed to the wrong person
- **WHEN** it is reassigned
- **THEN** existing grants SHALL be untouched

### Requirement: ORG-05 - One module translates a credential into an identity

The system SHALL resolve a credential into an identity in a single module, used
by the HTTP gate, the WebSocket upgrade, and the endpoint that reports the
session. Three translations that must agree and are written separately will
eventually disagree, and the one that disagrees silently is the WebSocket path,
whose result is never seen by the client.

A connection SHALL re-resolve its principals when the underlying membership
changes, rather than carrying the set it was stamped with for its lifetime. All
of a device's connections SHALL be closed when that device is revoked or
reassigned.

#### Scenario: A live connection notices a membership change
- **GIVEN** an open connection whose principals were resolved at connect time
- **WHEN** the membership behind them changes
- **THEN** subsequent delivery SHALL respect the new set

#### Scenario: Revocation ends the connections
- **GIVEN** a device with open connections
- **WHEN** it is revoked
- **THEN** its connections SHALL be closed

### Requirement: ORG-08 - The account is never a gate

An account SHALL NOT be required to install, to open the application for the
first time, to use it locally, or to reach it from the same network. Those paths
SHALL keep working with no account, no network, and no third party aware that
the installation exists.

An account SHALL be required only for what genuinely needs an authority outside
the machine: being found from a **different** network, keeping people and
organizations consistent **across** installations, and licensing.

The distinction is the product, not a preference. A local-first tool that asks
who you are before it will run has already conceded the thing it is selling -
and the concession is invisible in a feature list, which is why it must be a
requirement rather than a habit.

An account SHALL therefore be addable to an installation that already holds
data, and adding one SHALL NOT create a second identity alongside the local one:
the existing local person SHALL acquire the remote identity. An installation
that has been used for a year before signing in is the normal case, not an edge
one.

Signing in on a second installation SHALL reconcile to the same person rather
than producing two. Two people who are one person split what has been shared
with them, and the split is silent.

Loss of contact with the account service SHALL degrade only the things that need
it. It SHALL NOT reduce local capability, and SHALL NOT be presented as an error
state on a machine that is working.

#### Scenario: A fresh installation, never signed in
- **GIVEN** a machine that has never had an account
- **WHEN** the application is installed and opened
- **THEN** it SHALL be fully usable locally
- **AND** it SHALL NOT ask who the user is

#### Scenario: Authorizing a phone on the same network
- **GIVEN** an installation with no account
- **WHEN** a phone on the same network asks for access
- **THEN** the existing device authorization SHALL be sufficient

#### Scenario: Signing in after a year of use
- **GIVEN** an installation with an established local person and their history
- **WHEN** an account is connected for the first time
- **THEN** the existing person SHALL acquire the remote identity
- **AND** no second person SHALL appear

#### Scenario: The account service is unreachable
- **GIVEN** a signed-in installation that cannot reach the account service
- **WHEN** the owner works locally
- **THEN** every local capability SHALL remain
- **AND** the interface SHALL NOT present the machine as broken
