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
