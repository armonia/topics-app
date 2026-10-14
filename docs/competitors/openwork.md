# OpenWork

## In tre righe

OpenWork è un'app desktop per macOS, Windows e Linux dove agenti AI lavorano sui file locali,
costruita sopra OpenCode e con qualsiasi modello. È l'alternativa libera a Claude Cowork e Codex:
file in locale di default, cloud solo se serve, condivisione di skill e server MCP in team. Il suo
punto più forte rispetto a Topics è il controllo di flotta: un control plane per pubblicare capacità
e policy su molte installazioni, più un gateway MCP che porta le stesse capacità dentro Claude Code,
Codex e Cursor.

## Identità

Repository `different-ai/openwork`, descritto come alternativa open source a Claude Cowork basata su opencode [README]. Stelle circa 24.100 e circa 2.400 fork al 14 ottobre 2026 [doc: https://github.com/different-ai/openwork]. Progetto nato a gennaio 2026, quindi giovane ma con trazione alta e sviluppo quotidiano: ultimo commit il 14 ottobre 2026 dedicato ai permessi agente nel desktop [release v0.18.58]. Le release sono quasi settimanali nella serie 0.18.x: v0.18.54 il 25 settembre, v0.18.55 e v0.18.56 il 3 ottobre, v0.18.57 il 7 ottobre, v0.18.58 il 13 ottobre [release v0.18.58]. La documentazione è tradotta in cinese semplificato e tradizionale e giapponese, segnale di ambizione internazionale [README]. Licenza divisa per cartelle, in stile GitLab: tutto fuori da `ee/` è MIT, tutto sotto `ee/` (il control plane per le organizzazioni) è sotto licenza EE source available, gratis fino a 5 utenti, gratis da valutare per 30 giorni e con conversione a MIT due anni dopo la pubblicazione [README]. Le versioni precedenti all'adozione della licenza restano sotto licenza originale [README]. Maturità: processo maturo con 45 workflow di CI ed evals strumentati, codice ancora in rapido cambiamento. Piattaforme: app desktop per macOS, Windows e Linux, più web UI self hosted servita dallo stesso server [README] [codice: apps/server/README.md:15].

## Architettura

Monorepo pnpm con Turbo: `apps/` contiene desktop, app, server e review, `packages/` le librerie
condivise, `ee/` il control plane per le organizzazioni [codice: package.json:1]. Misurato sul
clone: TypeScript circa 585.600 righe in 2.585 file, TSX circa 170.200 righe in 792 file, più circa
53.000 righe di moduli ESM in 267 file, con SQL, shell e poco altro, nessun sorgente Go e solo due
file Rust marginali. Il server è scritto per Bun con fallback a Node: il modulo di persistenza
importa sia `bun:sqlite` sia `node:sqlite` [codice: apps/server/src/runtime-db.ts:3]. La persistenza
usa SQLite via Drizzle, mentre le sessioni agente vivono nello SQLite condiviso di OpenCode, così
solo l'esecuzione in corso è legata al processo [codice: apps/server/src/engine-pool.ts:12]. Il
backend Den usa MySQL e Redis nei profili di sviluppo locale [codice: package.json:24]. Il guscio
desktop è Electron: processo main in `apps/desktop/electron/main.mjs` con vista browser nativa e
decine di moduli per updater, vault, menu e resilienza dei processi [codice:
apps/desktop/electron/browser-panel.mjs:7]. Un tempo il guscio era Tauri e la migrazione a Electron
nella 0.13.4 causò lamentele di lentezza [issue #1710]. Il renderer è una SPA React servita da Vite
[codice: apps/app/package.json:1]. Il dialogo con l'agente passa per un binario OpenCode v2 gestito
come sidecar: il server lo scarica da un URL pinnato e ne verifica l'hash sha512 prima di
installarlo [codice: apps/server/src/opencode-v2-binary.ts:33]. Le istanze sono lanciate come
processi figli con pool blue green: a cambio di configurazione nasce un motore di riserva e il
vecchio resta vivo solo finché finiscono le sessioni in corso [codice:
apps/server/src/engine-pool.ts:10]. Il lancio avviene con `spawn` del binario e supervisione del
ciclo di vita [codice: apps/server/src/managed-opencode.ts:187]. Il desktop dipende anche dall'SDK
ufficiale di OpenCode [codice: apps/desktop/package.json:42]. I plugin del motore si compilano con
Bun in una cartella dedicata [codice: apps/server/package.json:12]. Niente Rust o Go nel percorso
caldo: il codice caldo è TypeScript su Bun o Node con SQLite.

## Sessioni e task

Le sessioni si raggruppano in gruppi definiti dall'utente, con assegnazioni sessione gruppo
persistenti ed eventi ordinati per la sincronizzazione [codice:
apps/server/src/session-groups.ts:13]. Il cambio di sessione e la gestione delle sessioni sono
flussi coperti da comandi di test dedicati [codice: package.json:47]. Non risulta una kanban globale
che lancia agenti da sola come quella di Topics: la ricerca di `kanban` nel repository non dà
risultati [non verificato]. Il lavoro programmato si chiama Automations: pianificazioni singole,
giornaliere o settimanali con semantica deterministica su fusi e recuperi, ma il desktop è solo un
client e mai lo schedulatore, che sta nel backend Den [codice: packages/automations/README.md:12].
Il motore viene ricostruito di routine per ricarichi di configurazione, skill e MCP, per sfratto da
inattività e per rollover, quindi lo stato durevole sta fuori dal processo [codice:
apps/server/src/thread-approvals.ts:1]. Il codice di review automatica non è per l'utente:
`apps/review` compone pagine di revisione immutabili a partire da record di test ed evidenze
sintetiche, quindi è attrezzatura interna per le eval [codice: apps/review/README.md:3]. L'offload
remoto usa journal durevoli con comandi, ricevute e orologi monotonici, pensati per sopravvivere a
cambi di account e di rete, con ritenzione limitata esplicita [codice:
packages/remote-sessions/README.md:14]. Sandbox per esecuzioni isolate: pacchetti dedicati per
Daytona e Freestyle [codice: packages/sandbox-daytona/package.json:1]. Tentativi con code e
priorità, merge e publish paragonabili al flusso land di Topics non risultano nel client [non
verificato].

## Usabilità

Superfici: app desktop, web UI self hosted dallo stesso server e web di amministrazione per le
organizzazioni, nessuna app mobile nativa nel repository [non verificato]. L'onboarding punta tutto
sull'agente che l'utente ha già: un prompt da incollare in Claude Code, Cursor, Codex o ChatGPT
installa l'app e apre il primo workspace pronto [README]. Il documento di design dichiara il
pubblico: lavoratori della conoscenza non tecnici, con la chat come superficie principale e tutto il
resto a supporto della conversazione [codice: DESIGN.md:11]. Le regole di design sono numerate e
citabili nelle revisioni, con la prima che chiede di mostrare lo stato invece di spiegare
l'interfaccia [codice: DESIGN.md:19]. Il flusso principale è la chat sulle conversazioni con
pannello laterale per browser e artifact. Le liste di messaggi lunghe sono virtualizzate con
TanStack Virtual [codice: apps/app/src/components/chat/progressive-message-list.tsx:2].
L'internazionalizzazione è prevista con cartella dedicata e corsia di CI [codice:
.github/workflows/ci-i18n.yml:1]. Gli aggiornamenti arrivano da GitHub Releases con
`electron-updater` e canali stable e alpha separati [codice: apps/desktop/electron/updater.mjs:47].
Scorciatoie globali, notifiche di sistema e guida introduttiva non sono state verificate nel codice
letto [non verificato].

## Browser e anteprima

C'è un browser integrato vero, non una semplice anteprima: il processo main crea viste web native,
una per tab, con sandbox attiva, isolamento di contesto e niente integrazione Node nelle pagine
[codice: apps/desktop/electron/browser-panel.mjs:34]. La partizione di persistenza è condivisa e
nominata, così i tab sopravvivono ai riavvii [codice: apps/desktop/electron/browser-panel.mjs:22].
Un nuovo tab aperto dall'utente atterra su un motore di ricerca, mentre il percorso programmatico
dell'agente parte da pagina vuota [codice: apps/desktop/electron/browser-panel.mjs:26]. Ogni tab
appartiene alla conversazione che l'ha aperta e il pacchetto di policy decide quale tab può stare in
primo piano e come emulare viewport e fuoco per i tab nascosti, così l'agente continua a pilotare
pagine non visibili [codice: packages/browser-tabs/README.md:8]. Limite rigido di 12 tab aperti,
senza sfratto di documenti vivi, e cronologia di 20 tab chiusi [codice:
apps/desktop/electron/browser-panel.mjs:30] [codice: apps/desktop/electron/browser-panel.mjs:31].
Menu contestuali nativi, gestione dei link esterni e permessi media sono moduli separati del
processo main [codice: apps/desktop/electron/browser-panel.mjs:1]. Le regole di permesso dell'agente
si applicano anche al browser, e gli utenti chiedono un interruttore per non riconfermare ogni
origine a ogni accesso [codice: apps/desktop/electron/browser-panel.mjs:60] [issue #4969]. L'agente
pilota le pagine con strumenti dedicati eseguiti in task staccati dal processo [codice:
apps/desktop/electron/browser-panel.mjs:14]. Le issue segnalano esecuzioni duplicate dello stesso
comando browser, parametri rifiutati e blocchi su Windows [issue #3814] [issue #5492] [issue #3443].
Niente di simile al co-browse Mac iPad di Topics risulta documentato [non verificato].

## Terminale, editor, file

Il terminale è un dock xterm nel pannello di sessione, disponibile solo nell'app desktop: se il
bridge Electron manca, mostra un messaggio che invita a usare il desktop invece di fallire in
silenzio [codice: apps/app/src/react-app/domains/session/terminal/terminal-dock.tsx:25]. Il bridge
espone creazione, scrittura, ridimensionamento, chiusura e stream di dati e uscita [codice:
apps/app/src/react-app/domains/session/terminal/terminal-dock.tsx:30]. Il PTY nativo è fornito da un
fork di `node-pty` impacchettato nel bundle desktop [codice: apps/desktop/package.json:49]. Su Intel
macOS il binario PTY mancante ha causato crash all'avvio, segno di quanto la catena nativa sia
fragile [issue #2351]. L'editor di testi degli artifact usa CodeMirror con anteprima markdown dal
vivo, scorciatoie e cronologia [codice:
apps/app/src/react-app/domains/session/artifacts/artifact-text-editor.tsx:3]. I file del workspace
passano da route dedicate con controlli di esportazione sicura [codice:
apps/server/src/workspace-export-safety.ts:1]. Il miglioramento del rendering delle differenze in
chat è oggetto di proposta esplicita, segno che l'area è in evoluzione [issue #4080].

## Remoto e mobile

Nessun client iOS o Android nel repository [non verificato]. Il lavoro remoto esiste in tre forme:
web UI self hosted servita dallo stesso server con un solo comando, offload di sessioni verso runner
remoti con journal durevoli [codice: packages/remote-sessions/README.md:14] e sandbox effimere su
Daytona o Freestyle per il web. Il pacchetto server si installa anche da npm ed esegue su Node senza
Bun [codice: apps/server/README.md:7]. Il pairing fra superfici usa deep link `openwork://` con
token firmati in EdDSA verificati nel processo main, mai nel renderer, con tolleranza di skew di
orologio [codice: apps/desktop/electron/connect-link.mjs:1]. La modalità web di default si lega al
loopback con approvazione automatica, quindi l'esposizione in rete è una scelta esplicita [codice:
apps/server/README.md:30]. Il passaggio fra worker locali e remoti è un percorso curato
esplicitamente [issue #771]. La cifratura dei trasporti verso il cloud non è stata verificata nel
codice letto [non verificato].

## Provider e protocolli

Il motore è OpenCode, quindi i modelli arrivano dai suoi provider: chiave personale, accesso con
ChatGPT oppure modelli locali via Ollama o server compatibili OpenAI, oltre 50 provider dichiarati
[README]. Esiste un relay gratuito con autenticazione gestita dal server, separato dal percorso a
chiave personale [codice: apps/server/src/anonymous-inference.ts:1]. La sincronizzazione dei
provider verso i desktop è un flusso dedicato che in passato si è incagliato sullo stato di
sincronizzazione [issue #3671]. La direzione opposta è il pezzo distintivo: un gateway MCP remoto
espone quattro strumenti (`search_capabilities`, `execute_capability`, `list_skills`, `get_skill`)
così le skill e le connessioni assegnate dall'organizzazione, inclusi Google Workspace e Microsoft
365, si usano dentro Codex, Claude Code, Cursor o qualsiasi client MCP [README]. Supporta plugin
compatibili con Claude e MCP server condivisi che migrano da Claude Cowork [README]. MCP è cittadino
di prima classe anche in locale, con validazione dei nomi, mappe di configurazione gestite dal
server e liste di diniego per tool [codice: apps/server/src/mcp.ts:15]. Il client MCP per le imprese
ha pacchetto e mock dedicati con corsia di CI [codice:
.github/workflows/ci-enterprise-mcp-mock.yml:1]. Nessun supporto ACP trovato nel codice [non
verificato]. Claude Code e Codex come motori guidati direttamente non risultano: l'app li incontra
come client del suo gateway, non come backend [non verificato].

## Performance

Dichiarati: virtualizzazione delle liste, ingegneria del motore con rollover senza abortire le
sessioni e binari scaricati una sola volta e riusati [codice:
apps/app/src/components/chat/progressive-message-list.tsx:2] [codice:
apps/server/src/engine-pool.ts:10]. Le lamentele dicono altro sul desktop: uso a riposo intorno a
1,6 GB su macOS [issue #4186], heap del renderer che cresce fino a 4 GB e poi crash OOM dopo circa 7
ore [issue #5446], latenza di digitazione con allegati in chat [issue #1581] [issue #768].
L'alleggerimento dell'app è richiesto esplicitamente dagli utenti [issue #5448]. L'avvio a freddo
del motore OpenCode ha un timeout fisso di 15 secondi che in alcuni ambienti scatta con errore
fatale e inviti a tornare indietro di versione, e gli utenti chiedono una variabile per alzarlo
[issue #5722] [issue #5751]. Sulle API, una proposta chiede di sostituire il polling degli eventi di
workspace e gruppi con eventi server sent [issue #3126]. Gli allegati immagine in passato bloccavano
l'interfaccia senza compressione né controlli preventivi [issue #481]. Rust per la velocità non è
usato: il percorso caldo è TypeScript su Bun o Node con SQLite.

## Affidabilità e qualità

Contati 499 file di test con suffisso test o spec, e oltre mille percorsi che citano test, eval o
fixture. La CI conta 45 workflow, con corsie dedicate a contratti API, SDK, mock MCP,
internazionalizzazione ed evals con revisione delle evidenze [codice:
.github/workflows/ci-tests.yml:1]. Le sessioni sopravvivono al riciclo dei motori grazie allo SQLite
condiviso di OpenCode e a journal di runner con ripristino e ritenzione limitata [codice:
apps/server/src/engine-pool.ts:12] [codice: packages/remote-sessions/README.md:14]. Esistono journal
di ripristino nel processo main, moduli di resilienza per i task staccati e recupero dei task sul
server [codice: apps/desktop/electron/session-runner-journal.mjs:1] [codice:
apps/desktop/electron/browser-panel.mjs:14]. Le asserzioni su crash report nativi e updater sono
coperte da verifiche pianificate [issue #4885]. Aggiornamenti firmati da GitHub Releases con canale
alpha separato [codice: apps/desktop/electron/updater.mjs:47]. Punti deboli ammessi: i log del
servizio desktop vivono solo in memoria e spariscono a ogni crash o riavvio [issue #3780], i
processi server su Windows a volte sopravvivono alla chiusura accumulando memoria [issue #1353] e la
pulizia dopo la chiusura va migliorata [issue #1137]. La migrazione a OpenCode v2 e il riavvio del
motore hanno una corsia di prontezza dedicata [codice: apps/server/package.json:20].

## Sicurezza e privacy

I file restano in locale di default e il cloud è opzionale [README]. Le credenziali passano per un
vault la cui chiave è gestita dal processo main con permessi restrittivi sui file e una modalità
mock solo per sviluppo [codice: apps/desktop/electron/secure-vault-key.mjs:9]. Le approvazioni date
all'agente sono ricordate per conversazione: il modulo apposito risponde al posto dell'utente solo
per ciò che fu già concesso sullo stesso thread, e il motore resta l'unico arbitro [codice:
apps/server/src/thread-approvals.ts:1]. Le pagine del browser girano in sandbox con isolamento di
contesto [codice: apps/desktop/electron/browser-panel.mjs:34]. I tool MCP si possono negare per
progetto o per configurazione globale con più stili di pattern [codice: apps/server/src/mcp.ts:17].
Le policy desktop gestite arrivano dall'organizzazione con IPC dedicato [codice:
apps/server/src/managed-policy-ipc.ts:1]. Le guide per gli agenti vietano di far trapelare clienti o
persone in branch, commit e fixture, con uso di ticket interni [codice: AGENTS.md:14]. Telemetria
con Sentry nel desktop e chiavi PostHog negli ambienti di sviluppo [codice:
apps/desktop/package.json:60]. La policy di sicurezza chiede segnalazioni private invece di issue
pubbliche [codice: SECURITY.md:8]. Il contenuto sotto `ee/` è pubblico per audit ma la licenza ne
limita l'uso in produzione: in questo studio è stato solo letto, mai copiato [README]. Uso delle
credenziali di Claude Code in modo lecito: non verificato nel codice letto [non verificato]. Porte
esposte: la modalità web lega il loopback di default, il resto non è stato verificato [non
verificato].

## Estendibilità

Quattro leve: skill in formato SKILL.md condivisibili in team, plugin compatibili con Claude, server
MCP locali e condivisi, gateway MCP verso agenti esterni [README]. Le funzionalità visibili si
dichiarano in un registro centrale con rollout per deployment e interruttore globale, pensato per
accensioni graduali dall'interfaccia di amministrazione [codice:
packages/features/src/registry.ts:1]. La procedura di aggiunta di una funzionalità è codificata in
una skill interna e la Checklist di CI la verifica [codice: .github/workflows/features-check.yml:1].
I plugin del motore OpenCode vivono in una cartella dedicata con permessi, policy, quote e
adattamento dei tool [codice: apps/server/src/opencode-plugins/managed-policy.ts:1]. Il contratto
delle API Den è generato: dopo ogni cambio di route si rigenerano spec OpenAPI e SDK nello stesso
commit, mai a mano [codice: AGENTS.md:44]. La radice contiene cartelle per esempi, scenari, eval e
mondi di test per i flussi completi [non verificato]. Hook agente e skill di orchestrazione interna
esistono per gli sviluppatori, ma un sistema di hook utente paragonabile a quello di OpenCode non è
stato verificato [non verificato].

## Da prendere per Topics

1. Gateway MCP in uscita: esporre skill e connessioni di Topics come server MCP remoto con pochi
strumenti di ricerca ed esecuzione, così si usano dentro gli agenti che l'utente ha già, come fa
OpenWork con i suoi quattro strumenti [README]. Conterebbe perché allarga Topics oltre il desktop
senza scrivere un client per ogni agente.
2. Registro delle funzionalità con rollout: dichiarare ogni novità visibile in un file centrale,
spenta di default, con accensione per ambiente, come nel registro di OpenWork [codice:
packages/features/src/registry.ts:1]. Conterebbe perché riduce il rischio di ogni release.
3. Rollover blue green del motore: a cambio di configurazione avviare un motore di riserva e tenere
il vecchio solo per le sessioni in corso, invece di abortire o di rimandare [codice:
apps/server/src/engine-pool.ts:10]. Conterebbe perché i cambi di provider e permessi oggi
interrompono il lavoro.
4. Sidecar con hash pinnato: scaricare il binario del motore una sola volta verificandone
l'integrità e riusarlo [codice: apps/server/src/opencode-v2-binary.ts:33]. Conterebbe per
installazioni riproducibili e aggiornamenti sicuri.
5. Policy dei tab del browser per conversazione: proprietà, primo piano ed emulazione dei tab
nascosti decise in un modulo senza Electron né React [codice: packages/browser-tabs/README.md:8].
Conterebbe quando il co-browse di Topics dovrà arbitrare più agenti sulla stessa pagina.
6. Approvazioni per thread con motore arbitro: ricordare i sempre di ogni conversazione senza mai
allargare il permesso oltre ciò che fu concesso [codice: apps/server/src/thread-approvals.ts:1].
Conterebbe per ridurre i prompt ripetitivi senza buchi di sicurezza.
7. Automazioni con semantica deterministica e idempotenza: calcolo di scadenze, fusi e recuperi in
un pacchetto puro senza infrastruttura [codice: packages/automations/README.md:12]. Conterebbe per
task schedulati affidabili nella kanban.
8. Contratti API generati nello stesso commit: spec OpenAPI e SDK rigenerati insieme a ogni cambio
di route [codice: AGENTS.md:44]. Conterebbe per tenere client iPad e telefono sempre allineati al
server.
9. Documento di design con regole numerate citate nelle revisioni, rivolto a utenti non tecnici
[codice: DESIGN.md:19]. Conterebbe perché rende la qualità dell'interfaccia discutibile con criteri
invece che a gusto.
10. Revisione delle evidenze come pagina immutabile separata dall'esecuzione dei test [codice:
apps/review/README.md:3]. Conterebbe per certificare i flussi della kanban senza rieseguire il mondo
ogni volta.

## Da evitare

1. La migrazione di guscio a metà storia: il passaggio da Tauri a Electron ha reso l'app pesante e
ha fatto perdere i pacchetti deb e rpm su Linux, ancora richiesti [issue #1710] [issue #2084].
Meglio una scelta di guscio stabile che due migrazioni.
2. Il renderer che cresce senza limiti: heap fino a 4 GB e crash OOM in sessioni lunghe, con log
solo in memoria che cancellano le prove [issue #5446] [issue #3780]. Servono budget di memoria e log
persistenti prima delle funzioni nuove.
3. Timeout fissi non configurabili: i 15 secondi per l'avvio a freddo del motore falliscono su
macchine lente senza appello [issue #5722]. Ogni timeout deve avere una variabile di ambiente
documentata.
4. Strumenti browser che si eseguono due volte: oltre cento valutazioni duplicate con eventi
trascritti doppi minano la fiducia nell'automazione [issue #3814]. Serve idempotenza con chiave
stabile prima di aggiungere nuove azioni.
5. Processi orfani su Windows: server e binari che sopravvivono alla chiusura e accumulano memoria
[issue #1353] [issue #1137]. Il ciclo di vita dei figli va supervisionato su ogni piattaforma fin
dal primo giorno.

## Fonti

- Sito e repository: https://github.com/different-ai/openwork
- Documentazione: https://openworklabs.com/docs
- Release: https://github.com/different-ai/openwork/releases
- Licenza divisa MIT ed EE: https://github.com/different-ai/openwork/blob/957d7003c054628e5124e89c59b7955aeb0c22a6/README.md
- Guscio Electron e viste browser: https://github.com/different-ai/openwork/blob/957d7003c054628e5124e89c59b7955aeb0c22a6/apps/desktop/electron/browser-panel.mjs#L7
- Limite di 12 tab: https://github.com/different-ai/openwork/blob/957d7003c054628e5124e89c59b7955aeb0c22a6/apps/desktop/electron/browser-panel.mjs#L30
- Policy dei tab per conversazione: https://github.com/different-ai/openwork/blob/957d7003c054628e5124e89c59b7955aeb0c22a6/packages/browser-tabs/README.md
- Pool blue green del motore: https://github.com/different-ai/openwork/blob/957d7003c054628e5124e89c59b7955aeb0c22a6/apps/server/src/engine-pool.ts#L10
- Installazione del binario con verifica di integrità: https://github.com/different-ai/openwork/blob/957d7003c054628e5124e89c59b7955aeb0c22a6/apps/server/src/opencode-v2-binary.ts#L33
- Gruppi di sessioni: https://github.com/different-ai/openwork/blob/957d7003c054628e5124e89c59b7955aeb0c22a6/apps/server/src/session-groups.ts#L13
- Automazioni solo client sul desktop: https://github.com/different-ai/openwork/blob/957d7003c054628e5124e89c59b7955aeb0c22a6/packages/automations/README.md#L12
- Approvazioni per thread: https://github.com/different-ai/openwork/blob/957d7003c054628e5124e89c59b7955aeb0c22a6/apps/server/src/thread-approvals.ts#L1
- Aggiornamenti da GitHub Releases: https://github.com/different-ai/openwork/blob/957d7003c054628e5124e89c59b7955aeb0c22a6/apps/desktop/electron/updater.mjs#L47
- Registro delle funzionalità: https://github.com/different-ai/openwork/blob/957d7003c054628e5124e89c59b7955aeb0c22a6/packages/features/src/registry.ts#L1
- Issue #1710, #2084, #3780, #3814, #4186, #4969, #5446, #5492, #5722, #5751, #3443, #3126, #1353, #1137, #4080, #5879, #1581, #768, #771, #3671, #4885, #2351, #5448, #481: https://github.com/different-ai/openwork/issues
