# Omnara

## In tre righe

Omnara è una piattaforma open source per eseguire agenti IA come servizio: si definisce un agente in YAML, lo si lancia da API, CLI o dashboard, e i worker lo eseguono su sandbox o su macchine proprie con stato durevole [README].
È pensata per team e prodotti che vogliono agenti sempre accesi, su qualsiasi modello e qualsiasi macchina, anche self-hosted [README].
Il suo punto più forte rispetto a Topics è l'esecuzione remota multi-macchina con permessi applicati lato piattaforma: l'agente gira ovunque, la policy resta sul server [codice: internal/toolpermission/modes.go:15].

## Identità

Repository `omnara-ai/omnara`, circa 2.900 stelle e 237 fork, licenza Apache 2.0, linguaggio principale Go [README].
Ultimo commit verificato: 14 ottobre 2026, con le release `cluster v0.2.3` e `omnarad v0.2.3` pubblicate lo stesso giorno [release v0.2.3].
Maturità: versione 0.2.x, quindi prodotto giovane, ma con sviluppo quotidiano e release ravvicinate (v0.2.2 il 10 ottobre 2026) [release v0.2.2].
La storia del repository mostra anche un passato diverso: molte issue con etichetta legacy parlano di una UI per Claude Code, prima della riscrittura come piattaforma [issue #514].
Piattaforme: server via Docker Compose (self-host) o Omnara Cloud; daemon `omnarad` su macOS e Linux, con supporto Windows parziale perché la PTY non è supportata su Windows [codice: internal/machinedaemon/process_pty_windows.go:7]; dashboard web, CLI Node e SDK TypeScript [README].

## Architettura

Backend in Go, circa 542.000 righe in 1.773 file; frontend TypeScript e TSX, circa 71.000 righe più 33.000 generate; SQL circa 21.000 righe; totale misurato circa 864.000 righe su 2.938 file [non verificato].
Il frontend web usa Vite, React, TanStack Router e Tailwind; la CLI usa Commander con interfaccia Ink e React [codice: frontend/apps/web/package.json:26].
Il modello dei processi è: API, worker stateless, daemon `omnarad` sulle macchine, Postgres come registro degli eventi di ogni agente, Redis per bus e notifiche, più blob storage e un filesystem di memoria [README].
L'agent loop è proprietario e parla con i modelli in tre formati, scelti per configurazione: OpenAI Responses, OpenAI Chat Completions e Anthropic Messages, con varianti per default, OpenRouter e Bedrock [codice: internal/modelprotocol/modelprotocol.go:12].
Il daemon si connette in uscita al server via websocket, senza porte in ingresso, con heartbeat periodico e riconciliazione [codice: internal/machinedaemon/client_socket.go:178].
Sulle macchine Unix il daemon offre anche PTY tramite libreria dedicata, con dimensione iniziale 24x80 [codice: internal/machinedaemon/process_pty_unix.go:14].
Su Linux l'esecuzione isolata usa seccomp-bpf e Landlock, con allowlist di syscall e limite di memoria per gli script [codice: internal/sandbox/sandbox_linux.go:132].
Con l'agente non usa Agent SDK, PTY locale o stream-json di `claude -p`: usa il proprio loop server-side e invia i comandi al daemon sulle macchine [README].

## Sessioni e task

Gli agenti si lanciano da API, CLI, dashboard, SDK o MCP, con messaggi inviati anche mentre l'agente lavora, e ogni passo resta nel registro Postgres [README].
Un agente può avviare subagenti con contesto nuovo, seguirne l'avanzamento e inviare nuove istruzioni; ogni subagente è ispezionabile [README].
Esistono trigger cron con fuso orario che mandano messaggi, lanciano agenti da un profilo o aprono thread Slack e Discord [README].
Non esiste una board kanban integrata: nessuna occorrenza di kanban nel prodotto, e i riferimenti a worktree sono solo un pattern negli esempi, non una funzione [non verificato].
Niente code con tentativi, review integrata, merge o CI interni: su GitHub l'agente parte su trigger di pull request, legge il diff, commenta e fa review tramite esempio dedicato [codice: examples/pr-review-agent/agent.yaml:1].
Le approvazioni umane sono integrate nel flusso: i tool in modalità apposita attendono che qualcuno approvi o rifiuti la chiamata [codice: internal/toolpermission/interaction.go:47].
Gli agenti si ispezionano come gerarchia: gli eventi in streaming coprono anche i subagenti, con sottoscrizioni dedicate lato API [codice: internal/httpapi/agent_event_stream_subagents.go:8].
Le integrazioni possono lanciare agenti con configurazioni poi modificabili dalla dashboard, come introdotto di recente [release v0.2.3].

## Usabilità

Superfici: dashboard web, CLI nel terminale con chat, SDK TypeScript, Slack, Discord e GitHub; nessuna app desktop nativa, nessuna TUI oltre la CLI, nessuna app mobile [README].
Flussi principali: si scrive un `agent.yaml`, lo si lancia, si chatta nel terminale o si osservano le tool call nella dashboard [README].
L'onboarding è delegato ai coding agent: esiste una skill di setup servita anche come pagina web, più documentazione in formato llms.txt [README].
Le notifiche passano per Slack, Discord, webhook ed eventi in streaming; scorciatoie da tastiera e onboarding guidato non risultano documentati [non verificato].

## Browser e anteprima

Nessun browser integrato e nessuna anteprima di pagina nel prodotto: non esiste co-browse fra dispositivi né pilotaggio di una webview da parte dell'agente [non verificato].
L'unico browser è un esempio: un agente che usa un Chrome reale sulla propria macchina, guidato da una CLI esterna tramite comandi di apertura, snapshot di accessibilità, click, compilazione e screenshot annotati [codice: examples/browser-agent/agent.yaml:37].
La documentazione dell'esempio dichiara esplicitamente che non esiste una vista dal vivo, che gli IP dei datacenter vengono spesso bloccati e che in caso di CAPTCHA o SSO serve un browser ospitato da fornitori terzi [doc: https://docs.omnara.com/examples/browser-agent].
Per Topics, che ha già co-browse nativo con 15 tool, qui non c'è nulla da imparare sul pilotaggio visivo.

## Terminale, editor, file

L'agente esegue comandi shell ed edita file sulle macchine registrate tramite il daemon, con trasferimento file soggetto a limiti di dimensione e helper per le credenziali git [codice: internal/daemonprotocol/protocol.go:91].
Non esiste un terminale o un editor integrato per l'utente: l'utente osserva le tool call nella dashboard, i comandi li esegue l'agente [README].
I file di memoria persistono fra conversazioni e si condividono fra agenti con accessi in lettura o lettura e scrittura per agente [README].
Le skill impacchettano istruzioni e file una volta sola e l'agente le carica quando servono [README].

## Remoto e mobile

Nessuna app mobile: l'accesso remoto avviene da dashboard web, CLI, Slack, Discord o API [README].
Il daemon non richiede porte in ingresso né chiavi SSH perché la connessione parte sempre dalla macchina verso il server [README].
Se un portatile va offline, l'agente può continuare in una sandbox e sincronizzare il lavoro con git [README].
I dettagli di cifratura del canale e di autenticazione mutua non sono stati verificati nel codice [non verificato].

## Provider e protocolli

Funziona con qualsiasi modello dietro endpoint compatibili con OpenAI Responses, OpenAI Chat Completions o Anthropic Messages, inclusi OpenAI, Anthropic, OpenRouter, LiteLLM e Ollama, più Bedrock con firma dedicata [codice: internal/modelprovider/resolver.go:241].
Non usa Claude Code, Codex, OpenCode o altri harness: il confronto nella documentazione li elenca come alternative da terminale a macchina singola, mentre Omnara è la versione cloud multi-macchina [doc: https://docs.omnara.com/introduction].
Sul protocollo MCP fa entrambe le parti: consuma server MCP remoti come client, con bearer, OAuth e firma dedicata, ed espone la propria API come server MCP con accesso via OAuth da browser, senza token da incollare [codice: internal/mcp/client.go:209] [README].
Nessun riferimento trovato al protocollo ACP [non verificato].

## Performance

Nessun benchmark dichiarato su avvio, memoria o rendering [non verificato].
Gli eventi arrivano in streaming con anteprima dei delta; i worker sono stateless e uno solo serve molti agenti a turno, quindi la capacità scala aggiungendo worker [README].
Sul frontend non risultano liste virtualizzate dedicate [non verificato].
Lamentele utili nelle issue: lo stream degli eventi chiudeva ogni connessione dopo circa 16 secondi nonostante l'heartbeat, con resume incompleto sui frame delta [issue #502].
Altre issue su lentezza e blocchi (resume che riscrive la sessione, turni che restano appesi, popup che congelano l'interfaccia) portano etichetta legacy e riguardano il prodotto precedente, una UI per Claude Code, non la piattaforma attuale [issue #514] [issue #368] [issue #276].

## Affidabilità e qualità

Test: 872 file di test Go, di cui 838 sotto `internal`; frontend con 127 file di test TypeScript più 2 file di specifiche Playwright; migrazioni database in 55 file [non verificato].
La CI ha flussi separati per gate principale, CLI, cluster, daemon, SDK e controllo dei componenti React [codice: .github/workflows/ci.yaml:1].
Ogni passo di ogni agente è salvato in Postgres come stato, così qualsiasi worker riprende l'agente dopo crash, restart e disconnessioni delle macchine [README].
Il contesto lungo è gestito con compaction dedicata e limiti di output per provider, con retry sui modelli [codice: internal/harness/kernel/agent_executor_compaction.go:1].
Il daemon ha supervisore, installazione come servizio su launchd e systemd, e meccanismo di auto-aggiornamento [codice: internal/omnarad/supervisor.go:1].

## Sicurezza e privacy

Ogni tool ha tre modi, applicati dalla piattaforma e non dall'agente: esegui sempre, chiedi sempre, nega sempre, con decisione di Allow o Deny motivato [codice: internal/toolpermission/modes.go:15].
Controllo accessi per ruoli a due livelli: organizzazione con proprietario, admin e membro; progetto con admin, sviluppatore, operatore e visualizzatore [codice: internal/authz/authz.go:53].
Le credenziali di modelli, macchine e server MCP si registrano una volta e si condividono esplicitamente per progetto [README].
Protezioni tecniche sparse nel codice: trasporto anti SSRF, policy sugli URL, overlay di segreti sull'ambiente dei processi, sandbox Linux con seccomp e Landlock [codice: internal/ssrf/transport.go:1].
Il documento di sicurezza descrive solo come segnalare vulnerabilità, nessuna misura tecnica [doc: https://github.com/omnara-ai/omnara/blob/0bf1d830e2bb7f6128601d3df1c2be4b636259e7/SECURITY.md].
Il login della CLI apre il browser per l'accesso e punta a un issuer configurabile, anche self-hosted [README].
I default locali sono dichiaratamente insicuri e la guida chiede di seguire il manuale di self-hosting per la produzione [README].
Nessuna evidenza trovata di telemetria verso terzi nel backend [non verificato].

## Estendibilità

Tool integrati per shell, file, ricerca web, fetch e domande alla persona, più server MCP, tool custom sui propri sistemi via webhook e tool di anteprima [README].
Skill, memory store, subagenti e trigger cron compongono automazioni senza ridistribuire codice [README].
API REST descritta in OpenAPI, SDK TypeScript generato, CLI completa e server MCP pubblico per pilotare Omnara da altri coding agent [codice: api/openapi/openapi.yaml:1].
Integrazioni custom costruibili sulla stessa API pubblica; nove fornitori di sandbox collegabili come pool di macchine [codice: internal/machinepool/catalog.go:29].
La CLI impacchetta anche comandi di setup per macchine e integrazioni, pensati per essere eseguiti dal coding agent [codice: frontend/packages/cli/src/bin.ts:1].
Una richiesta aperta chiede server MCP stdio eseguiti sulla macchina associata, oggi non supportati [issue #469].

## Da prendere per Topics

1. Permessi a tre modi applicati dal server con maschera Allow e Deny: il posto giusto dove replicare il consenso per i 15 tool di co-browse, così la policy non dipende dal client [codice: internal/toolpermission/modes.go:15]. Conta per Topics perché sposta il consenso dal frontend al server Bun.
2. Worker stateless con lock e lease sullo stato in Postgres: qualsiasi processo riprende un topic dopo un crash senza stato in memoria [codice: internal/harness/worker/worker.go:1]. Conta perché rende gli agenti lanciati dalla kanban sopravvissuti ai restart del servizio launchd.
3. Daemon con connessione solo in uscita, heartbeat e accodamento: niente porte in ingresso né SSH per pilotare macchine remote [codice: internal/machinedaemon/client_socket.go:178]. Conta per l'uso da iPad e telefono fuori LAN senza esporre il Mac.
4. Memory store condivisi fra agenti con permessi per agente: contesto persistente oltre la singola chat del topic [README]. Conta per topic multi-agente che condividono file di lavoro.
5. Compaction dedicata più riepiloghi dei subagenti: turni lunghi senza perdere il filo [codice: internal/harness/kernel/agent_executor_compaction.go:1]. Conta per le sessioni `claude -p` più lunghe di Topics.
6. Server MCP con login OAuth da browser, senza token da incollare: onboarding in un comando per Claude Code e Codex [README]. Conta per far pilotare Topics dagli harness esterni senza gestire segreti a mano.
7. Skill di setup più llms.txt per far configurare tutto al coding agent [README]. Conta perché abbatte il costo di onboarding di ogni nuova funzione di Topics.
8. Trigger cron con fuso orario che lanciano agenti o aprono thread chat [README]. Conta per dare alla kanban di Topics risvegli pianificati senza demone ad hoc.
9. Helper per credenziali git e limiti di trasferimento nel daemon [codice: internal/daemonprotocol/protocol.go:91]. Conta per far lavorare gli agenti su repo remoti senza spargere token.
10. Sandbox Linux con seccomp e Landlock per i comandi dell'agente [codice: internal/sandbox/sandbox_linux.go:132]. Conta come modello per isolare i comandi degli agenti lanciati dalla kanban.

## Da evitare

1. Default locali volutamente insicuri: comodo per la demo, inaccettabile se Topics apre porte in LAN senza gli stessi avvisi espliciti [README].
2. Confondere le issue legacy con quelle attuali: molte segnalazioni gravi riguardano il prodotto precedente e non la piattaforma odierna, citarle come bug correnti sarebbe falso [issue #514].
3. Streaming fragile con resume incompleto sui delta: prima di promettere live update sul co-browse, coprire riconnessione e replay [issue #502].
4. Agente browser senza vista dal vivo e con IP da datacenter facilmente bloccati: non inseguire questa strada per l'anteprima di Topics, il WKWebView locale resta superiore [doc: https://docs.omnara.com/examples/browser-agent].
5. Versione 0.2.x con API in movimento: integrare a fondo oggi espone a rotture a ogni release [release v0.2.3].
6. Dipendenza da nove fornitori di sandbox terzi per l'esecuzione: più superficie di guasti e di policy dati fuori controllo rispetto alle macchine proprie [codice: internal/machinepool/catalog.go:29].

## Fonti

- Sito e repository: https://github.com/omnara-ai/omnara
- README e architettura: https://github.com/omnara-ai/omnara/blob/0bf1d830e2bb7f6128601d3df1c2be4b636259e7/README.md
- Introduzione e posizionamento: https://docs.omnara.com/introduction
- Permessi dei tool: https://github.com/omnara-ai/omnara/blob/0bf1d830e2bb7f6128601d3df1c2be4b636259e7/internal/toolpermission/modes.go#L15
- Interazione di approvazione: https://github.com/omnara-ai/omnara/blob/0bf1d830e2bb7f6128601d3df1c2be4b636259e7/internal/toolpermission/interaction.go#L47
- Protocollo dei modelli: https://github.com/omnara-ai/omnara/blob/0bf1d830e2bb7f6128601d3df1c2be4b636259e7/internal/modelprotocol/modelprotocol.go#L12
- Risoluzione dei provider: https://github.com/omnara-ai/omnara/blob/0bf1d830e2bb7f6128601d3df1c2be4b636259e7/internal/modelprovider/resolver.go#L241
- Socket del daemon: https://github.com/omnara-ai/omnara/blob/0bf1d830e2bb7f6128601d3df1c2be4b636259e7/internal/machinedaemon/client_socket.go#L178
- Catalogo sandbox: https://github.com/omnara-ai/omnara/blob/0bf1d830e2bb7f6128601d3df1c2be4b636259e7/internal/machinepool/catalog.go#L29
- Esempio browser agent: https://github.com/omnara-ai/omnara/blob/0bf1d830e2bb7f6128601d3df1c2be4b636259e7/examples/browser-agent/agent.yaml#L37
- Release v0.2.3: https://github.com/omnara-ai/omnara/releases/tag/cluster-v0.2.3
- Release v0.2.2: https://github.com/omnara-ai/omnara/releases/tag/cluster-v0.2.2
- Issue streaming: https://github.com/omnara-ai/omnara/issues/502
- Issue resume legacy: https://github.com/omnara-ai/omnara/issues/514
- Issue turno appeso: https://github.com/omnara-ai/omnara/issues/368
- Issue popup: https://github.com/omnara-ai/omnara/issues/276
- Richiesta MCP stdio: https://github.com/omnara-ai/omnara/issues/469
