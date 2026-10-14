# Conductor

## In tre righe

Conductor è un'app Mac closed source che esegue in parallelo Claude Code, Codex, Cursor e OpenCode in workspace isolati, uno per branch, con diff viewer, Checks pre merge, PR e merge assistiti.
Rispetto a Topics, il suo punto più forte è la pipeline review to merge già matura: Checks tab con blocchi, stack di PR GitHub, automerge, più Conductor Cloud multiplayer con API e MCP per orchestrare i workspace dall'esterno.
Topics resta avanti su co browse Mac iPad e uso in LAN senza cloud, che in Conductor non esistono.

## Identità

Conductor è un prodotto closed source di Melty Labs, società Y Combinator Summer 2024 con sede a San Francisco [doc: https://www.conductor.build/brandkit]. Non esiste un repository pubblico da clonare, quindi niente stelle, niente SHA e niente misura sul codice: tutte le fonti sotto sono docs, changelog e pagine pubbliche.
L'ultima release citata è la 0.90.0 del 2 ottobre 2026, che introduce l'app iOS [release v0.90.0]. Il changelog mostra una cadenza quasi giornaliera, con decine di release tra luglio e ottobre 2026 [doc: https://www.conductor.build/changelog].
Piattaforme: app desktop solo macOS, app iOS, workspace cloud su sandbox remoti [doc: https://www.conductor.build/docs/installation]. Windows e Linux non sono supportati, esiste solo una lista d'attesa.
Piani: Free con workspace locali, Pro a 50 dollari al mese con cloud e mobile, Teams a 60 dollari al mese per utente, Enterprise con SSO e DPA [doc: https://www.conductor.build/pricing]. Ha completato audit SOC 2 Type II con penetration test annuali [doc: https://www.conductor.build/pricing].

## Architettura

Il modello centrale è: 1 progetto contiene 1 repository, 1 workspace mappa a 1 branch, 1 branch ha 1 working tree [doc: https://www.conductor.build/docs/concepts/workspaces-and-branches]. Ogni workspace è un git worktree creato sotto `~/conductor/workspaces/<repo>/<workspace>`, senza riclonare il repository [doc: https://www.conductor.build/docs/concepts/git-worktrees].
Ogni workspace ha branch, working tree, setup e run context, processi app e agent context propri [doc: https://www.conductor.build/docs/first-workspace]. Le impostazioni sono stratificate in tre livelli TOML: utente (`~/.conductor/settings.toml`), progetto condiviso (`.conductor/settings.toml` committato) e override locali (`.conductor/settings.local.toml`) [doc: https://www.conductor.build/docs/configure-your-project].
Gli script di progetto sono tre: setup dopo la creazione, run dal pulsante Run, archive prima dell'archiviazione, con `run_mode` concurrent o nonconcurrent [doc: https://www.conductor.build/docs/reference/scripts]. Ogni workspace locale riceve 10 porte a partire da `CONDUCTOR_PORT`, così più dev server girano affiancati [doc: https://www.conductor.build/docs/reference/environment-variables].
Il terminale usa il renderer Ghostty [release v0.62.0]. Il framework UI esatto è [non verificato]. Non risultano componenti Rust o Go documentati: [non verificato].
Conductor Cloud gira invece su sandbox Vercel con CPU 8 core, 16 GB RAM, Amazon Linux 2023, regione us-east-1 [doc: https://www.conductor.build/pricing].
Ogni organizzazione cloud condivide un Cloud Computer: repository, env, segreti e software installato, con build versionate da cui partono i nuovi workspace mentre quelli esistenti tengono l'ambiente di creazione [doc: https://www.conductor.build/docs/cloud].
La creazione di un workspace parte sempre dall'ultimo commit remoto del base branch dopo un fetch da origin, anche se il checkout locale è indietro [doc: https://www.conductor.build/docs/concepts/workspaces-and-branches].

## Sessioni e task

La regola decisionale è esplicita: workspace multipli per lavoro indipendente con branch e PR separati, più agenti nello stesso workspace quando serve condividere branch e contesto, per esempio uno implementa e uno fa review dello stesso diff [doc: https://www.conductor.build/docs/concepts/parallel-agents]. Ogni tab di chat usa un harness e un modello; più chat nello stesso workspace condividono branch e stato del codice [doc: https://www.conductor.build/docs/reference/harnesses].
I controlli di sessione includono Plan Mode per pianificare prima di modificare, Fast Mode per edit stretti, controlli di thinking e reasoning, personalities Codex e goal Codex persistenti via `/goal` con goal bar, pausa e budget token [doc: https://www.conductor.build/docs/concepts/agent-modes].
Il flusso di chiusura è: Diff Viewer con `Command + Shift + D`, azione `Review` da agente, Checks tab come ultimo passaggio, `Create PR` con `Command + Shift + P`, merge ad approvazione e check verdi, poi archive con ripristino da History [doc: https://www.conductor.build/docs/guides/review-and-merge]. I workspace si creano anche da branch, PR, issue GitHub o Linear [doc: https://www.conductor.build/docs/concepts/workflow].
Funzioni di orchestrazione: stack di PR GitHub con merge dello stack, workspace linkabili, routines che eseguono un prompt salvato in un fresh workspace a ogni chiamata webhook, CLI Conductor preinstallata nei cloud workspace, comandi queue con navigazione da tastiera [release v0.80.0] [doc: https://www.conductor.build/docs/api]. Non risulta una board kanban globale con code e land automatico come Topics: esiste Home con filtri per persona e progetto, Pinned e Following [doc: https://www.conductor.build/docs/cloud/collaboration].
Il model picker supporta ricerca modelli, effort levels e loadout condivisibili tra utenti [release v0.87.5] [release v0.86.0].
I workspace inattivi si archiviano e restano ripristinabili con la cronologia chat dalla History laterale [doc: https://www.conductor.build/docs/concepts/workflow].
La coda dei messaggi supporta invio mentre l'agente lavora, con steering dentro il turno corrente via API o MCP [doc: https://www.conductor.build/docs/api].

## Usabilità

Superfici: app Mac, app iOS, cloud via browser per link e API, niente TUI documentata [doc: https://www.conductor.build/docs/installation] [release v0.90.0].
Scorciatoie documentate: `Command + N` nuovo workspace, `Command + Shift + N` da branch o issue, `Command + Shift + D` diff, `Command + Shift + P` PR, `Cmd + Shift + B` browser preview, `Cmd + Shift + C` copia link, `Command-K` command palette, `⌘F` cerca in chat incluso il thinking [doc: https://www.conductor.build/docs/concepts/workflow] [release v0.90.0].
Il Diff Viewer offre vista unified o split, filtro per commit, mark as viewed, revert di file, commenti inline che diventano allegati del composer da rimandare all'agente, e thread di review GitHub risolvibili [doc: https://www.conductor.build/docs/reference/diff-viewer].
Onboarding guidato: setup checks su `gh auth status`, login Claude e Codex, Cursor API key, poi primo workspace [doc: https://www.conductor.build/docs/installation]. Notifiche che mostrano il titolo della chat invece del branch, indicatore di stato stile matrix, deep link con slug organizzazione e numero workspace [release v0.90.0].
I file `.context` degli agenti nei cloud workspace si sincronizzano sul Mac, e i pinned restano sincronizzati tra dispositivi nelle organizzazioni cloud [release v0.90.0].
La review guidata suggerisce azioni PR progressive: crea PR, rispondi ai feedback, fixa i check, fai merge a workspace pronto [doc: https://www.conductor.build/docs/reference/diff-viewer].

## Browser e anteprima

C'è una browser preview in app, nata come sperimentale sotto Settings, Experimental, In app Browser: rende una pagina localhost dentro Conductor e integra Agentation, così si clicca sulla UI, si lasciano note precise e si allegano al composer come contesto per l'agente [release v0.62.0].
Completano il quadro HTML preview, Markdown preview e file preview [release v0.55.0] [release v0.45.0]. Nei cloud workspace c'è Google Chrome preinstallato e un popover Forward ports per aprire i servizi remoti via localhost [release v0.80.0].
Non risulta che l'agente piloti il browser con tool dedicati, e non esiste nulla di simile al co browse Mac iPad di Topics: la preview serve verifica umana, con le annotazioni come ponte verso l'agente. Dettagli sul protocollo di pilotaggio: [non verificato].

## Terminale, editor, file

Ogni workspace ha terminali propri più pulsante Run per comandi salvati; i comandi girano nella directory del workspace, non nel checkout originale [doc: https://www.conductor.build/docs/first-workspace]. Esistono Big Terminal Mode, `@terminal` per allegare il terminale alla chat, e l'agente può leggere il terminale [release v0.48.0] [release v0.29.5]. Nei cloud workspace ci sono sia cloud terminal dentro la sandbox sia local terminal sul Mac nella cartella sincronizzata [doc: https://www.conductor.build/docs/cloud/working-with-cloud-workspaces].
Lato file: file explorer, file picker con @ mention anche nel composer di creazione, `.context` gitignored per handoff e note, Files to copy in stile `.worktreeinclude` per i file ignorati da Git, editor sperimentale Pierre con diff semantico e modifica diretta nei diff dalla 0.84.0 [doc: https://www.conductor.build/docs/concepts/git-worktrees] [release v0.84.0] [release v0.62.0].
Le shell dei run script sono non interattive, con pagina dedicata a configurazione shell e direnv [doc: https://www.conductor.build/docs/reference/scripts] [release v0.38.4].
Alla chiusura con Stop su macOS, Conductor manda SIGTERM al process group dello script e dopo cinque secondi SIGKILL, con gestione esplicita dei processi che cambiano gruppo [doc: https://www.conductor.build/docs/reference/scripts].
I run script multipli hanno ID stabile usato per riconciliare gli stessi script tra impostazioni utente, progetto e locali [doc: https://www.conductor.build/docs/reference/scripts].
I checkpoint sono snapshot automatici prima di ogni risposta dell'agente su ref Git privati, con revert a un turno precedente che cancella messaggi e codice successivi [doc: https://www.conductor.build/docs/reference/checkpoints].

## Remoto e mobile

Conductor Cloud esegue ogni agente nella sua sandbox cloud isolata con repo e dipendenze preinstallate, gli agenti continuano a lavorare a laptop chiuso, e workspace e chat sono condivisi con l'organizzazione [doc: https://www.conductor.build/docs/cloud]. Multiplayer: Home del team, chat condivise live con presence e typing, follow, Reassign to per l'handoff, link diretti [doc: https://www.conductor.build/docs/cloud/collaboration].
Accesso ai file remoti via SSH o sync unidirezionale cloud verso Mac, con terminali locali e cloud separati e port forwarding con mapping esplicito [doc: https://www.conductor.build/docs/cloud/working-with-cloud-workspaces].
L'app iOS permette chat con gli agenti e merge delle PR da telefono, solo su cloud workspace, con pinned sincronizzati tra dispositivi [release v0.90.0].
L'onboarding cloud guida GitHub App, scelta repository, credenziale agente con import da locale, e chiavi condivise di organizzazione che prevalgono su quelle personali [doc: https://www.conductor.build/docs/cloud/getting-started].
Le variabili ambiente cloud vivono sotto Organization con tab Personal e Shared, e la modifica non richiede rebuild del Cloud Computer [release v0.80.0].
I workspace locali restano nell'app Mac locale, senza accesso LAN da telefono come Topics: [doc: https://www.conductor.build/docs/cloud]. Limiti: sleep dopo 4 ore senza attività e lifetime massimo di 23 ore e 50 minuti, i processi non sopravvivono allo sleep [doc: https://www.conductor.build/docs/cloud/working-with-cloud-workspaces].

## Provider e protocolli

Harness supportati: Claude Code, Codex, Cursor e OpenCode; i primi tre sono bundled, Cursor gira via Cursor API senza eseguibile locale [doc: https://www.conductor.build/docs/reference/harnesses]. Autenticazione: Claude via subscription, CLI auth o `ANTHROPIC_API_KEY`, con provider compatibili via env come OpenRouter, Vercel AI Gateway, Bedrock; Codex via sign in, subscription o `CODEX_API_KEY`; OpenCode via chiavi dei suoi provider; Cursor via `CURSOR_API_KEY` [doc: https://www.conductor.build/docs/guides/providers]. Conductor non fattura l'uso modelli, si portano subscription e chiavi proprie [doc: https://www.conductor.build/docs/guides/providers].
Protocolli: Conductor API REST beta sotto `https://api.conductor.build/v0` con OpenAPI, paginazione e SQL in sola lettura sui transcript; MCP server ospitato a `https://api.conductor.build/mcp` con OAuth e 17 tool tra cui create workspace, send message, list messages e run SQL; supporto MCP per chat con popover che conta i tool per server [doc: https://www.conductor.build/docs/api] [doc: https://www.conductor.build/docs/api/mcp] [release v0.90.0]. Integrazioni GitHub, Linear e stack Graphite; skill riusabili tra Codex, Claude Code e OpenCode; supporto ACP: [non verificato].
I commit degli agenti via API sono attribuiti al chiamante, con mappa env passabile alla creazione [doc: https://www.conductor.build/docs/api].
Le chat Cursor avviano i server MCP dichiarati nel `.cursor/mcp.json` del repo [release v0.90.0].

## Performance

Dichiarato: sandbox cloud inizializzate da 1,5 a 3 volte più in fretta, apertura workspace più rapida, diff remoti che caricano i cambiamenti senza scaricare file interi, chat cloud lunghe molto più veloci dalla 0.90.1 [release v0.80.0] [release v0.90.0].
Lamentele e fix dai changelog: memory leak con memoria crescente a ogni turno fino al restart, fixato in 0.90.0; consumo CPU eccessivo già nel 2025 con release dedicata; più tornate di terminal performance e performance improvements ricorrenti; chat lunghe che saltano in alto e freezano dopo rimozione repository [release v0.90.0] [release v0.7.0] [release v0.10.3]. Nessun benchmark numerico pubblico oltre i fattori citati, e nessun uso documentato di Rust per la velocità. Concorrenza locale gestita con porte dedicate e run mode nonconcurrent per risorse singole come un database o una porta fissa [doc: https://www.conductor.build/docs/reference/scripts].

## Affidabilità e qualità

Checkpoint per turno con revert, chat summaries, ricerca nelle chat, archiviazione istantanea e ripristino da History con cronologia inclusa [doc: https://www.conductor.build/docs/reference/checkpoints] [release v0.46.0] [doc: https://www.conductor.build/docs/concepts/workflow]. La Checks tab raccoglie git status, metadati PR, CI, deployments, commenti e todos, e può bloccare il merge finché restano aperti [doc: https://www.conductor.build/docs/reference/checks]. File e cronologia sopravvivono a sleep e restart, i processi no e vanno rilanciati [doc: https://www.conductor.build/docs/cloud/working-with-cloud-workspaces]. Aggiornamenti con restart automatico che attende conferma se un run script gira o c'è un prompt non inviato [release v0.90.0]. Essendo closed source non sono disponibili numero di file di test, CI interna o metriche di crash: [non verificato].

## Sicurezza e privacy

Conductor dichiara che in locale i messaggi vanno diretti al provider del modello e i dati di sessione restano sul dispositivo, senza accesso da parte loro; in cloud le sessioni girano in sandbox gestite e gli input e output sono conservati sui loro server [doc: https://www.conductor.build/pricing]. L'isolamento dei workspace è esplicitamente development isolation, non un confine di sicurezza: agenti e comandi girano sul Mac con i permessi dell'utente [doc: https://www.conductor.build/docs/concepts/workspaces-and-branches].
Credenziali: CLI auth o subscription riutilizzate dove possibile, chiavi condivise di organizzazione che prevalgono su quelle personali, niente segreti in `.conductor/settings.toml` committato, valori locali in `settings.local.toml` da mettere in gitignore [doc: https://www.conductor.build/docs/guides/providers] [doc: https://www.conductor.build/docs/configure-your-project]. Controlli: tool approval, permessi GitHub fine grained, OAuth con PKCE, SSO e SCIM su Enterprise [release v0.41.0] [release v0.0.21] [release v0.80.0]. Telemetria dettagliata: [non verificato].

## Estendibilità

API REST con CLI, routine webhook che creano workspace freschi a ogni chiamata, e query SQL in sola lettura sui transcript per report [doc: https://www.conductor.build/docs/api]. MCP server ospitato con tool di gestione completa dei workspace cloud [doc: https://www.conductor.build/docs/api/mcp]. Script setup, run multipli con icone Lucide, archive e variabili custom locali o cloud via TOML versionato [doc: https://www.conductor.build/docs/reference/scripts]. Condivisione dei loadouts tra utenti, slash command, prompt personalizzabili, hooks, supporto direnv, skill riusabili tra agenti e skill di discovery per agenti esterni [release v0.86.0] [release v0.9.0] [release v0.38.4] [doc: https://www.conductor.build/docs/concepts/agent-modes]. Non risulta un marketplace di plugin: [non verificato].

## Da prendere per Topics

1. Checks tab pre merge con blocchi: raccoglie git status, CI, deployments, commenti e todos e scoraggia il merge finché restano aperti [doc: https://www.conductor.build/docs/reference/checks]. Per Topics significherebbe un gate esplicito prima del land della kanban.
2. Spotlight testing: un workspace alla volta viene sincronizzato nella root così lo stack pesante gira una volta sola con hot reload [doc: https://www.conductor.build/docs/reference/scripts/spotlight-testing]. Per Topics risolverebbe i progetti che non girano da worktree.
3. Range di 10 porte per workspace via `CONDUCTOR_PORT`: ogni topic con server propri senza conflitti [doc: https://www.conductor.build/docs/reference/environment-variables]. Per Topics è il pezzo mancante del run parallelo in LAN.
4. Setup, run e archive script versionati in `.conductor/settings.toml`: ogni repo dichiara come si installa, si avvia e si pulisce [doc: https://www.conductor.build/docs/reference/scripts]. Per Topics eliminerebbe la configurazione manuale per repo.
5. Checkpoint per turno su ref Git privati con revert di codice e conversazione [doc: https://www.conductor.build/docs/reference/checkpoints]. Per Topics darebbe undo granulare per topic.
6. Commenti inline sul diff che diventano allegati del composer per l'agente [doc: https://www.conductor.build/docs/reference/diff-viewer]. Per Topics collegherebbe review umana e agente senza copia incolla.
7. Goal persistenti tipo `/goal` di Codex con barra di stato e budget token [doc: https://www.conductor.build/docs/concepts/agent-modes]. Per Topics darebbe task long running senza prompt a ogni turno.
8. Routine webhook che avviano un workspace fresco da un prompt salvato [doc: https://www.conductor.build/docs/api]. Per Topics aprirebbe automazioni tipo triage notturno.
9. SQL in sola lettura sui transcript per report giornalieri su cosa hanno fatto gli agenti [doc: https://www.conductor.build/docs/api]. Per Topics è supervisione fleet a costo quasi zero.
10. Deep link con slug e numero workspace e copia link da tastiera [release v0.90.0]. Per Topics renderebbe i topic citabili da telefono e chat.

## Da evitare

1. Sleep che uccide i processi e lifetime massimo sotto le 24 ore: file e chat sopravvivono ma server e turni si interrompono [doc: https://www.conductor.build/docs/cloud/working-with-cloud-workspaces]. Da non copiare senza resume esplicito dei processi.
2. Sync cloud verso Mac unidirezionale che può sovrascrivere modifiche locali [doc: https://www.conductor.build/docs/cloud/working-with-cloud-workspaces]. Da evitare come modello di default.
3. Isolamento venduto come sandboxing quando gira con i permessi utente e non è un confine di sicurezza [doc: https://www.conductor.build/docs/concepts/workspaces-and-branches]. Rischio di promesse eccessive.
4. Storia di memory leak per turno e consumo CPU con fix ripetuti [release v0.90.0] [release v0.7.0]. Segnale di renderer o transcript che crescono senza bound.
5. Regola un branch per un worktree con errori e frizione quando due workspace vogliono lo stesso branch [doc: https://www.conductor.build/docs/concepts/workspaces-and-branches]. Serve UX di fallback, non solo errore Git.
6. API in beta con forme soggette a cambi e token workspace scoped da gestire [doc: https://www.conductor.build/docs/api]. Da non usare come contratto stabile.
7. Prezzi cloud compute a consumo annunciati ma non definiti [doc: https://www.conductor.build/pricing]. Rischio costi opachi se copiamo il modello cloud.
8. Solo macOS su desktop con Windows e Linux in lista d'attesa [doc: https://www.conductor.build/docs/installation]. Scelta che restringe il pubblico, per Topics già cross device via LAN.

## Fonti

- https://docs.conductor.build/
- https://www.conductor.build/docs/concepts/workspaces-and-branches
- https://www.conductor.build/docs/concepts/git-worktrees
- https://www.conductor.build/docs/concepts/workflow
- https://www.conductor.build/docs/concepts/parallel-agents
- https://www.conductor.build/docs/concepts/agent-modes
- https://www.conductor.build/docs/first-workspace
- https://www.conductor.build/docs/configure-your-project
- https://www.conductor.build/docs/reference/scripts
- https://www.conductor.build/docs/reference/scripts/spotlight-testing
- https://www.conductor.build/docs/reference/environment-variables
- https://www.conductor.build/docs/reference/diff-viewer
- https://www.conductor.build/docs/reference/checks
- https://www.conductor.build/docs/reference/checkpoints
- https://www.conductor.build/docs/reference/harnesses
- https://www.conductor.build/docs/guides/providers
- https://www.conductor.build/docs/guides/review-and-merge
- https://www.conductor.build/docs/guides/issue-to-pr
- https://www.conductor.build/docs/cloud
- https://www.conductor.build/docs/cloud/getting-started
- https://www.conductor.build/docs/cloud/working-with-cloud-workspaces
- https://www.conductor.build/docs/cloud/collaboration
- https://www.conductor.build/docs/api
- https://www.conductor.build/docs/api/mcp
- https://www.conductor.build/
- https://www.conductor.build/pricing
- https://www.conductor.build/brandkit
- https://www.conductor.build/changelog
- https://www.conductor.build/changelog/0.90.0-conductor-for-ios
- https://www.conductor.build/changelog/0.80.0-stacks
- https://www.conductor.build/changelog/0.62.0-repo-settings-browser-preview
