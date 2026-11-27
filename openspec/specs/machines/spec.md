## Purpose

Le macchine che partecipano a un'installazione: come si registrano, come si
rinominano, e cosa succede a ciò che le nominava quando spariscono.

## Requirements

### Requirement: MACHINE-01 — Registrarsi è IDEMPOTENTE, e cancellare non porta via ciò che la nominava

La registrazione della macchina locale SHALL essere IDEMPOTENTE: il primo giro
inserisce, i successivi AGGIORNANO. Un solo record per macchina.

Una macchina SHALL potersi RINOMINARE.

Cancellare una macchina ancora NOMINATA da un discorso SHALL essere un CONFLITTO
dichiarato; una volta sciolto il legame SHALL riuscire, e il riferimento SHALL
diventare ASSENTE — mai puntare a una macchina che non c'è.

Le macchine ferme da più di una soglia SHALL passare a NON DISPONIBILI, e questa
SHALL essere la macchina REMOTA vecchia, non quella LOCALE che sta rispondendo
adesso.

#### Scenario: una macchina ancora nominata
- **GIVEN** un discorso legato a quella macchina
- **THEN** la cancellazione SHALL essere un conflitto dichiarato

#### Scenario: la macchina locale
- **GIVEN** la spazzata delle macchine ferme
- **THEN** quella locale NON SHALL passare a non disponibile

### Requirement: CORES-01 — Una macchina non perde core perché una lettura è vuota

Il numero di core SHALL essere ALMENO uno, e SHALL essere quello VERO quando la
piattaforma sa dichiararlo.

**Una lettura VUOTA NON SHALL rimpicciolire la macchina.** È il difetto: un
ripiego che scatta su un'assenza di risposta trasforma una macchina da venti core
in una da uno, e ogni tetto che si dimensiona su quel numero si stringe insieme a
lui.

#### Scenario: una lettura vuota
- **GIVEN** la piattaforma non risponde
- **THEN** il numero NON SHALL scendere sotto quello reale già noto

#### Scenario: una piattaforma che dichiara i core
- **GIVEN** una risposta valida
- **THEN** SHALL essere quel numero

### Requirement: MACHINE-02 — Un nodo si accoppia come DISPOSITIVO del nodo, e il segreto non torna mai indietro

Questa macchina SHALL potersi accoppiare a una seconda macchina («il nodo»)
riusando l'appaiamento dei dispositivi che il nodo ha già: `POST
/api/auth/pair/request` verso l'indirizzo del nodo, il codice mostrato a chi
sta davanti al nodo, `GET /api/auth/pair/status?requestId&claim` fino
all'approvazione. NON SHALL esistere una seconda identità: il gettone che questa
macchina conserva è un gettone di dispositivo PROPRIETARIO emesso dal nodo.

Il gettone SHALL vivere in `<stateDir>/nodes/<machineId>.token` con permessi
`0600`, come il segreto del relay, e NON SHALL mai comparire nella riga
`machines` che il client riceve: la riga porta l'indirizzo, non la chiave.

Un appaiamento fallito SHALL dire QUALE dei due muri ha risposto: l'host non
ammesso (`host_not_allowed`) e il certificato non verificabile (`tls_untrusted`)
sono due guasti con due rimedi diversi, e «irraggiungibile» non è nessuno dei
due. Anche l'assenza di rete SHALL avere il suo nome (`unreachable`).

La riga `machines` SHALL portare l'indirizzo base del nodo (`base_url`), e
cancellare una macchina ancora NOMINATA da una card SHALL essere lo stesso
conflitto dichiarato di MACHINE-01, contato sui task oltre che sui discorsi.

MISURA: `bun test server/services/node-client.test.ts tests/integration/machines.test.ts`
verde: la stretta di mano legge il gettone dal `Set-Cookie`, il file del gettone
nasce a `0600`, `GET /api/machines` non espone nessun gettone, e i tre guasti
hanno tre nomi distinti.

#### Scenario: la stretta di mano riuscita
- **GIVEN** un nodo raggiungibile che approva la richiesta
- **WHEN** questa macchina attende l'esito con il proprio `claim`
- **THEN** il gettone SHALL essere letto dal `Set-Cookie` e scritto a `0600`
- **AND** la riga `machines` SHALL nascere con l'indirizzo del nodo

#### Scenario: il gettone non esce dal server
- **GIVEN** un nodo già accoppiato
- **WHEN** il client chiede l'elenco delle macchine
- **THEN** nessun campo della risposta SHALL contenere il gettone

#### Scenario: due muri, due nomi
- **GIVEN** un nodo che rifiuta l'host oppure presenta un certificato non verificabile
- **THEN** l'errore SHALL nominare quale dei due, mai un generico «irraggiungibile»

#### Scenario: una macchina ancora nominata da una card
- **GIVEN** un task il cui `machine_id` è quella macchina
- **THEN** la cancellazione SHALL essere un conflitto dichiarato

### Requirement: MACHINE-03 — Il gettone del proxy dei modelli si conia solo per un proprietario identificato

`POST /api/machines/:id/model-token` SHALL rifiutare con 403 (`owner_required`)
una richiesta senza identità risolta e una richiesta da ospite. Il loopback, che
il cancello globale materializza come proprietario senza dispositivo, SHALL
coniare.

MISURA: `bun test server/routes/machines.model-token.test.ts` verde.

#### Scenario: nessuna identità
- **GIVEN** `requestIdentity` restituisce null
- **THEN** la risposta SHALL essere 403

### Requirement: MACHINE-04 — Il PC e il server Hetzner stanno tra i dispositivi come li vede l'hub

Il livello Dispositivi SHALL elencare, sotto «questo computer», le macchine non locali
dell'hub (`GET /api/hub/machines`: il PC e il server Hetzner a consumo) con stato,
spesa sul tetto e pallino; un hub che non risponde SHALL non produrre righe, mai un
errore. Un comando della macchina («Spegni tutti») SHALL chiedere conferma con la
frase dell'hub e partire solo dal secondo tasto, verso un percorso `/api/...` del
solo hub (`/api/hub/<resto>`).

MISURA: `cd client && bun test src/lib/hubMachines.test.ts src/components/Sidebar/HubMachineRows.test.tsx` verde.

#### Scenario: le macchine non locali dell'hub
- **GIVEN** l'hub risponde con il Mac locale, il PC e il server Hetzner
- **THEN** il livello Dispositivi SHALL mostrare una riga per il PC e una per il server Hetzner, con stato, spesa sul tetto e pallino
- **AND** il Mac locale SHALL restare fuori, perché è già «questo computer»

#### Scenario: un hub che non risponde
- **GIVEN** un hub che non risponde
- **THEN** il livello Dispositivi SHALL non produrre righe e nessun errore

#### Scenario: «Spegni tutti» chiede prima
- **GIVEN** una macchina con il comando «Spegni tutti»
- **WHEN** l'utente preme il comando una prima volta
- **THEN** la riga SHALL mostrare la frase dell'hub con il tasto di conferma e Annulla, senza partire
- **WHEN** l'utente preme il tasto di conferma
- **THEN** il comando SHALL partire verso il percorso `/api/hub/<resto>`

#### Scenario: un percorso fuori dall'hub
- **GIVEN** un comando il cui percorso non è `/api/...` del solo hub
- **THEN** il comando SHALL non partire

### Requirement: HETZNER-LOC-1 — La location di un server Hetzner viene dalla risposta, con o senza datacenter

L'adattatore Hetzner SHALL leggere la location di un server da `location` (API attuale, sul server) e, in mancanza, da `datacenter.location` (API precedente). La location SHALL essere mostrata come città e paese («Helsinki, FI»). Il prezzo SHALL venire dal listino della location del server, non dal primo elenco di prezzi.

#### Scenario: l'API attuale senza datacenter
- **GIVEN** una risposta con `location` (hel1, Helsinki, FI) in cima al server e nessun `datacenter`
- **THEN** la location SHALL essere «Helsinki, FI» e il prezzo mensile quello del listino hel1

#### Scenario: l'API precedente
- **GIVEN** una risposta con `datacenter.location` (hel1, Helsinki, FI)
- **THEN** la location SHALL essere «Helsinki, FI» e il prezzo quello del listino hel1

### Requirement: MACHINE-05 — Ogni macchina ha uno stato di sicurezza e una storia delle ultime 24 ore, in un file che la tray legge

Topics SHALL scrivere in modo atomico `~/.topics/machines-health.json` (la cartella degli strumenti accanto alla tray, mai quella dei dati del server) con, per
ogni macchina della tabella `machines` che è questo computer o un nodo accoppiato:
l'esito di quattro sonde in SOLA LETTURA (`updates`, `disk`, `access`, `antivirus`,
ciascuna col suo stato e una frase di al massimo 60 caratteri), 288 campioni di CPU e
memoria a passo di 300 s, e le carte eseguite oggi ora per ora (24 interi). Lo stato
della macchina SHALL essere il peggiore dei check (`info` non conta, `unknown` non
sporca gli altri). Un comando che manca, non ha i permessi o supera i 5 s SHALL dare
`unknown` con la frase del perché, mai un errore che rompe il giro. Il giro SHALL
ripetersi ogni 5 minuti per i campioni e ogni 30 per le sonde; una macchina che non
risponde SHALL tenere l'ultimo esito con la sua ora.

MISURA: `bun test server/lib/machine-security.test.ts server/lib/machine-health.test.ts` verde.

#### Scenario: un aggiornamento di sicurezza offerto da più di 7 giorni
- **GIVEN** un Mac con un aggiornamento di sistema in attesa, offerto da 8 giorni
- **THEN** il check `updates` SHALL essere `warn`

#### Scenario: comando mancante
- **GIVEN** una macchina dove il comando di una sonda non esiste
- **THEN** il check SHALL essere `unknown` con la frase del perché e le altre sonde SHALL rispondere comunque

#### Scenario: il PC dorme
- **GIVEN** un nodo che non risponde al giro
- **THEN** la sua sicurezza SHALL restare l'ultimo esito con il suo `checked_at`, e i suoi campioni SHALL essere `null`

### Requirement: MACHINE-06 — Un solo modo di leggere i segreti, uguale sul Mac e sul server, con un elenco chiuso

I servizi SHALL leggere un segreto per nome attraverso un deposito con due
implementazioni dietro la stessa interfaccia: il Portachiavi su macOS, un file
cifrato con `age` su Linux, decifrato solo dopo che l'identità è stata sbloccata.
Il deposito SHALL rifiutare un nome fuori dall'elenco consentito (letto da
`<cartella di stato>/secrets/allowed-secret-names.json`; senza file l'elenco è
vuoto e rifiuta tutto), e un nome con un carattere di controllo qualunque cosa
dica l'elenco. Il valore di un segreto SHALL passare solo dallo stdin dei comandi,
mai dagli argomenti, dai log o dalla console; il percorso dell'identità `age` mai
dagli argomenti di `age`. Un file di identità leggibile dal gruppo o da altri
SHALL essere rifiutato. I percorsi di default fuori dal Mac SHALL essere generici e
configurabili, mai il percorso di una persona.

MISURA: `bun test server/lib/secret-store.test.ts` verde.

#### Scenario: nome fuori elenco
- **GIVEN** un elenco consentito che non contiene `X`
- **WHEN** si fa `pack` di `X` o lo si legge
- **THEN** `pack` SHALL saltarlo e la lettura SHALL rispondere null, senza chiamare `security` per quel nome

#### Scenario: andata e ritorno con age
- **GIVEN** un valore di prova e un'identità sbloccata
- **WHEN** si fa `pack` e poi `unpack` con il vero binario `age`
- **THEN** il valore SHALL tornare uguale e il file cifrato SHALL non contenerne traccia

#### Scenario: identità non sbloccata
- **GIVEN** un deposito age senza identità sbloccata
- **THEN** `unpack` SHALL rispondere vuoto e `pack` SHALL rifiutare
