# Zed

## In tre righe
Zed è un editor di codice nativo ad alte prestazioni con pannello agenti integrato.
È pensato per sviluppatori che vogliono agente, LSP e collaborazione nella stessa finestra.
Il suo punto più forte rispetto a Topics è il protocollo ACP: ogni CLI di agente esterno diventa un pannello nativo con tool, terminali e permessi uniformi.

## Identità
- Repository `zed-industries/zed`, circa 91.700 stelle al 14 ottobre 2026 [doc: https://api.github.com/repos/zed-industries/zed].
- Licenza mista: sorgenti soprattutto GPL-3.0-or-later, con componenti Apache-2.0 dove marcato [README].
- Sviluppato da un'azienda for profit [README].
- Ultimo commit verificato il 14 ottobre 2026, SHA `e463c5a`, con fix sul ripristino delle conversazioni [doc: https://github.com/zed-industries/zed/commit/e463c5ab74e016f6a16e02a8b21925b98643f9c7].
- Stabile `v1.24.2` e pre-release `v1.25.0-pre` pubblicate lo stesso giorno, patch a pochi giorni di distanza: cadenza quasi settimanale [release v1.24.2].
- Progetto maturo, attivo dal 2021.
- Piattaforme desktop: macOS, Linux, Windows; la versione web non esiste ancora [README].

## Architettura
- Quasi tutto il codice è Rust: circa 63,5 MB contro frazioni di Python, shell e script [doc: https://api.github.com/repos/zed-industries/zed/languages].
- La UI usa GPUI, motore grafico interno al repo con backend per macOS, Linux, Windows e iOS [codice: Cargo.toml].
- Niente Tauri, niente Electron, niente webview: rendering nativo via GPU.
- Clone sparso limitato ai crate dell'agente e di ACP: `agent`, `agent_servers`, `agent_settings`, `agent_skills`, `agent_ui`, `acp_thread`, `acp_tools`, più `opencode`, `context_server`, `remote`, `collab`, `terminal`, `project`, `workspace` [codice: crates/].
- Nei crate agente/ACP/MCP/pannello si contano 146 file Rust per circa 239.700 righe misurate con `wc -l` [codice: crates/agent/src/tools.rs:199].
- Storage locale in SQLite: i thread vivono in `threads/threads.db` con tabella dedicata [codice: crates/agent/src/db.rs:446].
- La parte collaborativa usa crate dedicati (`collab`, `client`, `proto`, `rpc`) con server dedicato [codice: crates/collab/src/rpc.rs].
- Con l'agente si parla in tre modi: ACP via JSON-RPC su stdio verso processi figli [codice: crates/agent_servers/src/acp/transport.rs:25], tool nativi interni al thread, MCP come client verso context server esterni [codice: crates/context_server/src/protocol.rs:4].
- Rust è usato ovunque: editor, rope, query sintattiche, terminale, rete.

## Sessioni e task
- Ogni conversazione è un thread persistito in SQLite con riepilogo e metadati [codice: crates/agent/src/db.rs:446].
- Titolo modificabile e archiviazione inclusi nel pannello [codice: crates/agent_ui/src/thread_metadata_store.rs:309].
- I sub-agenti paralleli esistono: `spawn_agent` raccomanda insiemi di scrittura disgiunti e riusa la sessione tramite ID [codice: crates/agent/src/tools/spawn_agent_tool.rs:29].
- Il lavoro in worktree separata è supportato ma opt-in per thread, non il default [codice: crates/agent/src/thread.rs:843].
- Esiste un tool `create_thread` fra i 23 nativi: l'agente può aprire conversazioni da solo [codice: crates/agent/src/tools.rs:199].
- Non emerge nessuna board kanban, nessuna coda con tentativi, nessun land o merge: il flusso si ferma al diff inline da accettare o rifiutare [codice: crates/agent_ui/src/agent_diff.rs].
- Il task runner (`crates/task`) serve per build e debug, non per orchestrare agenti [non verificato].
- Rispetto a Topics, che lancia agenti in worktree con code, review, land e publish, Zed è superiore nel singolo thread e assente nell'orchestrazione.

## Usabilità
- Pannello agente dedicato con selettore di modelli, profili e opzioni [codice: crates/agent_ui/src/agent_panel.rs].
- Assistente inline nell'editor e assistente inline nel terminale [codice: crates/agent_ui/src/inline_assistant.rs].
- I diff del codice generato si revisionano nel buffer con accettazione selettiva [codice: crates/agent_ui/src/buffer_codegen.rs].
- Menzioni, editor del messaggio e import di thread completano il flusso [codice: crates/agent_ui/src/mention_set.rs].
- Notifiche, command palette e which-key coprono avvisi e scorciatoie [codice: crates/workspace/src/notifications.rs].
- Esiste un onboarding dedicato all'IA [codice: crates/agent_ui/src/agent_configuration.rs].
- Frizioni reali: il dialogo dello strumento domanda non mostra le opzioni [issue #65544].
- Le risposte si duplicano dopo la riconnessione ACP [issue #65587].
- Giudizio: scoperta e scorciatoie buone, robustezza del pannello migliorabile.

## Browser e anteprima
- Nessun browser integrato pilotabile dall'agente, niente co-browse fra dispositivi.
- L'agente legge il web via fetch di URL convertito in markdown, con limite di 20 redirect [codice: crates/agent/src/tools/fetch_tool.rs:28].
- Secondo canale: ricerca web dedicata fra i tool nativi [codice: crates/agent/src/tools.rs:222].
- Esiste un'anteprima markdown a schede, ma non è pilotata dall'agente e ha bug aperti su copia e omonimie [issue #65557] [issue #65528].
- L'unica condivisione visiva è `SharedScreen` per collaborare fra persone, non fra i dispositivi dello stesso utente [codice: crates/workspace/src/shared_screen.rs:17].
- Il testo di browser nel pannello compare solo per il login OAuth esterno [codice: crates/agent_ui/src/conversation_view.rs:9948].
- Su questo punto Topics, con WKWebView nativo, co-browse Mac-iPad e 15 tool di pilotaggio, è nettamente avanti.

## Terminale, editor, file
- Terminale PTY integrato basato su Alacritty, con apertura PTY nativa [codice: crates/terminal/src/terminal.rs].
- L'agente nativo dispone di 23 tool: lettura, scrittura, modifica, grep, diagnostica [codice: crates/agent/src/tools.rs:199].
- Azioni LSP come definizioni, riferimenti e code action sono tool a sé [codice: crates/agent/src/tools.rs:210].
- Operazioni su path, terminale anche in sandbox, fetch, ricerca web, spawn di sub-agenti, skill [codice: crates/agent/src/tools.rs:214].
- La modifica file passa per diff revisionabili [codice: crates/agent_ui/src/agent_diff.rs].
- L'editor è il cuore del progetto: buffer multipli, LSP, simboli, git integrato nel crate dedicato [codice: crates/].
- Il terminale remoto segue la shell del server, con problemi noti su PowerShell e Nushell che troncano l'output [issue #65568] [issue #65575].
- Rispetto a Topics manca solo il ponte fra terminale PTY e browser pilotabile.

## Remoto e mobile
- Sviluppo remoto via SSH verso un server headless dedicato [codice: crates/remote_server/src/server.rs:1192].
- Supporto anche per WSL, Docker e SSH come opzioni di connessione [codice: crates/remote/src/remote_client.rs:1361].
- Collaborazione multiplayer in tempo reale con canali e schermo condiviso [codice: crates/collab/src/rpc.rs].
- Nessun accesso da telefono o tablet, nessun relay LAN verso mobile.
- Topics con l'uso in LAN da iPad copre un caso che Zed non copre.
- Il crate `gpui_ios` esiste nel manifest ma non risulta un'app mobile distribuita [non verificato].
- I mount readonly dei container risultano ignorati in un bug aperto: cautela per chi isola gli agenti così [issue #65567].

## Provider e protocolli
- Il pannello agenti parla ACP in modo nativo: ID integrati per Gemini, Claude, Codex e Cursor [codice: crates/agent_servers/src/custom.rs:17].
- Il registry aggiunge opencode, mistral-vibe, auggie, stakpak, codebuddy-code, factory-droid e altri [codice: crates/project/src/agent_server_store.rs:198].
- Gli agenti da registry si installano come binari versionati o via npx [codice: crates/agent_servers/src/custom.rs:260].
- Qualunque comando esterno che parli ACP diventa un server agente personalizzato lanciato su stdio [codice: crates/agent_servers/src/acp/transport.rs:25].
- La versione di protocollo è negoziata all'inizializzazione [codice: crates/agent_servers/src/acp.rs:1026].
- OpenCode è integrato anche come gateway cloud con streaming SSE e protocolli Anthropic, OpenAI e Google [codice: crates/opencode/src/opencode.rs:14].
- Sul lato MCP, Zed è client, non server: stdio e HTTP Streamable fino alla versione 2025-11-25 [codice: crates/context_server/src/types.rs:8].
- Restano i modelli ospitati su infrastruttura propria tramite client cloud [codice: crates/cloud_llm_client/src/cloud_llm_client.rs:15].
- Topics è speculare: ha un server MCP ma parla coi CLI via `claude -p`; adottare ACP colmerebbe il divario.

## Performance
- Tutto nativo e GPU, con strutture dati persistenti per il testo e bench dedicati per editor e progetto [codice: crates/].
- Le dichiarazioni di superiorità stanno nel README, senza numeri riproducibili nel codice letto [non verificato].
- Memoria alta e sospetti leak su macOS segnalati dagli utenti [issue #64009] [issue #63826] [issue #59915].
- Avvio lento su macOS e Windows [issue #60661] [issue #49442].
- Ricerca lenta sui contenuti e Ollama lento [issue #58905] [issue #31788].
- Lo streaming delle risposte è nativo nel thread.
- Il ripristino delle conversazioni è ottimizzato di recente, fino al fix sullo stallo del focus all'avvio [doc: https://github.com/zed-industries/zed/commit/e463c5ab74e016f6a16e02a8b21925b98643f9c7].
- Il Rust paga su rendering ed editing, meno sui problemi classici di memoria e avvio che restano aperti.

## Affidabilità e qualità
- Pochi file di test dedicati nei crate agente: test dei tool, test end-to-end dei server, supporti per il pannello [codice: crates/agent/src/tests/test_tools.rs] [codice: crates/agent_servers/src/e2e_tests.rs].
- In compenso il file dei permessi contiene un'ampia suite di casi su bypass e traversal [codice: crates/agent/src/tool_permissions.rs:831].
- La CI gira test automatici su ogni commit [README].
- Le sessioni sopravvivono al riavvio via SQLite e il ripristino riceve fix continui [codice: crates/agent/src/db.rs:14].
- Aggiornamento automatico con crate dedicati [codice: crates/].
- Il reporting dei crash ha un crate apposito, dettagli non verificati nei file letti [non verificato].
- I segnali peggiori sono la duplicazione dopo riconnessione [issue #65587] e il contenuto MCP perso [issue #65598].

## Sicurezza e privacy
- Segreti nel portachiavi di sistema: sessioni OAuth dei context server e API key caricate dal keychain [codice: crates/context_server/src/oauth.rs:15] [codice: crates/agent_servers/src/custom.rs:302].
- I terminali degli agenti girano in sandbox su macOS, Linux e Windows [codice: crates/agent/src/sandboxing.rs:94].
- Rete configurabile a tre livelli: nessuno, allowlist, tutto [codice: crates/acp_thread/src/terminal.rs:24].
- Regole hardcoded non scavalcabili bloccano cancellazioni distruttive con varianti, traversal e concatenazioni malevole [codice: crates/agent/src/tool_permissions.rs:25].
- Le scritture restano dentro le radici della worktree e `.git` è sempre protetto [codice: crates/agent/src/sandboxing.rs:94].
- La telemetria registra eventi degli assistenti con modello, latenza ed errori [codice: crates/telemetry_events/src/telemetry_events.rs:111].
- Lo stato opt-in della telemetria non è stato verificato nei file letti [non verificato].
- Le credenziali dei CLI esterni restano ai CLI stessi, lanciati come processi figli: riuso lecito del login esistente [codice: crates/agent_servers/src/acp/transport.rs:25].

## Estendibilità
- Estensioni su API stabile e versionata: language server, comandi slash, context server, adattatori di debug [codice: crates/extension_api/src/extension_api.rs:75].
- Qualunque server MCP esterno diventa contesto e tool per gli agenti [codice: crates/context_server/src/protocol.rs:4].
- Le skill seguono la convenzione `.agents/skills` con limite di 100 KB [codice: crates/agent_skills/agent_skills.rs:13].
- La libreria di prompt utente usa template sovrascrivibili dal filesystem [codice: crates/prompt_store/src/prompts.rs:223].
- Profili agente e permessi tool configurabili per strumento [codice: crates/agent/src/tools.rs:190].
- Dettagli su temi e linguaggi dichiarativi nelle estensioni non verificati nei file letti [non verificato].
- Manca, rispetto a Topics, un server MCP esposto verso l'esterno: Zed consuma, non serve.

## Da prendere per Topics
- ACP verso i CLI esterni: lanciarli come processi figli su stdio darebbe streaming, terminali e comandi uniformi [codice: crates/agent_servers/src/acp/transport.rs:25]. Unificherebbe i tre provider dietro un'unica astrazione.
- Registry di agent server con install via npx o binario versionato [codice: crates/project/src/agent_server_store.rs:198]. Aggiungere provider senza ricompilare.
- Comando agente personalizzato configurabile con env extra [codice: crates/agent_servers/src/custom.rs:260]. Aprirebbe a qualunque wrapper futuro in una riga di config.
- Regole di sicurezza hardcoded non scavalcabili con ampia suite sui bypass [codice: crates/agent/src/tool_permissions.rs:25]. Il modello da copiare per i 15 tool del browser.
- Sandbox dei terminali con rete a tre livelli e path scrivibili dichiarati [codice: crates/acp_thread/src/terminal.rs:24]. Ridurrebbe il rischio del PTY esposto in LAN.
- Sub-agenti paralleli con insiemi di scrittura disgiunti [codice: crates/agent/src/tools/spawn_agent_tool.rs:29]. La regola di parallelismo che manca nella kanban.
- Thread in SQLite con riepilogo, titolo e archivio [codice: crates/agent/src/db.rs:446]. Sessioni interrogabili senza parsing di JSON.
- Negoziazione di versione MCP con header dedicato [codice: crates/context_server/src/types.rs:8]. Eviterebbe rotture silenziose col server MCP di Topics.
- Segreti solo nel portachiavi di sistema [codice: crates/context_server/src/oauth.rs:15]. Per un servizio sulla 3333 è il punto più urgente.
- Fasi di risposta tracciate come accettata o rifiutata con latenza e modello [codice: crates/telemetry_events/src/telemetry_events.rs:111]. Metriche di review per agente quasi gratis.

## Da evitare
- Duplicare le risposte dopo riconnessione del canale agente [issue #65587]. Serve idempotenza sugli update prima di qualunque reconnect.
- Perdere il contenuto delle risorse MCP nei risultati dei tool [issue #65598]. Meglio un errore esplicito che un contesto silenziosamente vuoto.
- Troncare l'output quando la shell remota non è POSIX [issue #65568] [issue #65575]. Normalizzare shell ed encoding prima di parsare.
- Copiare codice oltre le 5 righe: la licenza è GPL copyleft [README]. Descrivere e reimplementare, mai incollare.
- Inseguire la parità di funzioni con 63 MB di Rust: la strada economica è parlare ACP coi CLI, non riscrivere l'editor.
- Ignorare i mount readonly dei container [issue #65567]. Se si isola con container, verificare che i vincoli siano applicati davvero.

## Fonti
- https://github.com/zed-industries/zed/blob/e463c5ab74e016f6a16e02a8b21925b98643f9c7/crates/agent/src/tools.rs#L199
- https://github.com/zed-industries/zed/blob/e463c5ab74e016f6a16e02a8b21925b98643f9c7/crates/agent/src/db.rs#L446
- https://github.com/zed-industries/zed/blob/e463c5ab74e016f6a16e02a8b21925b98643f9c7/crates/agent/src/tool_permissions.rs#L25
- https://github.com/zed-industries/zed/blob/e463c5ab74e016f6a16e02a8b21925b98643f9c7/crates/agent_servers/src/custom.rs#L17
- https://github.com/zed-industries/zed/blob/e463c5ab74e016f6a16e02a8b21925b98643f9c7/crates/agent_servers/src/acp/transport.rs#L25
- https://github.com/zed-industries/zed/blob/e463c5ab74e016f6a16e02a8b21925b98643f9c7/crates/project/src/agent_server_store.rs#L198
- https://github.com/zed-industries/zed/blob/e463c5ab74e016f6a16e02a8b21925b98643f9c7/crates/context_server/src/types.rs#L8
- https://github.com/zed-industries/zed/blob/e463c5ab74e016f6a16e02a8b21925b98643f9c7/crates/opencode/src/opencode.rs#L14
- https://github.com/zed-industries/zed/blob/e463c5ab74e016f6a16e02a8b21925b98643f9c7/crates/agent/src/tools/spawn_agent_tool.rs#L29
- https://github.com/zed-industries/zed/blob/e463c5ab74e016f6a16e02a8b21925b98643f9c7/crates/context_server/src/oauth.rs#L15
- https://github.com/zed-industries/zed/blob/e463c5ab74e016f6a16e02a8b21925b98643f9c7/README.md
- [release v1.24.2] https://github.com/zed-industries/zed/releases/tag/v1.24.2
- [issue #65587] https://github.com/zed-industries/zed/issues/65587
- [issue #65598] https://github.com/zed-industries/zed/issues/65598
- [issue #65568] https://github.com/zed-industries/zed/issues/65568
- [issue #65575] https://github.com/zed-industries/zed/issues/65575
- [issue #65557] https://github.com/zed-industries/zed/issues/65557
- [issue #64009] https://github.com/zed-industries/zed/issues/64009
- [issue #63826] https://github.com/zed-industries/zed/issues/63826
- [issue #60661] https://github.com/zed-industries/zed/issues/60661
- [issue #49442] https://github.com/zed-industries/zed/issues/49442
- [doc: https://api.github.com/repos/zed-industries/zed]
- [doc: https://api.github.com/repos/zed-industries/zed/languages]
