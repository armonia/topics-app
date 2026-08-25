# sharing-guests Specification

## Purpose

What a GUEST can reach, read, change, and be told about — written from
`tests/e2e/guest-confinement.spec.ts`, which is the only place the confinement is
observable.

A guest is a device whose role is `guest` (`server/lib/identity.ts`), reached
through grants held by any of its principals: the device itself, its person, its
organizations. The confinement is decided at the single authorization gate
(`server.ts`, the identity axis) using the allowlists in `server/lib/grants.ts`,
never inside the individual routers.

**Everything below is stated as seen from the DEDICATED TUNNEL LISTENER**
(`TOPICS_TUNNEL_PORT`, `server/lib/tunnel.ts`), not from loopback. This is not a
test convenience: the migration-080 anti-lockout rule makes every loopback
request an owner without asking for a credential, so a guest cookie presented on
the main port resolves to the OWNER. A requirement written against that port
would assert the opposite of what it means. The tunnel listener is the real
boundary and the only surface on which "a guest is confined" has a truth value.

Reachability from another network is a separate capability: see `relay`.

## Requirements

### Requirement: GUEST-01 — A guest sees the resource shared with it, and no other

> Written from the test. It reuses the reasoning of `SHARE-02` in the
> `task-sharing-guests` proposal, which shipped as described there.

A guest SHALL NOT be able to reach an endpoint that answers with a **collection**
of resources. The gate sees the path and not the body, so a collection cannot be
filtered there, and filtering it inside a router leaves every other router open.
`/api/topics` is therefore refused outright rather than trimmed.

A guest SHALL discover what it holds from an endpoint built out of the grants
themselves (`/api/auth/shared`), which by construction can only answer with what
was granted. That inventory SHALL list a granted resource and SHALL NOT list one
that was never granted.

The single-resource gate is a SEPARATE check from the inventory, and both SHALL
hold: a granted topic SHALL be readable by id, and a topic that was not granted
SHALL NOT be — either refused or reported as absent.

#### Scenario: The list of chats is refused, not filtered
- **GIVEN** a paired guest device presenting its session cookie to the tunnel listener
- **WHEN** it requests `GET /api/topics`
- **THEN** the server SHALL answer 403

#### Scenario: The inventory is empty before anything is shared
- **GIVEN** a guest with no grants
- **WHEN** it requests `GET /api/auth/shared`
- **THEN** the server SHALL answer 200
- **AND** the body SHALL NOT mention any topic id

#### Scenario: The inventory names the granted topic and nothing else
- **GIVEN** the owner has granted the guest's device a `read` on one topic and not on a second
- **WHEN** the guest requests `GET /api/auth/shared`
- **THEN** the granted topic's id SHALL appear in the body
- **AND** the id of the topic that was not granted SHALL NOT appear

#### Scenario: The granted topic can be read by id
- **GIVEN** the same guest and the granted topic
- **WHEN** it requests `GET /api/topics/:id/messages` for that topic
- **THEN** the server SHALL answer 200

#### Scenario: A topic that was not granted stays closed
- **GIVEN** the same guest and the topic that was not granted
- **WHEN** it requests `GET /api/topics/:id/messages` for that topic
- **THEN** the server SHALL refuse it with 403, or report it absent with 404

### Requirement: GUEST-02 — A guest reads, including on what was shared with it

> Written from the test. `SHARE-06` in the `task-sharing-guests` proposal also
> requires the refusal to identify the LEVEL rather than the path or the entity;
> the shipped gate does emit `code: "guest_read_only"`, but the test pins only
> the status, so this requirement claims only the status.

The method is a third axis, independent of the path allowlist and of the
per-entity check. Where the granted level conveys reading only, the gate SHALL
refuse any request that is not `GET`, `HEAD` or `OPTIONS`, **including on the very
resource that was shared** — otherwise "shared read-only" would mean "may delete
it". The single exception is ending one's own session (`POST /api/auth/logout`),
which is the only way for a guest to leave without depending on somebody
revoking them.

A refused write SHALL leave no partial effect: the resource SHALL be unchanged
when read back from the owner's port.

The gate looks at the method, not at whether the resource already exists, so
creating a new resource SHALL be refused by the same rule.

#### Scenario: The granted topic is readable
- **GIVEN** a guest holding a `read` grant on a topic
- **WHEN** it requests `GET /api/topics/:id/messages`
- **THEN** the server SHALL answer 200

#### Scenario: A write on the granted topic is refused
- **GIVEN** the same guest and the same topic
- **WHEN** it issues `PATCH /api/topics/:id` or `DELETE /api/topics/:id`
- **THEN** the server SHALL answer 403 for each

#### Scenario: The refusal leaves nothing half-written
- **GIVEN** the refused `PATCH` and `DELETE` above
- **WHEN** the owner lists topics from the main port
- **THEN** the topic SHALL still exist
- **AND** its name SHALL be the one it had before

#### Scenario: Creating something new is refused too
- **GIVEN** the same guest
- **WHEN** it issues `POST /api/topics`
- **THEN** the server SHALL answer 403

### Requirement: GUEST-03 — From outside, no credential means no access — and the daemon surface is not there at all

Arriving on the tunnel listener SHALL NOT confer ownership, even though the
peer address the server sees is `127.0.0.1`. A request with no session cookie
SHALL be answered 401, and one carrying a session token that matches no device
SHALL be refused — 401 or 403.

The daemon control surface (`/__daemon/*`), which is the strongest thing this
server exposes, SHALL NOT be served on that listener. The requirement is that it
does not act, not which of the refusals it uses.

#### Scenario: No cookie, no entry
- **GIVEN** the tunnel listener
- **WHEN** `GET /api/topics` arrives with no session cookie
- **THEN** the server SHALL answer 401

#### Scenario: A session token nobody issued
- **GIVEN** the tunnel listener
- **WHEN** `GET /api/topics` arrives with a session cookie holding an unknown token
- **THEN** the server SHALL answer 401 or 403

#### Scenario: The daemon surface does not face this port
- **GIVEN** the tunnel listener
- **WHEN** `POST /__daemon/restart-when-idle` arrives on it
- **THEN** the server SHALL answer 401, 403 or 404
- **AND** it SHALL NOT perform the restart

### Requirement: GUEST-04 — The socket does not deliver frames about what was not shared

> Written from the test. It is the observable half of `SHARE-03` in the
> `task-sharing-guests` proposal, which shipped as described there.

A guest's WebSocket SHALL be allowed to open — closing it would turn a shared
resource into a photograph — and what travels on it SHALL be filtered. An id
belonging to a resource the guest holds no grant on SHALL NOT appear in ANY frame
delivered to that guest.

The claim SHALL be made against a positive control on the same event: an owner
socket on loopback SHALL receive the frame carrying that id. Without it, the
guest-side silence is indistinguishable from a broadcast that never fired, which
is the usual way a confinement proof lies.

#### Scenario: Both sockets complete the handshake
- **GIVEN** an owner socket opened on loopback and a guest socket opened on the tunnel listener with the guest's cookie
- **WHEN** each socket is inspected after opening
- **THEN** each SHALL have received a `welcome` frame

#### Scenario: The owner sees the frame the guest must not see
- **GIVEN** a topic the guest holds no grant on
- **WHEN** the owner renames it
- **THEN** a frame carrying that topic's id SHALL reach the owner's socket

#### Scenario: The guest's socket never carries that id
- **GIVEN** the same event, already observed on the owner's socket
- **WHEN** the frames delivered to the guest's socket are read
- **THEN** none of them SHALL contain the id of the topic that was not granted

### Requirement: GUEST-05 — A guest cannot watch, or hijack, somebody else's pairing

The fan-out that carries `auth:pair-requested` SHALL be subject to the same guest
filter as the others. A guest SHALL NOT receive that frame: neither the pairing
reference nor the frame type SHALL appear on its socket. A single unfiltered
fan-out is enough to leak the reference of a pairing in progress, and the leak is
a privilege escalation and not an information disclosure — the reference is half
of what it takes to become the device that was just approved.

The other half SHALL remain out of reach: `/api/auth/pair/status` is exempt from
the identity axis (a device being paired does not have one yet), so it SHALL
hand out the session token only to the holder of the per-request `claim` secret
returned to whoever made the request. Presenting the reference alone SHALL NOT
produce a session cookie, even after the owner has approved that pairing.

#### Scenario: The pairing frame does not reach a guest
- **GIVEN** a guest with a live socket on the tunnel listener
- **WHEN** another device requests to pair
- **THEN** the pairing reference SHALL NOT appear in any frame delivered to the guest
- **AND** neither SHALL the `auth:pair-requested` frame type

#### Scenario: Knowing the reference is not enough to collect the token
- **GIVEN** an approved pairing request whose reference a guest holds
- **WHEN** the guest calls `GET /api/auth/pair/status?requestId=…` without the `claim`
- **THEN** the response SHALL NOT carry a session cookie

### Requirement: GUEST-06 — A grant made to the guest's PERSON confines exactly like one made to the device

Grants SHALL be evaluated against all of a device's principals, so a grant made
to the guest's PERSON SHALL have effect without any row being rewritten per
device. This is the path the interface actually takes: `/api/auth/subjects`
offers the person rather than the hardware whenever the device has one, which is
always for a guest, because "it belongs to somebody else" is the answer that
creates one.

The gate and the inventory SHALL agree on such a grant. They are two different
pieces of code answering the same question, and when only the gate honoured the
person the chat was openable by id and invisible in the list — "I shared it with
you" against "I see nothing".

The read-only axis SHALL NOT relax because the subject is a person.

#### Scenario: The address book offers the guest's person
- **GIVEN** a device paired as belonging to another person
- **WHEN** the owner reads `GET /api/auth/subjects`
- **THEN** a subject of type `person` named after that guest SHALL be listed

#### Scenario: The inventory is empty before the grant
- **GIVEN** that guest, with nothing shared
- **WHEN** it requests `GET /api/auth/shared`
- **THEN** the server SHALL answer 200
- **AND** the body SHALL NOT mention the topic about to be shared

#### Scenario: The gate honours a grant made to the person
- **GIVEN** a `read` grant on a topic whose subject is that person
- **WHEN** the guest requests `GET /api/topics/:id/messages`
- **THEN** the server SHALL answer 200

#### Scenario: The inventory says the same thing as the gate
- **GIVEN** the same grant
- **WHEN** the guest requests `GET /api/auth/shared`
- **THEN** the granted topic's id SHALL appear
- **AND** the id of a topic nobody shared SHALL NOT

#### Scenario: It is still read-only
- **GIVEN** the same grant
- **WHEN** the guest issues `PATCH /api/topics/:id`
- **THEN** the server SHALL answer 403

### Requirement: GUEST-07 — Sharing a chat from its own panel confines exactly like sharing it by hand

The sharing gesture SHALL be offered on the chat itself, through the same
`share-control` primitive a task carries, reachable from the chat's settings —
the surface every layout can reach the same way, opened from the tab's context
menu. The panel it opens SHALL be portalled, so that it is not clipped by an
ancestor that hides overflow.

The panel SHALL offer the guest's PERSON as a recipient, and after the grant is
written the control SHALL state how many recipients the chat now has, in the
application's own language.

A grant written this way SHALL produce exactly the confinement of one written
against the API: visible in the guest's inventory, readable by id, closed on
what was not shared, and refused on a write.

#### Scenario: The chat offers the same sharing control as a task
- **GIVEN** the chat's settings dialog, opened from the tab's context menu
- **WHEN** the dialog is displayed
- **THEN** it SHALL contain the `share-control` element

#### Scenario: The panel opens outside the dialog and offers the guest's person
- **GIVEN** the sharing control
- **WHEN** it is activated
- **THEN** the `share-panel` SHALL become visible in the page rather than inside the dialog
- **AND** it SHALL offer the guest's person as a recipient

#### Scenario: The control states the resulting recipient count
- **GIVEN** the guest's person chosen as recipient
- **WHEN** the grant has been written
- **THEN** the control SHALL read "Condivisa con 1"

#### Scenario: The grant confines like any other
- **GIVEN** a chat shared this way and a second chat shared with nobody
- **WHEN** the guest reads `/api/auth/shared`, then each chat's messages, then attempts `PATCH` on the shared one
- **THEN** the inventory SHALL contain the shared chat and not the other
- **AND** the shared chat's messages SHALL be served 200
- **AND** the other chat SHALL answer 403 or 404
- **AND** the `PATCH` SHALL answer 403

### Requirement: GUEST-08 — Un link è una capacità su UNA cosa, e ogni modo di fallire dà lo stesso nulla

Un link di condivisione SHALL servire ESATTAMENTE la risorsa che nomina, e
niente altro. Se servisse più di quella, il fatto che i link circolino nelle
chat smetterebbe di essere accettabile.

Il link SHALL avere una SCADENZA e SHALL poter essere REVOCATO. La richiesta e
la risposta SHALL viaggiare dentro una busta sigillata con la chiave del link, e
la risposta SHALL richiudersi con la stessa chiave.

Tutti i modi di fallire — riferimento inesistente, scaduto, revocato, busta che
non si apre — SHALL dare LO STESSO nulla. Distinguerli racconterebbe a chi prova
quale dei quattro gli è capitato, e «questo riferimento esiste ma è scaduto» è
un'informazione che non si deve poter comprare tirando a indovinare.

Ogni apertura SHALL essere REGISTRATA. Non è statistica: è l'unico modo di
accorgersi che un link è finito dove non doveva.

#### Scenario: link scaduto e link inesistente
- **GIVEN** un riferimento scaduto e uno che non è mai esistito
- **THEN** le due risposte SHALL essere indistinguibili

#### Scenario: un link buono
- **GIVEN** un link valido per una risorsa
- **THEN** SHALL servire quella risorsa, e l'apertura SHALL essere registrata

### Requirement: SHARED-AUTO-01 — Il passaggio a sessione condivisa non OSCILLA

Una pane NATIVA SHALL voler passare alla sessione condivisa appena esiste un ALTRO
spettatore.

Una pane già CONDIVISA SHALL tornare nativa SOLO quando è l'ULTIMA a guardare.

La differenza fra i due conti è che mentre è nativa la pane non tiene un proprio
canale di flusso, mentre condivisa sì e quindi va SOTTRATTA: confondere i due conti
è come nasce l'oscillazione, cioè una pane che entra ed esce dalla condivisione a
ogni giro.

Attraverso la transizione di ingresso e di uscita NON SHALL esserci oscillazione.

Una pane condivisa che NON sta guardando NON SHALL sottrarsi dal conto.

#### Scenario: un secondo spettatore arriva e poi se ne va
- **GIVEN** una pane che entra in condivisione e poi resta sola
- **THEN** NON SHALL oscillare fra i due stati

#### Scenario: una pane condivisa che non guarda
- **GIVEN** una pane in condivisione senza canale attivo
- **THEN** NON SHALL sottrarsi dal conto

### Requirement: VIEWCNT-01 — Un delegato NATIVO non è uno spettatore

Un delegato nativo NON SHALL essere contato come spettatore, QUALUNQUE cosa
dichiari: è il braccio della pane, non qualcuno che guarda.

Un socket che NON dichiara niente SHALL valere spettatore — è un client vecchio,
o il socket dell'app — perché sbagliare per eccesso qui significa condividere una
sessione che poteva restare nativa, e sbagliare per difetto significa non
condividerla a qualcuno che sta guardando.

Chi è FUORI dallo schermo NON SHALL contare; chi è dentro sì. Un telefono che
guarda attraverso il canale video SHALL essere contato.

Il caso vero SHALL tornare uno: la macchina nativa più un telefono che guarda fa
UN altro dispositivo. Una macchina condivisa ma in SECONDO PIANO più un telefono
che guarda fa UNO.

Nessun socket SHALL fare zero.

#### Scenario: un delegato nativo che si dichiara spettatore
- **GIVEN** un socket delegato
- **THEN** NON SHALL essere contato

#### Scenario: la macchina in secondo piano e un telefono che guarda
- **GIVEN** i due socket
- **THEN** il conteggio SHALL essere uno

### Requirement: PRJSHARE-01 — Anche un PROGETTO si condivide, dal menu contestuale

Fino alla migrazione dedicata un progetto NON era una risorsa condivisibile — i
tipi ammessi erano due e basta — quindi non c'era niente da mostrare col menu
contestuale su di lui.

Il menu contestuale su un progetto SHALL offrire di condividerlo, e la voce SHALL
aprire il pannello di condivisione — lo STESSO di sempre, non una superficie
nuova per un tipo nuovo.

#### Scenario: il menu contestuale su un progetto
- **GIVEN** un progetto nella colonna
- **THEN** SHALL comparire la voce di condivisione

#### Scenario: la voce di condivisione
- **GIVEN** il gesto sulla voce
- **THEN** SHALL aprirsi il pannello di condivisione consueto
