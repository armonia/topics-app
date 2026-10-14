# Happy

## In tre righe
Happy è un harness open source che orchestra Claude, Codex e altri agenti da telefono, con le sessioni avviate nel
terminale e continuabili da mobile.
Punta a chi vuole pilotare gli agenti fuori dalla scrivania riusando gli abbonamenti che già paga.
Il suo punto più forte rispetto a Topics è il relay cifrato end-to-end con app mobile native: il telefono è cittadino di
prima classe, non un client LAN.

## Identità
Repository `slopus/happy`, monorepo pnpm con licenza MIT [README].
Circa 24.100 stelle e 2.000 fork alla rilevazione, progetto creato a luglio 2025 e quindi giovane ma con adozione mobile
reale: il README dichiara rating 4,9 su App Store da oltre 1.000 recensioni e 5,0 su Play da oltre 3.100 [README].
Ultimo commit sul clone il 2026-10-14 [non verificato: data da git log locale].
Cadenza release sostenuta per la CLI: stabile `cli-1.2.5` del 2026-09-22 e beta `cli-1.2.6-beta.1` del 2026-10-09
[release v1.2.5].
Coda issue oltre le 1.000 unità, segnale di uso intenso ma anche di debito visibile [non verificato: conteggio API].
Maturità disomogenea: il cuore sessioni e relay è solido e documentato, il self-hosting è stato a lungo dichiarato rotto
[issue #246].
Piattaforme: iOS e Android native, web client Expo, CLI Node su npm come `happy`, desktop in repository separato
(`happy-desktop`), agente runtime in `happy-agent`, server autosufficiente o cloud [README].

## Architettura
Linguaggi misurati sul clone: TypeScript e TSX 1.258 file per circa 239.000 righe, Swift 621 file per circa 139.000
righe, Kotlin 70 file per circa 8.000 righe [non verificato: conteggio locale].
Framework: Expo e React Native per le app, Fastify più Socket.IO per il server, nessuna traccia di Tauri o Electron in
questo repo [doc: docs/backend-architecture.md].
Niente Rust o Go nel percorso caldo, solo script di supporto.
Modello dei processi in tre attori: CLI interattiva, demone di macchina, sessioni figlie [doc: docs/cli-
architecture.md].
La CLI (`happy claude`, `happy codex`) avvolge gli harness dei vendor direttamente nel terminale e il demone mantiene le
sessioni in background; il control server IPC ascolta solo su `127.0.0.1` con porta effimera e route `/list`, `/spawn-
session`, `/stop-session`, `/stop` [codice: packages/happy-cli/src/daemon/controlServer.ts:221].
Stato locale in `~/.happy` con `settings.json`, `access.key`, `daemon.state.json` e log, più override via variabili
`HAPPY_SERVER_URL` e `HAPPY_WEBAPP_URL` [doc: docs/cli-architecture.md].
Storage server: Postgres via Prisma per i blob cifrati, Redis oggi usato per ping e adapter fra repliche, S3 compatibile
per gli asset con fallback su filesystem locale [doc: docs/deployment.md].
Parlata con l'agente: lancio delle CLI dei provider più backend ACP via SDK ufficiale, poi normalizzazione in un
protocollo interno a 9 eventi [codice: packages/happy-cli/src/agent/acp/AcpBackend.ts:1].
Schemi Zod condivisi fra CLI, app, server e agent nel pacchetto `@slopus/happy-wire`, pensato per far evolvere il wire
senza derive [doc: docs/happy-wire.md].
IPC realtime su un solo endpoint Socket.IO `/v1/updates` con tre scope di connessione: utente, sessione, macchina [doc:
docs/realtime-sync-and-rpc.md].

## Sessioni e task
Sessioni parallele sì: il demone tiene una mappa di sessioni figlie e le genera su richiesta locale o remota via RPC
[codice: packages/happy-cli/src/daemon/controlServer.ts:84].
Il server smista con stanze `user:<id>`, `user:<id>:session:<sid>`, `user:<id>:machine:<mid>` e stanze di registrazione
RPC `rpc:<userId>:<metodo>`, con attesa fino a 10 secondi se il demone è momentaneamente offline [doc: docs/realtime-
sync-and-rpc.md].
API REST con caricamento o creazione per tag, cursori per la lista e cancellazione esplicita [doc: docs/api.md].
Ogni oggetto ha numeri di sequenza monotonici per ordinamento e transazioni serializzabili con retry [doc: docs/backend-
architecture.md].
Niente worktree, niente code, niente kanban, niente tentativi automatici, niente review con merge o land: è una lista di
sessioni con metadati cifrati, non un orchestratore come la board di Topics.
Niente PR o CI dentro l'app; GitHub via OAuth serve solo per connessioni opzionali [doc: docs/backend-architecture.md].
Resume del thread esistente per Codex sì [codice: packages/happy-cli/src/codex/resumeExistingThread.ts:1].
Richieste di budget cap per sessione aperte come feature [issue #1893].
Bot integrati oltre alle sessioni normali, con residui di sessioni bot non cancellabili segnalati [issue #1876].

## Usabilità
Superfici: mobile nativo, web, CLI nel terminale, desktop altrove.
Il flusso principale è avvio nel terminale, ritrovo identico sul telefono via QR pairing, risposta a permessi e messaggi
da mobile, push a fine task [doc: docs/user-identity.md].
Diff e review con vista dedicata, sintassi calcolata fuori dal thread di rendering e reveal progressivo che non cancella
mai il già visibile [doc: docs/mobile-diff-highlighting.md].
Notifiche push via Expo con contenuto generato device-to-device, così il backend non lo vede [doc: PRIVACY.md].
Onboarding con QR e backup della chiave segreta [codice: packages/happy-app/sources/auth/authQRStart.ts:1].
Comandi slash speciali nella CLI e schermata terminale dentro l'app mobile [codice: packages/happy-
app/sources/app/(app)/terminal/index.tsx:1].
Voice opzionale con ElevenLabs, routing verso la sessione a fuoco e tool invocabili a voce [doc: docs/voice-
architecture.md].
Lati deboli visibili nelle issue recenti: tap su notifica che impila copie della stessa schermata su Android [issue
#1901], composer bloccato a metà schermo aprendo da notifica [issue #1900], titolo che si sovrappone all'id su iOS
[issue #1890], pulsante invio non visibile su mobile [issue #1775].

## Browser e anteprima
Niente browser integrato pilotabile dall'agente e niente co-browse fra dispositivi.
La richiesta di un ponte verso il browser è una issue aperta [issue #186], così come il pannello di anteprima live con
click-to-edit [issue #802].
Il supporto all'automazione Chrome risulta non scoperto dentro Happy [issue #321].
Esiste uno zoom forzato del client web segnalato come problema [issue #1309] e una richiesta di vista affiancata per due
sessioni su desktop [issue #1785].
L'app ha una schermata terminale remota, non una pagina web rispecchiata nel DOM come fa Topics.
Per Topics questa è una lacuna del concorrente, non un modello da copiare: il co-browse Mac e iPad resta un
differenziale nostro.

## Terminale, editor, file
La superficie RPC esposta dalle sessioni copre shell, lettura e scrittura file, ricerca ripgrep e diff difftastic [doc:
docs/cli-architecture.md].
Da mobile c'è connessione al terminale della macchina, ma con problemi di connessione segnalati sia da app sia da web
[issue #276].
Non esiste un editor completo dentro l'app: si vedono diff e output, si approvano permessi, si scrive in chat.
Il caricamento file segue il modello upload-first con riferimento e le immagini portano dimensioni e thumbhash per il
placeholder istantaneo [doc: docs/session-protocol.md].
Artefatti versionati via API con header e corpo cifrati [doc: docs/api.md].
Un KV store cifrato con mutazioni batch e versioni ottimistiche copre preferenze e piccoli stati [doc: docs/api.md].
La scansione sessioni della CLI rilegge interi JSONL ogni 3 secondi, con CPU alta su sessioni lunghe [issue #1841].

## Remoto e mobile
È il cuore del prodotto e la parte che Topics deve studiare meglio.
Accesso da telefono ovunque via relay, non solo LAN: il server (cloud all'indirizzo pubblico o autosufficiente in
Docker) inoltra blob che non può leggere [doc: docs/encryption.md].
Cifratura a due varianti: legacy NaCl secretbox con nonce da 24 byte e dataKey AES-256-GCM con nonce da 12 byte, tag da
16 byte e layout con byte di versione, con chiave dati avvolta via box effimero [codice: packages/happy-
cli/src/api/encryption.ts:88].
Autenticazione senza password: firma di una challenge con keypair NaCl, poi Bearer JWT verificato su ogni richiesta
[doc: docs/user-identity.md].
Multigiocatore nativo: si invita un collega nella sessione e si osserva e guida insieme lo stesso agente [README].
Chiavi di accesso cifrate per coppia sessione e macchina con controllo di versione ottimistico [doc: docs/api.md].
Riconnessione con re-fetch REST completo, recovery di connessione disabilitata di proposito per parità di comportamento
[doc: docs/multi-process.md].
Frizioni reali: switch cross-device lento e instabile [issue #1170], sync Android con riconnessioni fallite e permessi
in timeout [issue #1208], cambio locale-remoto che fallisce al primo avvio [issue #1136].

## Provider e protocolli
Claude Code, Codex, Gemini, Agy (CLI Antigravity) e OpenClaw hanno backend dedicati, più un backend ACP generico che
accetta qualunque agente compatibile [codice: packages/happy-cli/src/agent/acp/AcpBackend.ts:1].
Il README promette anche Grok fra i provider orchestrati [README].
Le credenziali sono quelle dell'host: se il login Claude scade, l'app dice di rilanciare il login sulla macchina host
con lo stesso utente e configurazione, quindi uso lecito senza furto di token [codice: packages/happy-
cli/src/claude/utils/providerAuth.ts:1].
Token vendor propri registrabili via API per OpenAI, Anthropic e Gemini, cifrati al riposo [doc: docs/api.md].
MCP sì: configurazione server MCP passata ai backend [codice: packages/happy-cli/src/agent/core/AgentBackend.ts:41],
binario `happy-mcp` e ponte stdio verso Codex [codice: packages/happy-cli/src/codex/codexAppServerClient.ts:1].
Ma con frizioni: iniezione MCP come namespace che rompe alcuni gateway solo-chat [issue #1746] e server MCP non
registrati in modalità remota [issue #934].
Il protocollo di sessione è volutamente distinto da ACP, con tabella di confronto che spiega perché ACP non basta:
payload cifrati, tool call visibili in UI, immagini con thumbhash, stream piatto [doc: docs/session-protocol.md].

## Performance
Nessun benchmark dichiarato.
Lavoro serio e documentato sulle liste chat: lista invertita con newest in offset 0, FlashList, prefetch e misurazioni
frame per frame nel simulatore, con limite onesto dichiarato sulle espansioni di gruppo [doc: docs/chat-list-
scrolling.md].
Sintassi mai sul thread di rendering, una sola job alla volta, coda da 64, budget LRU da 512 voci [doc: docs/mobile-
diff-highlighting.md].
Presence ad alta frequenza isolata in cache con scritture batchate [doc: docs/backend-architecture.md].
Lamentele nelle issue: apertura di sessioni lunghe lenta anche dopo FlashList [issue #1342], prefetch che carica
l'intera sessione in memoria [issue #1453], tab web che cresce senza limiti in heap, DOM e CPU [issue #1813], main
thread web saturato da JS sincrono mentre il mobile nativo è istantaneo [issue #1765], batch SDK che arriva a raffiche
con lag UI [issue #988], scroll jank su iPad nativo [issue #1643], poll di presence che dichiara il demone disconnesso
se lento [issue #1071].

## Affidabilità e qualità
311 file di test e spec nel clone [non verificato: conteggio locale].
CI con workflow per smoke test CLI, server, iOS, typecheck e release della CLI [non verificato: elenco workflow].
Metriche Prometheus con contatori HTTP e gauge WebSocket [doc: docs/backend-architecture.md].
Persistenza sessioni cifrata su Postgres e re-fetch completo a ogni riconnessione [doc: docs/multi-process.md].
Aggiornamenti mobile via OTA Expo e release native, con regola ferrea di rilascio solo da main pulito e pari a origin
dopo un incidente di rollback [non verificato: nota AGENTS.md].
Crash e rotture ricorrenti: flag nuovo di Claude rifiutato con ZodError [issue #1878], sessioni Codex che cadono con CLI
recenti per policy rimossa upstream [issue #1759], accumulo stdout ripgrep con RangeError [issue #1195], SIGTERM su
messaggi da mobile [issue #982], sessioni remote che cadono al primo messaggio [issue #718], variabile d'ambiente
ereditata dal demone che fa cadere tutto [issue #682].
Server ospitato degradato per circa 20 ore con timeout intermittenti [issue #1682].

## Sicurezza e privacy
Modello zero-knowledge onesto e documentato: contenuti, metadati di sessione, stati agente e demone, artefatti e KV sono
opachi al server, che cifra al riposo solo i token di servizio con chiave derivata da `HANDY_MASTER_SECRET` [doc:
docs/encryption.md].
Chiavi condivise fra i propri dispositivi solo in forma cifrata, niente backdoor dichiarate, codice aperto revisionabile
[doc: PRIVACY.md].
Metadati in chiaro limitati a id, timestamp, device e token push [doc: PRIVACY.md].
Sandbox per CLI presente ma con una falla grave: in modalità remota la sandbox non è applicata mentre i prompt di
permesso sono comunque saltati [issue #1894].
Configurazione di progetto caricata senza cancello di fiducia [issue #1688].
Server senza rate limiting e con body troppo permissivo [issue #599].
Retry che martella un endpoint con migliaia di richieste dopo un 400 permanente [issue #1689].
Porte: server in ascolto su `0.0.0.0` di default [codice: packages/happy-server/sources/app/api/api.ts:181], controllo
demone solo loopback.
Eccezione alla cifratura: la voice manda audio e contesto in chiaro a ElevenLabs con identificatore pseudonimo derivato
[doc: PRIVACY.md].

## Estendibilità
MCP come estensione principale, con bridge stdio e configurazione per backend [codice: packages/happy-
cli/src/agent/core/AgentBackend.ts:41].
Backend ACP generico per aggiungere agenti senza toccare il protocollo [codice: packages/happy-
cli/src/agent/acp/AcpBackend.ts:1].
Skill in `.agents/skills` e directory skill Codex, hook server per Claude, bot integrati, contract condivisi in `happy-
wire` per evolvere il wire senza derive [doc: docs/happy-wire.md].
Documenti interni con piani e specifiche sotto `docs/superpowers` [non verificato: elenco docs].
API di versione e token vocali, endpoint amici e feed per la dimensione sociale [doc: docs/api.md].
Chi vuole un server MCP trova la issue storica ancora aperta [issue #354].

## Da prendere per Topics
1.
Layout del blob cifrato con byte di versione e chiave dati avvolta, così il formato evolve senza rompere i client
vecchi, visto in [doc: docs/encryption.md].
Per Topics conta perché oggi il relay è LAN senza cifratura end-to-end.
2.
QR pairing con backup della chiave segreta e challenge firmata invece di password, visto in [codice: packages/happy-
app/sources/auth/authQRStart.ts:1].
Per Topics conta perché l'accesso da iPad e telefono resta il punto debole dell'onboarding.
3. Push con contenuto generato device-to-device via Expo, così il server non vede nulla, visto in [doc: PRIVACY.md].
Per Topics conta perché le notifiche di fine task mancano e il relay attuale vedrebbe tutto.
4. Protocollo di sessione piatto a 9 eventi con file upload-first e thumbhash, visto in [doc: docs/session-protocol.md].
Per Topics conta perché normalizzare Claude, Codex e Muse in un solo stream semplifica il client iPad.
5. Pacchetto di contract condivisi con Zod fra tutti i processi, visto in [doc: docs/happy-wire.md].
Per Topics conta perché oggi guscio, server e client possono divergere in silenzio.
6.
Control server del demone solo su loopback con RPC di spawn e lista, visto in [codice: packages/happy-
cli/src/daemon/controlServer.ts:84].
Per Topics conta perché il lancio agenti dalla board oggi non ha una superficie IPC così piccola e chiara.
7.
Documento di risoluzione del permission mode fra app e CLI con priorità esplicite, visto in [doc: docs/permission-
resolution.md].
Per Topics conta perché i modi di permesso dei tre provider sono già fonte di bug.
8.
Sintassi dei diff fuori dal thread UI con budget e fallback a un secondo, visto in [doc: docs/mobile-diff-
highlighting.md].
Per Topics conta perché il pannello file su iPad deve restare fluido su diff grandi.
9. Report d'uso per sessione e chiave aggregati sul server, visti in [doc: docs/backend-architecture.md].
Per Topics conta perché il costo per topic oggi non è misurato.
10.
Lista chat invertita con anchor sul messaggio nuovo e trappole mVCP documentate, vista in [doc: docs/chat-list-
scrolling.md].
Per Topics conta perché la chat del topic ha gli stessi bug di scroll con tastiera e storia lunga.

## Da evitare
1. Saltare i prompt di permesso quando la sandbox non è attiva in remoto, come in [issue #1894].
Rischio di esecuzione non autorizzata, il contrario di ciò che Topics deve garantire.
2. Caricare configurazioni di progetto senza cancello di fiducia, come in [issue #1688].
Un repo clonato non deve poter cambiare il comportamento dell'agente in silenzio.
3. Rileggere interi file di sessione a intervalli fissi per lo scanner, come in [issue #1841].
Su Topics significherebbe CPU costante con topic lunghi.
4. Far crescere tab e liste senza limiti con prefetch totale, come in [issue #1813] e [issue #1453].
Serve paginazione vera, non caricamento intero.
5. Iniettare MCP come namespace che rompe i gateway altrui, come in [issue #1746].
Le estensioni non devono cambiare la forma degli tool esistenti senza interruttore.
6. Ritentare per sempre su errori permanenti, come in [issue #1689]. Backoff con tetto e stop sul 400.
7. Dichiarare prontezza multi-replica con configurazione a una replica, come in [doc: docs/multi-process.md].
O si spedisce o non si documenta come fatto.

## Fonti
- README e tabella dei repository: https://github.com/slopus/happy
- Architettura backend: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/docs/backend-architecture.md
- Architettura CLI e demone: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/docs/cli-architecture.md
- Cifratura e formati: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/docs/encryption.md
- Protocollo di sessione: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/docs/session-protocol.md
- Contratti condivisi: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/docs/happy-wire.md
- Deployment: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/docs/deployment.md
- Multi-processo e RPC: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/docs/multi-process.md
- Sync realtime e RPC: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/docs/realtime-sync-and-rpc.md
- Catalogo API: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/docs/api.md
- Risoluzione permessi: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/docs/permission-resolution.md
- Identità utente: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/docs/user-identity.md
- Scroll chat: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/docs/chat-list-scrolling.md
- Diff mobile: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/docs/mobile-diff-highlighting.md
- Architettura voice: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/docs/voice-architecture.md
- Cifratura client: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/packages/happy-cli/src/api/encryption.ts#L88
- Control server demone: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/packages/happy-cli/src/daemon/controlServer.ts#L221
- Backend ACP: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/packages/happy-cli/src/agent/acp/AcpBackend.ts#L1
- Config MCP: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/packages/happy-cli/src/agent/core/AgentBackend.ts#L41
- Privacy: https://github.com/slopus/happy/blob/6e5a085e2f287cf55b68fea3597c5c8356d0418c/PRIVACY.md
