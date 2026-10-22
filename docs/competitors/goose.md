# goose

## In tre righe

goose è un agente AI generalista open source che gira sulla macchina
dell'utente, con app desktop, CLI e API per codice, ricerca, scrittura
e automazione. Serve sviluppatori e chi automatizza flussi, con oltre 15 provider e oltre 70 estensioni MCP [README]. Il suo punto più forte
rispetto a Topics è il nucleo in Rust esposto come server ACP riusabile,
con recipe versionabili, scheduler cron e un trasporto peer to peer
già disegnato.

## Identità

Il repository è `aaif-goose/goose`, passato sotto la Agentic AI Foundation
della Linux Foundation, con licenza Apache 2.0 [README]. Al momento
dello studio conta circa 55.000 stelle [doc: https://github.com/aaif-goose/goose]. L'ultimo commit clonato è del
14 ottobre 2026 e alza la versione a 1.55.0 [codice: Cargo.toml:11].
Le release recenti sono quasi settimanali: v1.54.0 dell'8 ottobre, v1.53.0,
v1.52.0, v1.51.0 e v1.50.1 tra metà settembre e inizio ottobre 2026
[release v1.54.0]. Il progetto è maturo, con governance, elenco
di manutentori, checklist di release e guida alle distribuzioni
personalizzate [codice: CUSTOM_DISTROS.md]. Le piattaforme coperte sono
macOS, Linux e Windows per il desktop, più la CLI ovunque compili Rust;
la CLI si installa con uno script dalla release stabile [README].

## Architettura

Il workspace Rust dichiara come membri tutte le crate in `crates/*`
[codice: Cargo.toml:2]. Misurato con `git ls-files` più `wc -l`, il codice
è circa 297.800 righe di Rust in 593 file, circa 46.200 righe di TypeScript
e circa 62.800 di TSX per il desktop, più circa 6.700 righe di Python
di servizio. Le crate principali sono il loop agente, i provider,
gli strumenti MCP, la CLI, il kit di sviluppo, il roaming, l'inferenza
locale e la gestione dei download [codice: crates/goose-agent/Cargo.toml:9]. Il desktop è un'app Electron
con React, costruita con electron-forge per deb, rpm, squirrel e zip
[codice: ui/desktop/package.json]. Non usa Tauri né un motore dedicato:
il renderer è Chromium. Il modello dei processi prevede un backend
`goose serve`, cioè il vero server ACP su HTTP, che il desktop avvia
e gestisce in lease [codice: ui/desktop/src/main.ts:32]. Il trasporto HTTP
usa Axum con supporto websocket [codice: crates/goose/Cargo.toml:153].
Esistono anche binari secondari come `goose-acp`
[codice: crates/goose/Cargo.toml:315]. Il runtime è tokio multithread
con sincronizzazione e rete asincrone [codice: crates/goose/Cargo.toml:133].
Gli strumenti MCP viaggiano su processi figli o HTTP trasmesso in streaming
[codice: crates/goose/Cargo.toml:118]. Lo storage delle sessioni è SQLite
via SQLx con journal in WAL
[codice: crates/goose/src/session/session_manager.rs:1068].
La configurazione è in YAML e i segreti stanno nel keyring di sistema,
con ripiego su file dedicato quando il keyring è disabilitato
[codice: crates/goose/src/config/base.rs:90]. L'agente parla con l'esterno
in ACP su stdio o HTTP e con gli strumenti in MCP
[codice: crates/goose/src/acp/transport/mod.rs:189]. Rust copre nucleo
agente, provider, sessioni, scheduler, roaming e inferenza locale, perché
serve un singolo binario portabile e concorrente, capace di legare librerie
native come tree-sitter, candle, llama.cpp e iroh. La UI resta in TypeScript
perché richiede un renderer web ricco che Rust non offre. Le crate del kit
di sviluppo sono pubblicate su crates.io per chi incorpora l'agente
[codice: AGENTS.md].

## Sessioni e task

Le sessioni sono gestite da un `SessionManager` sopra uno storage dedicato
[codice: crates/goose/src/session/session_manager.rs:348]. L'elenco usa
cursori di paginazione con filtri per tipo, cartella e parola
[codice: crates/goose/src/session/session_manager.rs:352]. Il server ACP
offre creazione, caricamento, elenco, cancellazione e fork delle sessioni
[codice: crates/goose/src/acp/server/fork_session.rs:5]. La CLI aggiunge
ripresa e importazione da altri formati, con normalizzazione dei campi
di schedule e recipe
[codice: crates/goose/src/session/import_formats/mod.rs:53]. Non c'è una
board kanban con code, tentativi e land come in Topics: l'equivalente
è lo scheduler cron, che esegue recipe senza testa e registra stato, ultima
esecuzione e sessione corrente per ogni job
[codice: crates/goose/src/scheduler/common.rs:167]. Lo scheduler salva i job
in un file dedicato e le recipe copiate in una cartella propria, conservando
la cartella di origine per risolvere i percorsi relativi
[codice: crates/goose/src/scheduler/common.rs:182]. Esiste un comando
di review con opzioni, handler e orchestratore dedicati, con limite di turni
e prova a secco [codice: crates/goose-cli/src/commands/review/handler.rs:18].
Il supporto ai worktree è minimo, con un'opzione per partire in un worktree
e regole di autorizzazione definite a parte [issue #11567] [issue #12274].
La memoria tra sessioni passa per un'estensione di ricerca full-text
nelle conversazioni passate
[codice: crates/goose/src/agents/platform_extensions/chatrecall.rs:38].

## Usabilità

Le superfici sono tre: app desktop, CLI completa e API per integrazioni,
mentre la TUI testuale è dichiarata deprecata [codice: AGENTS.md].
Il desktop offre hub, elenco sessioni, vista recipe, vista schedule,
impostazioni a sezioni e onboarding con scelta del provider
[codice: ui/desktop/src/components/Hub.tsx:52] [codice: ui/desktop/src/components/schedule/SchedulesView.tsx:237].
Ci sono scorciatoie da tastiera configurabili, notifiche di sistema,
controllo ortografico e interfaccia tradotta con react-intl
[codice: ui/desktop/src/main.ts:43] [codice: ui/desktop/package.json].
I flussi principali sono conversazione con approvazione dei tool, lancio
da recipe con parametri, schedule ricorrenti e importazione di sessioni
altrui. La review del lavoro agente passa dal comando review e dai diff
mostrati nel renderer. L'aggiornamento è automatico via electron-updater
con artefatti GitHub [codice: ui/desktop/src/utils/autoUpdater.ts:15].
L'onboarding guida alla configurazione del primo provider e del consenso
telemetria [codice: ui/desktop/src/components/onboarding/ProviderSelector.tsx:63].
La CLI copre sessione, schedule, recipe, configurazione, plugin, skill,
roaming e aggiornamento, con pagine di manuale generate dal codice.
Dal terminale si chiama l'agente senza uscire dalla shell corrente
[codice: documentation/docs/guides/terminal-integration.md].

## Browser e anteprima

Non esiste un browser integrato pilotabile né un'anteprima di pagina come
il pannello di Topics, e nulla di simile al co-browse tra dispositivi.
Su macOS l'agente controlla il computer tramite un'estensione che passa
comandi a un tool esterno di osservabilità, con azioni di vista, clic,
digitazione e cattura schermo
[codice: crates/goose-mcp/src/computercontroller/mod.rs:32]. Il passaggio
è limitato a macOS con codice condizionale per piattaforma
[codice: crates/goose-mcp/src/computercontroller/mod.rs:1]. La stessa
estensione legge e scrive PDF, DOCX e XLSX senza aprirli in un browser
[codice: crates/goose-mcp/src/computercontroller/mod.rs:54]. Un visualizzatore
automatico integrato genera grafici dai dati
[codice: crates/goose-mcp/src/lib.rs:93]. Le app fornite via MCP
si renderizzano nell'Electron con isolamento di origine ancora
in definizione [issue #12337]. Una richiesta esplicita di uso del browser
vero chiede una navigazione agita che oggi è assente [issue #10652].
Per Topics questo significa che non c'è niente da copiare sul co-browse,
ma il disegno delle MCP App isolate merita attenzione.

## Terminale, editor, file

Il lavoro su file e shell passa dall'estensione developer interna, con uno
strumento shell attento anche all'esecuzione dentro sandbox Flatpak
[codice: crates/goose/src/agents/platform_extensions/developer/shell.rs:24].
L'analisi del codice usa tree-sitter con nove grammatiche dietro feature
opzionale [codice: crates/goose/Cargo.toml:24]. La scansione dei file ignora
ciò che va ignorato e parallelizza il lavoro con gli appositi crate
specializzati [codice: crates/goose/Cargo.toml:229]. Una modalità di analisi
del codice appoggiata a un motore esterno è disponibile dietro feature
[codice: crates/goose/Cargo.toml:31]. Uno strato di adattamento normalizza
le chiamate ai tool tra provider diversi
[codice: crates/goose/src/providers/toolshim.rs:385]. Le radici MCP
delimitano ciò che l'agente può vedere nel filesystem. Ogni modifica passa
dal sistema di permessi prima dell'esecuzione
[codice: crates/goose/src/config/permission.rs:21]. Rispetto al PTY
di Topics, qui non c'è un terminale condiviso persistente: la shell è uno
strumento tra gli altri, non una superficie autonoma.

## Remoto e mobile

Non esiste un'app mobile né un uso da telefono in LAN come in Topics.
La strada remota è il roaming: un trasporto ACP autenticato punto a punto
su iroh con QUIC, che attraversa i firewall via relay senza porte aperte
[codice: documentation/docs/guides/roaming-agents.md:7]. Il trasporto vive
in una crate autonoma senza dipendenze dal nucleo agente
[codice: crates/goose-roaming/Cargo.toml:9]. È sperimentale, richiede
una build con feature dedicata e non è incluso nei binari pubblicati
[codice: documentation/docs/guides/roaming-agents.md:12]. La CLI espone
delega di task, connessione interattiva e ponte verso editor ACP, con binding
wasm e un client web di riferimento
[codice: documentation/docs/guides/roaming-agents.md:44]. I test del client
coprono elenco, creazione, caricamento e prompt su un vero trasporto, senza
bisogno di un modello [codice: crates/goose-cli/tests/roam_acp_client.rs:1].
Esiste anche un gateway Telegram con accoppiamento e lista di operatori
ammessi [codice: crates/goose/src/gateway/manager.rs:50]. I segreti
dei gateway stanno fuori dalla configurazione serializzata
[codice: crates/goose/src/gateway/manager.rs:17]. Il desktop sa collegarsi
a un backend remoto via ACP su HTTP [codice: ui/desktop/src/main.ts:29].
Per Topics è il disegno più interessante: accesso fuori LAN senza cloud
da gestire.

## Provider e protocolli

I provider coprono Anthropic, OpenAI e compatibili, Google e Gemini, Ollama,
OpenRouter, Azure, Bedrock, Databricks in due varianti, Vertex, GitHub
Copilot, LiteLLM e inferenza locale, con moduli dedicati anche per Codex,
Claude e altri agenti via ACP [codice: crates/goose/src/providers/mod.rs:2].
Un catalogo centrale arricchisce gli identificatori dei modelli con metadati
canonici [codice: crates/goose/src/bin/build_canonical_models.rs:7].
La via consigliata per usare gli abbonamenti esistenti sono i provider ACP,
che avvolgono Claude Code, Codex, Amp e Pi e inoltrano loro le estensioni
come server MCP [codice: documentation/docs/guides/acp-providers.md:10].
I vecchi provider che pilotavano le CLI sono deprecati
[codice: documentation/docs/guides/acp-providers.md:14]. Con i provider ACP
non sono ancora supportati fork e ripresa di sessione
[codice: documentation/docs/guides/acp-providers.md:18]. Claude Code non è
integrato via SDK come in Topics, ma guidato come processo esterno
con protocollo di controllo e riconciliazione dei permessi
[codice: crates/goose/src/providers/claude_code.rs:36]. L'inferenza locale
usa llama.cpp con accelerazione Metal su macOS e modelli scaricati
dall'hub aperto [codice: crates/goose-local-inference/Cargo.toml:40].
Il lato protocolli offre client e server MCP, app MCP, elicitation e radici,
con quattro estensioni integrate nel processo
[codice: crates/goose-mcp/src/lib.rs:89]. Una guida allowlist limita quali
server MCP si possono installare in contesti aziendali
[codice: documentation/docs/guides/allowlist.md].

## Performance

Il progetto non pubblica benchmark numerici nei file letti e dichiara solo
prestazioni e portabilità come motivi della scelta di Rust [README]
[non verificato]. Gli interventi passati mostrano dove il collo di bottiglia
si sposta: rendering dello streaming con costo quadratico corretto su tutti
i frontend [issue #10075], query di elenco sessioni che scandagliava ogni
messaggio con estrazione JSON [issue #11287], prompt CLI reso subito
disponibile mentre le estensioni caricano in fondo [issue #10404]. Restano
aperti il caricamento seriale delle estensioni a ogni nuova sessione
[issue #12754], l'attesa dell'apertura chat finché ogni estensione è pronta
[issue #11396], le sessioni lunghe costose da aprire e talvolta impossibili
da ricaricare [issue #11348] [issue #11559]. Altri pesi noti sono il buffer
senza limiti dell'output shell [issue #12464], l'invalidazione della cache
del prompt per colpa dell'estensione memoria [issue #12507] e flussi
provider in stallo mai rilevati [issue #11679]. Tempeste di riconnessione
e sottoscrizioni mai potate hanno causato allagamenti di richieste
e perdite di memoria, poi corretti [issue #11095] [issue #11023]. Rust aiuta
dove il lavoro è CPU o I/O parallelo, con rayon, tokio e tree-sitter nativo,
ma non salva da disegni sincroni a livello applicativo.

## Affidabilità e qualità

La misura dà circa 308 file legati ai test, tra unitari Rust, integrazione
per agente e provider, conformità MCP e test del desktop con vitest
e Playwright [codice: ui/desktop/vitest.config.ts:1]. I test dell'agente
coprono cancellazione, operazioni sui tool e wasm
[codice: crates/goose-agent/tests/cancellation.rs]. La CI gira su GitHub
con badge pubblico [README]. Una valutazione standard con recipe di autotest
valida le modifiche alle funzionalità [codice: AGENTS.md]. Le sessioni
sopravvivono ai riavvii grazie a SQLite, ma la ripresa ha punti deboli noti:
un tool completato prima del crash può rieseguirsi [issue #11808],
le approvazioni in sospeso hanno una cancellazione durevole ancora
da definire [issue #12132] e sotto pressione di memoria il server è caduto
con errore di segmentazione [issue #10302]. Su Windows si sono visti cicli
di crash all'avvio poi risolti [issue #10902]. Lo scheduler soffre
di esecuzioni doppie, sovrascritture tra processi e timer persi dopo
aggiornamenti non validi [issue #11695] [issue #12613] [issue #12817].
Gli aggiornamenti desktop seguono le release GitHub con migrazioni
automatiche [codice: ui/desktop/src/utils/autoUpdater.ts:15]. La cultura
di verifica è seria, ma lo scheduler resta il tallone d'Achille.

## Sicurezza e privacy

I segreti dei provider stanno nel keyring di sistema e solo con keyring
disabilitato finiscono in un file dedicato
[codice: crates/goose/src/config/base.rs:219]. Le regole vivono in un file
di permessi con tre livelli: consenso sempre, richiesta prima o divieto mai,
con un'approvazione intelligente intermedia
[codice: crates/goose/src/config/permission.rs:13]
[codice: crates/goose/src/config/permission.rs:21]. Le regole di permesso
si salvano per sessione, progetto e utente [issue #12668]. L'OAuth
delle estensioni ha avuto cicli di riautenticazione e corse tra sessioni
concorrenti [issue #11021] [issue #12016], e i dati di ripiego del browser
sono stati tenuti fuori dai log persistenti [issue #12291]. Il renderer
applica una policy di contenuto e controlli sull'HTML
[codice: ui/desktop/src/utils/csp.ts:94]
[codice: ui/desktop/src/utils/htmlSecurity.ts:13]. Il testo sensibile
per il controllo del computer viaggia fuori dagli argomenti di processo
[issue #11723]. La telemetria usa PostHog con scelta esplicita
e spegnimento via ambiente [codice: crates/goose/src/posthog.rs:20].
La rete esposta è il server ACP locale con chiave segreta su header, più
il relay iroh per il roaming [codice: crates/goose/src/acp/transport/mod.rs:175].
Esistono hook prima dell'uso dei tool con comportamento configurabile
in caso di blocco [issue #10866].

## Estendibilità

Il meccanismo principe sono le estensioni MCP, integrate, da processo figlio
o su HTTP, con directory in migrazione verso il registro ufficiale
[codice: crates/goose-mcp/src/lib.rs:89] [codice: AGENTS.md]. Oltre
al controllo computer ci sono memoria, tutorial e visualizzatore come server
integrati [codice: crates/goose-mcp/src/lib.rs:97]. Le recipe sono file YAML
o JSON versionati con istruzioni, prompt, estensioni, parametri, sotto recipe
e criteri di riprova [codice: crates/goose/src/recipe/mod.rs:43].
Le impostazioni della recipe fissano provider, modello, temperatura
e limite di turni [codice: crates/goose/src/recipe/mod.rs:99].
Si installano anche via deeplink con schermata di consenso
[codice: ui/desktop/src/components/RecipeConsentModalContainer.tsx:4].
Gli schedule eseguono recipe su cron con parametri propri
[codice: crates/goose-cli/src/commands/schedule.rs:68]. La CLI gestisce plugin
e skill con comandi dedicati [codice: crates/goose-cli/src/commands/plugin.rs:4]
[codice: crates/goose-cli/src/commands/skills.rs:33]. Le distribuzioni
personalizzate preconfezionano provider, estensioni e marchio
[codice: CUSTOM_DISTROS.md]. L'esecuzione parallela dei tool nel turno
è stata introdotta su richiesta esplicita [issue #10299].

## Da prendere per Topics

1. Backend in lease con supporto nativo per backend remoto. Il desktop avvia
il server, ne segue il ciclo di vita e può puntare a un'istanza lontana
[codice: ui/desktop/src/main.ts:32]. Per Topics conta perché toglierebbe
la porta fissa e aprirebbe all'uso fuori LAN senza cambiare protocollo.
2. Recipe versionate con parametri, sotto recipe ed estensioni dichiarate
[codice: crates/goose/src/recipe/mod.rs:43]. Per Topics sono pacchetti
di lavoro perfetti da lanciare dalla kanban invece di prompt liberi.
3. Consenso esplicito all'installazione da deeplink
[codice: ui/desktop/src/components/RecipeConsentModalContainer.tsx:4].
Per Topics è il modello giusto quando una card propone di eseguire qualcosa
di condiviso.
4. Permessi a tre livelli salvati per sessione, progetto e utente
[codice: crates/goose/src/config/permission.rs:29] [issue #12668].
Per Topics è più fine del sì o no attuali e riduce le richieste ripetute.
5. Ricerca nelle sessioni passate come strumento dell'agente
[codice: crates/goose/src/agents/platform_extensions/chatrecall.rs:38].
Per Topics significa cercare nei topic chiusi senza duplicare contesto.
6. Roaming come trasporto ACP su QUIC con relay
[codice: documentation/docs/guides/roaming-agents.md:35]. Per Topics è la via
per raggiungere il Mac da iPad fuori casa senza gestire un cloud.
7. Diagnostica integrata con comando dottore e viste dedicate
[codice: crates/goose-cli/src/commands/doctor.rs:6]. Per Topics riduce
il tempo di debug delle installazioni altrui.
8. Esecuzione parallela dei tool nel turno [issue #10299]. Per Topics
velocizza i turni con molte letture indipendenti di file.

## Da evitare

1. Estensioni caricate in serie prima di aprire la chat, con attese di secondi
a ogni sessione [issue #12754] [issue #11396]. Meglio caricamento pigro
con UI subito pronta.
2. Ricarica integrale delle sessioni lunghe sul trasporto, che le rende
costosissime o inaccessibili [issue #11348] [issue #11559]. Meglio
la paginazione con i cursori già previsti dallo storage
[codice: crates/goose/src/session/session_manager.rs:352].
3. Output di shell accumulato in memoria senza limiti prima del troncamento
[issue #12464]. Meglio streaming su file con finestra visibile.
4. Scritture concorrenti a configurazione e schedule senza lock tra processi,
con doppie esecuzioni e ricette sovrascritte
[issue #12422] [issue #11695] [issue #12613]. Meglio un proprietario unico
per job.
5. Credenziali OAuth perse o rigenerate a ogni sessione in presenza di avvii
concorrenti [issue #11021] [issue #12016]. Meglio refresh serializzato
e cache condivisa.
6. Cache del prompt invalidata dall'ordine instabile dei ricordi iniettati
[issue #12507]. Meglio un ordinamento deterministico prima dell'invio.

## Fonti

- https://github.com/aaif-goose/goose
- https://github.com/aaif-goose/goose/blob/9686d674000a5fbb8139214863289e4820714771/Cargo.toml
- https://github.com/aaif-goose/goose/blob/9686d674000a5fbb8139214863289e4820714771/crates/goose/Cargo.toml#L315
- https://github.com/aaif-goose/goose/blob/9686d674000a5fbb8139214863289e4820714771/crates/goose/src/session/session_manager.rs#L348
- https://github.com/aaif-goose/goose/blob/9686d674000a5fbb8139214863289e4820714771/crates/goose/src/config/permission.rs#L21
- https://github.com/aaif-goose/goose/blob/9686d674000a5fbb8139214863289e4820714771/crates/goose/src/recipe/mod.rs#L43
- https://github.com/aaif-goose/goose/blob/9686d674000a5fbb8139214863289e4820714771/crates/goose/src/scheduler/common.rs#L167
- https://github.com/aaif-goose/goose/blob/9686d674000a5fbb8139214863289e4820714771/crates/goose-mcp/src/lib.rs#L89
- https://github.com/aaif-goose/goose/blob/9686d674000a5fbb8139214863289e4820714771/crates/goose-mcp/src/computercontroller/mod.rs#L32
- https://github.com/aaif-goose/goose/blob/9686d674000a5fbb8139214863289e4820714771/crates/goose-local-inference/Cargo.toml#L40
- https://github.com/aaif-goose/goose/blob/9686d674000a5fbb8139214863289e4820714771/crates/goose-roaming/Cargo.toml#L16
- https://github.com/aaif-goose/goose/blob/9686d674000a5fbb8139214863289e4820714771/crates/goose/src/providers/claude_code.rs#L36
- https://github.com/aaif-goose/goose/blob/9686d674000a5fbb8139214863289e4820714771/documentation/docs/guides/roaming-agents.md
- https://github.com/aaif-goose/goose/blob/9686d674000a5fbb8139214863289e4820714771/documentation/docs/guides/acp-providers.md
- https://goose-docs.ai/docs/getting-started/installation
