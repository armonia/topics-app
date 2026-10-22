# Claude Code (app desktop e CLI)

## In tre righe
Claude Code è lo strumento di coding agentico di Anthropic: legge il codice, modifica file, esegue comandi e si integra con gli strumenti di sviluppo, su terminale, IDE, app desktop e web [doc: https://code.claude.com/docs/en/overview].
Serve sviluppatori singoli e team che vogliono delegare feature, bugfix e automazioni ripetitive in linguaggio naturale, con lo stesso motore su ogni superficie [doc: https://code.claude.com/docs/en/overview].
Il punto più forte rispetto a Topics: un ecosistema maturo e unico (sessioni parallele con worktree, anteprima browser con autoverifica, hook, skill, MCP, Remote Control, cloud) tenuto insieme da una release quasi giornaliera e da una CLI nativa già installabile ovunque [doc: https://code.claude.com/docs/en/changelog].

## Identità
Prodotto di Anthropic, closed source: il binario si installa, i sorgenti di CLI e app non sono pubblicati. Esiste un repository pubblico che ospita changelog e descrizione del prodotto [release v2.1.299].
Il repository pubblico conta circa 150.000 stelle, segno di adozione molto ampia (rilevato via API GitHub in sola lettura il giorno dello studio).
Nessun file di licenza open source nel repository (API GitHub restituisce licenza nulla), quindi riuso di codice escluso: vale solo la documentazione.
Ultimo commit sul repository pubblico in data 2026-10-14, stesso giorno della release più recente, segnale di sviluppo attivo [release v2.1.299].
Ultime release: v2.1.299 (2026-10-14, latest), v2.1.296 (2026-10-09), v2.1.295 e v2.1.294 (2026-10-08), v2.1.293 (2026-10-07): cadenza quasi giornaliera con decine di fix per versione [release v2.1.299].
La CLI 2.1.299 è installata in locale (binario nativo, commit c416f56ec7ec, piattaforma darwin-arm64, canale latest, auto-aggiornamento attivo): rilevato con `claude --version` e `claude doctor` [doc: https://code.claude.com/docs/en/cli-reference].
Piattaforme: macOS, Linux, WSL, Windows (installazione nativa, Homebrew, WinGet, apt/dnf/apk), app desktop per macOS/Windows/Linux beta, estensioni VS Code e JetBrains, web su claude.ai/code, app mobili iOS/Android [doc: https://code.claude.com/docs/en/overview].
Serve quasi solo con abbonamento Claude o account Console API; solo CLI terminale, VS Code e JetBrains accettano anche provider terzi [doc: https://code.claude.com/docs/en/overview].
Maturità alta: changelog con centinaia di voci per release, checkup `claude doctor` e `/doctor`, pagina di troubleshooting dedicata all'installazione [doc: https://code.claude.com/docs/en/changelog].

## Architettura
Stesso motore Claude Code su ogni superficie (terminale, VS Code, JetBrains, desktop, web): CLAUDE.md, impostazioni e server MCP del repository funzionano ovunque senza riconfigurazione [doc: https://code.claude.com/docs/en/overview].
La CLI è un binario nativo (misurato in locale: circa 236 MB per la versione 2.1.299 su darwin-arm64): installazione via script, Homebrew (canale stable in ritardo di circa una settimana, oppure latest), WinGet senza auto-update [doc: https://code.claude.com/docs/en/overview].
Le installazioni native si aggiornano da sole in background; Homebrew e WinGet richiedono aggiornamento manuale [doc: https://code.claude.com/docs/en/overview].
La CLI parla con l'agente in tre modi: sessione interattiva nel terminale, modalità non interattiva `claude -p` (pensata per pipe Unix, CI e script), Agent SDK per orchestrazione programmatica completa [doc: https://code.claude.com/docs/en/cli-reference].
L'output di `-p` ha tre formati: text, json e stream-json, con eventi di lifecycle degli hook e messaggi parziali opzionali per chi costruisce sopra [doc: https://code.claude.com/docs/en/cli-reference].
Le sessioni in background girano sotto un processo supervisore separato (`claude daemon`, log in `~/.claude/daemon.log`), così sopravvivono alla chiusura del terminale e agli aggiornamenti [doc: https://code.claude.com/docs/en/agent-view].
Stato locale in `~/.claude/` (skill, transcript, cache) e `~/.claude.json` (progetti, server MCP, approvazioni); le sessioni cloud girano invece in VM isolate gestite da Anthropic [doc: https://code.claude.com/docs/en/security].
L'app desktop ha tre schede (Chat, Cowork, Code) e la scheda Code è il riferimento per lo sviluppo: ogni conversazione è una sessione con cronologia e cartella proprie [doc: https://code.claude.com/docs/en/desktop].
Nessun uso documentato di Rust o Go nelle pagine lette: dove il runtime sia nativo e con quale effetto resta [non verificato].
Nessuna IPC documentata fra processi oltre il supervisore delle sessioni background e il server MCP esposto via `claude mcp serve` [doc: https://code.claude.com/docs/en/cli-reference].

## Sessioni e task
La vista agenti (`claude agents`) mostra tutte le sessioni background in una schermata: raggruppate per stato (da revisionare, in attesa di input, al lavoro, completate), con riepiloghi generati da modello leggero, peek con `Spazio` e attach con `Invio` [doc: https://code.claude.com/docs/en/agent-view].
Nuove sessioni si lanciano dalla vista agenti, da shell con `claude --bg "compito"`, da dentro una sessione con `/background`, oppure come copia indipendente con `/fork` [doc: https://code.claude.com/docs/en/agent-view].
Ogni prompt digitato nella vista agenti avvia una sessione nuova, mai un follow-up: il parallelismo è esplicito per riga [doc: https://code.claude.com/docs/en/agent-view].
Le righe si filtrano per agente, stato, nome, risultato o numero di PR, si pinnano, rinominano e riordinano; l'eliminazione chiede doppia conferma ravvicinata [doc: https://code.claude.com/docs/en/agent-view].
L'isolamento dei file usa git worktree: `claude --worktree nome` crea `.claude/worktrees/nome/` su un ramo dedicato, con pulizia guidata all'uscita e `.worktreeinclude` per copiare `.env` e simili [doc: https://code.claude.com/docs/en/worktrees].
Durante l'isolamento quattro controlli bloccano edit fuori worktree, comandi con working directory esterna, redirect git verso il checkout principale e comandi dalla forma non analizzabile [doc: https://code.claude.com/docs/en/worktrees].
Anche i sottoagenti possono girare in worktree propri (`isolation: worktree` nel frontmatter), con sweep periodica che rimuove i worktree vecchi senza lavoro pendente [doc: https://code.claude.com/docs/en/worktrees].
Niente kanban globale come quella di Topics: il coordinamento di molti thread cloud paralleli è affidato ai Projects, dove Claude avvia e segue le sessioni da una conversazione [doc: https://code.claude.com/docs/en/agent-view].
Review del codice su due livelli: `/code-review` locale (subagente background, fix con `--fix`, commento su PR con `--comment`) e servizio gestito con agenti multipli, severità e commenti inline [doc: https://code.claude.com/docs/en/code-review].
Il monitoraggio PR in desktop usa la CLI `gh`: barra di stato CI, auto-fix dei check falliti, auto-merge squash e archiviazione automatica a PR chiusa [doc: https://code.claude.com/docs/en/desktop].
CI propria via GitHub Actions, GitLab CI/CD e GitHub App dedicata; i task ricorrenti usano Routines (cloud), task schedulati desktop o `/loop` in sessione [doc: https://code.claude.com/docs/en/overview].

## Usabilità
Superfici: terminale TUI, VS Code (diff inline, mention, revisione dei piani, cronologia), JetBrains, app desktop, web, mobile come client: nessuna TUI separata oltre la CLI [doc: https://code.claude.com/docs/en/overview].
Il flusso desktop guida prima dell'invio: ambiente (locale, cloud, SSH, WSL), cartella, modello e modo di permesso si scelgono nella casella di prompt [doc: https://code.claude.com/docs/en/desktop].
I modi di permesso commutano in sessione (Manuale, Accetta modifiche, Piano, Auto, Bypass): si parte in Piano per farsi proporre l'approccio, poi si esegue [doc: https://code.claude.com/docs/en/desktop].
La diff view mostra statistiche per file, commenti per riga con invio cumulativo e passeggiata guidata dei finding di `/code-review` con fix mirati o massivi [doc: https://code.claude.com/docs/en/desktop].
Le modalità di vista (Normale, Pensiero, Verbosa con `Ctrl+O`) regolano il dettaglio del transcript senza cambiare il lavoro [doc: https://code.claude.com/docs/en/desktop].
Scorciatoie complete e visibili con `Cmd+/`, più suggerimento del prossimo prompt generato in background (accettabile con `Tab`) [doc: https://code.claude.com/docs/en/desktop].
Notifiche OS a fine task, titolo del tab con conteggio degli agenti in attesa, push su telefono via Remote Control e campanella del terminale configurabile [doc: https://code.claude.com/docs/en/agent-view].
Onboarding: quickstart per superficie, guide per terminale, `/doctor` che diagnostica e ripara installazione, estensioni, CLAUDE.md e permessi [doc: https://code.claude.com/docs/en/overview].
Side chat (`Cmd+;` o `/btw`) per domande che usano il contesto senza deviare la conversazione principale [doc: https://code.claude.com/docs/en/desktop].
Messaggi fra sessioni in linguaggio naturale ("di alla sessione pagamenti che lo schema è cambiato") con card di provenienza e controlli inbound per destinatario [doc: https://code.claude.com/docs/en/desktop].

## Browser e anteprima
La scheda Code ha un pannello Browser integrato: Claude avvia il dev server, apre l'app, fa screenshot, ispeziona il DOM, clicca, compila form e corregge da solo ciò che trova [doc: https://code.claude.com/docs/en/desktop].
La configurazione dei server sta in `.claude/launch.json` (comando, argomenti, porta, env) e `autoVerify` rende la verifica automatica dopo ogni modifica [doc: https://code.claude.com/docs/en/desktop].
Il pannello apre anche siti esterni con login, ma lì scattano controlli extra: classificatori di sicurezza sulle scritture, allowlist di domini e approvazione per sito (una volta o sempre) [doc: https://code.claude.com/docs/en/desktop].
L'integrazione Chrome (`claude --chrome` più estensione) condivide invece il login del browser personale: ideale per app autenticate, test di flussi, console log, upload ed estrazione dati [doc: https://code.claude.com/docs/en/chrome].
La scelta fra i due è esplicita: pannello Browser con profilo pulito per costruire e testare, estensione Chrome quando serve agire con l'identità dell'utente [doc: https://code.claude.com/docs/en/desktop].
Computer use (preview di ricerca) apre app native, clicca e digita sullo schermo reale: su CLI solo macOS, su desktop macOS e Windows, con approvazione per app e livelli fissi (browser sola vista, terminali solo click, resto controllo pieno) [doc: https://code.claude.com/docs/en/computer-use].
Su desktop esiste anche un riquadro dedicato al simulatore iOS, separato dal controllo schermo [doc: https://code.claude.com/docs/en/desktop].
Niente co-browse fra dispositivi alla Topics: Remote Control e app mobile specchiano la conversazione e lo stato dei task, non il DOM di una pagina [non verificato].
Registrazione GIF delle interazioni browser e salvataggio screenshot su disco completano il ciclo di verifica visiva [doc: https://code.claude.com/docs/en/chrome].

## Terminale, editor, file
Il terminale integrato del desktop si apre con `Ctrl+\`` nella directory della sessione e condivide l'ambiente con Claude: `npm test` o `git status` vedono gli stessi file [doc: https://code.claude.com/docs/en/desktop].
Il riquadro file apre i path citati in chat, permette ritocchi con Salva, avvisa se il file è cambiato su disco e copia il path assoluto dall'intestazione [doc: https://code.claude.com/docs/en/desktop].
Ogni path ha menu contestuale: allega come contesto, apri in VS Code/Cursor/Zed, mostra in Finder/Explorer, copia path [doc: https://code.claude.com/docs/en/desktop].
I pannelli (chat, diff, browser, terminale, file, piano, task, subagenti) si trascinano, ridimensionano e staccano in finestre separate [doc: https://code.claude.com/docs/en/desktop].
In CLI il lavoro su file e shell passa dai tool (Bash, Edit, Read) sotto permesso o sandbox, con blocchi hook prima e dopo ogni chiamata [doc: https://code.claude.com/docs/en/hooks].
Nessun editor custom proprietario: l'editing pesante è delegato agli IDE esterni o ai loro plugin, Claude resta orchestratore [doc: https://code.claude.com/docs/en/overview].

## Remoto e mobile
Remote Control collega claude.ai/code o l'app mobile a una sessione che gira sul proprio computer: esecuzione e filesystem restano locali, la web view è solo una finestra [doc: https://code.claude.com/docs/en/remote-control].
Tre avvii: `claude remote-control` (server multi-sessione con QR e URL), `claude --remote-control` (sessione interattiva più controllo remoto), `/remote-control` da sessione esistente [doc: https://code.claude.com/docs/en/remote-control].
Il server accetta `--spawn` (stessa directory, worktree o sessione singola), `--capacity` (default 32), `--create-session-in-dir` e modo di permesso iniziale [doc: https://code.claude.com/docs/en/remote-control].
La connessione è solo HTTPS in uscita, niente porte in ingresso; più credenziali brevi e mirate limitano il danno in caso di compromissione [doc: https://code.claude.com/docs/en/remote-control].
Il computer deve restare acceso col processo attivo (su SSH usare tmux/screen); dopo sleep o caduta di rete la riconnessione è automatica [doc: https://code.claude.com/docs/en/remote-control].
Auto-connect per ogni sessione via `/config` o `remoteControlAtStartup`, disattivabile per repository così un file versionato non lo accende a tutti [doc: https://code.claude.com/docs/en/remote-control].
Le sessioni cloud invece girano su infrastruttura Anthropic (o self-hosted con runner propri) e continuano a computer spento; `claude --teleport` le riporta nel terminale [doc: https://code.claude.com/docs/en/overview].
L'app mobile (stessa app Claude per iOS/Android, scheda Code) raggiunge sessioni cloud, Projects, Remote Control e Dispatch: niente app separata [doc: https://code.claude.com/docs/en/mobile].
Da telefono si avviano cloud session, si guida la sessione locale, si ricevono push a fine task o su richiesta; mancano Bypass permessi e comandi solo-terminali come `/plugin` e `/resume` [doc: https://code.claude.com/docs/en/mobile].
Dispatch decide da un messaggio se aprire una sessione Code (badge dedicato, notifiche push, approvazioni che scadono ogni 30 minuti sotto computer use) [doc: https://code.claude.com/docs/en/desktop].
Altri canali verso la macchina locale: Channels (Telegram, Discord, iMessage, webhook via plugin MCP) e `@Claude` in Slack che restituisce PR [doc: https://code.claude.com/docs/en/overview].
Niente accesso LAN diretto come Topics: tutto il remoto passa dal cloud di Anthropic con account claude.ai, mai da un server sulla rete locale [doc: https://code.claude.com/docs/en/remote-control].

## Provider e protocolli
Modelli Claude con alias (`sonnet`, `opus`, `haiku`, `fable`), scelta per sessione via `--model` o menu, fallback automatico multiplo e livelli di effort fino a `max` e `ultracode` [doc: https://code.claude.com/docs/en/cli-reference].
Provider terzi (Bedrock, Agent Platform di Google, Foundry) solo da CLI, VS Code e JetBrains; Chrome, computer use e Remote Control restano esclusi senza account diretto [doc: https://code.claude.com/docs/en/chrome].
MCP ovunque: trasporti HTTP (raccomandato), SSE deprecato con fallback automatico, WebSocket per eventi push, stdio locale, più server in-process solo per host SDK e desktop [doc: https://code.claude.com/docs/en/mcp].
Tre scope di installazione (locale nel progetto, progetto condiviso via `.mcp.json`, utente globale) più distribuzione centralizzata via managed settings [doc: https://code.claude.com/docs/en/mcp].
La chat di Topics che usa `claude -p` in stream-json corrisponde alla modalità non interattiva ufficiale, con formati text/json/stream-json e SDK tipizzato [doc: https://code.claude.com/docs/en/cli-reference].
Nessun supporto documentato ad ACP o a Codex/Gemini/OpenCode come engine: Claude Code parla solo con modelli Anthropic o i provider terzi elencati [non verificato].
I connettori directory (Notion, Slack, GitHub, Linear e altri) sono server MCP con setup grafico e OAuth da `/mcp` o `claude mcp login` [doc: https://code.claude.com/docs/en/mcp].

## Performance
Avvio rapido via `--bare` (salta hook, skill, plugin, MCP, memoria e CLAUDE.md) per chiamate scriptate; `--safe-mode` isola i problemi di configurazione senza toccare auth e permessi [doc: https://code.claude.com/docs/en/cli-reference].
Compattazione idle: una conversazione da oltre 200K token lasciata ferma circa 54 minuti si compatta prima della scadenza della cache di un'ora, così il messaggio dopo non riprocessa tutto [release v2.1.299].
Riepiloghi di riga nella vista agenti via modello leggero, con aggiornamenti testuali ogni 15 secondi senza nuove request fra un rewrite e l'altro [doc: https://code.claude.com/docs/en/agent-view].
Cache di discovery MCP: tool list da cache con connessione alla prima chiamata, disattivabile via env [doc: https://code.claude.com/docs/en/mcp].
Limiti anti-esplosione: output MCP troncato con soglie configurabili, chiamate lunghe spostate in background dopo due minuti, timeout per server e per idle [doc: https://code.claude.com/docs/en/mcp].
Nessun benchmark ufficiale di avvio, memoria o rendering trovato nelle pagine lette: la sezione performance del changelog riporta fix (crescita memoria con debug log, picchi su sessioni cloud) non numeri [release v2.1.299].
Liste e transcript restano fluidi via collaps dei tool call e highlight con cache; allegati PDF citati senza tenere i byte in transcript [release v2.1.299].
Il lavoro background (subagenti, shell, workflow) vive nel supervisore e sopravvive a sleep e auto-update; solo lo shutdown ferma le sessioni [doc: https://code.claude.com/docs/en/agent-view].

## Affidabilità e qualità
Persistenza pervasiva: transcript su disco, `claude --continue/--resume`, fork con nuovo ID, stato delle sessioni background oltre update e sleep [doc: https://code.claude.com/docs/en/agent-view].
Dopo uno shutdown le sessioni risultano fallite o ferme ma il transcript resta e si riprende con `claude --resume`; `/compact` libera contesto su richiesta [doc: https://code.claude.com/docs/en/desktop].
Il servizio di review cloud è best-effort dichiarato: un run fallito non blocca mai la PR e si rilancia con commento o Re-run [doc: https://code.claude.com/docs/en/code-review].
Aggiornamenti nativi automatici in background; canale stable Homebrew in ritardo di una settimana per saltare release con regressioni gravi [doc: https://code.claude.com/docs/en/overview].
Essendo closed source non si contano file di test né CI pubblica: qualità inferita da cadenza release e ampiezza dei fix (131 bugfix nella sola 2.1.299) [release v2.1.299].
Qualità dei dati: redazione dei segreti nei transcript condivisi e nei log, fix su percorsi con symlink, sandbox macOS e worktree con junction Windows [release v2.1.299].
Diagnostica integrata: `claude doctor` da terminale per installazione e impostazioni, `/doctor` in sessione con fix guidati, `/config` per audit permessi [doc: https://code.claude.com/docs/en/cli-reference].
Il cleanup (`claude purge`, sweep transcript e worktree) evita accumulo di stato morto su disco [doc: https://code.claude.com/docs/en/cli-reference].

## Sicurezza e privacy
Modi di permesso a grana crescente con Manuale di default prudente: chiede prima di modificare file o eseguire comandi, con diff visibile [doc: https://code.claude.com/docs/en/desktop].
Auto mode con classificatore dedicato che approva o blocca shell e rete; Bypass equivale a `--dangerously-skip-permissions`, solo in sandbox senza rete [doc: https://code.claude.com/docs/en/security].
Sandbox per Bash con isolamento filesystem e rete, configurabile con `/sandbox`; comandi di rete mai auto-approvati di default [doc: https://code.claude.com/docs/en/security].
Workspace trust: dialogo alla prima apertura di una cartella, mai persistito per la home; server `.mcp.json` con approvazione separata [doc: https://code.claude.com/docs/en/security].
Fail-closed: comandi non analizzabili o senza regola chiedono approvazione; allowlist per comandi sicuri frequenti contro la fatigue da prompt [doc: https://code.claude.com/docs/en/security].
Credenziali nell'OS keychain su macOS, file 0600 su Linux, ACL del profilo su Windows; OAuth via `claude auth login`, token longevi solo con `claude setup-token` [doc: https://code.claude.com/docs/en/security].
WebFetch riassunto da modello separato invece di passare la pagina grezza a Claude; rilevamento command injection con prompt prima di eseguire [doc: https://code.claude.com/docs/en/security].
Le credenziali Claude Code restano lecite perché è il client ufficiale: usa login claude.ai o chiave Console, mai scraping di sessioni altrui [doc: https://code.claude.com/docs/en/cli-reference].
Cloud: VM isolate, rete limitata per domini, credenziali GitHub cifrate e mai dentro la VM (proxy che firma lato server), niente push di tag o cancellazioni branch, audit log e cleanup automatica [doc: https://code.claude.com/docs/en/security].
Privacy: retention limitata, telemetria disattivabile (ma spegne Remote Control e flag evaluation), Zero Data Retention e HIPAA disabilitano review, Remote Control e altri flussi [doc: https://code.claude.com/docs/en/security].
Gestione team: managed settings, policy MCP, `allowManagedHooksOnly`, toggle Remote Control per organizzazione e Trusted Devices con biometria recente [doc: https://code.claude.com/docs/en/remote-control].
Nessuna porta esposta in rete dal client: Remote Control fa solo HTTPS in uscita con polling, mai listener locali documentati [doc: https://code.claude.com/docs/en/remote-control].

## Estendibilità
MCP completo: `claude mcp add` per http/sse/stdio, `add-json`, import da Claude Desktop, login/logout OAuth, scope local/project/user, timeout e variabili per server [doc: https://code.claude.com/docs/en/cli-reference].
I plugin impacchettano skill, agenti, hook, server MCP e LSP con marketplace, installazione da app o CLI, reload senza restart e sync dall'account claude.ai [doc: https://code.claude.com/docs/en/desktop].
Gli hook coprono l'intero lifecycle (SessionStart/End, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop, SubagentStart/Stop, PreCompact, WorktreeCreate e altri) in cinque forme: comando, HTTP, tool MCP, prompt LLM, subagente [doc: https://code.claude.com/docs/en/hooks].
Matcher su nomi tool (regex incluse, con sintassi MCP `mcp__server__.*`) più filtro `if` con sintassi dei permessi su argomenti, con comandi in background e wakeup su exit code 2 [doc: https://code.claude.com/docs/en/hooks].
Le skill sono file `SKILL.md` secondo lo standard aperto Agent Skills: descrizione per l'attivazione automatica, iniezione di contesto dinamico (output shell, file), frontmatter per tool, modello, effort e hook propri [doc: https://code.claude.com/docs/en/skills].
Skill incluse (`/doctor`, `/code-review`, `/run`, `/verify`, `/loop`, `/claude-api`) e sincronizzazione di quelle dell'account su terminale, Cowork e cloud [doc: https://code.claude.com/docs/en/skills].
Subagenti custom via file o `--agents` JSON, con tool e skill precaricate, esecuzione foreground/background e isolamento worktree [doc: https://code.claude.com/docs/en/worktrees].
Channels: un server MCP dichiara `claude/channel` e spinge eventi esterni (CI, chat, webhook) dentro la sessione [doc: https://code.claude.com/docs/en/mcp].
Agent SDK per agenti custom con controllo di orchestrazione, tool e permessi; `claude mcp serve` espone la sessione come server MCP ad altri client [doc: https://code.claude.com/docs/en/cli-reference].

## Da prendere per Topics
Auto-verify dopo ogni edit (screenshot, DOM, click, fix autonomo, configurato in `.claude/launch.json`): dà alla preview Topics uno scopo oltre la visualizzazione, con fonte [doc: https://code.claude.com/docs/en/desktop]. Conta perché chiude il loop modifica-verifica senza intervento umano.
Peek panel sulle sessioni (riepilogo, domanda, risultato senza aprire il transcript): riduce il costo di supervisione della kanban, con fonte [doc: https://code.claude.com/docs/en/agent-view]. Conta perché con molte worktree parallele l'operatore deve scremare in secondi.
Messaggistica fra sessioni in linguaggio naturale con card di provenienza e inbound controls: coordina agenti senza orchestrazione rigida, con fonte [doc: https://code.claude.com/docs/en/desktop]. Conta perché la board Topics lancia agenti isolati che oggi non si parlano.
Side chat (`/btw`) che legge il contesto senza scriverci: permette domande di chiarimento senza inquinare il task, con fonte [doc: https://code.claude.com/docs/en/desktop]. Conta perché evita compaction e deviazioni nelle chat lunghe dei topic.
Hook `WorktreeCreate`/`WorktreeRemove` che sostituiscono la logica git: astrae l'isolamento oltre git, con fonte [doc: https://code.claude.com/docs/en/worktrees]. Conta perché Topics potrebbe isolare anche progetti non git.
`.worktreeinclude` per copiare `.env` e file ignorati nei worktree: elimina il setup manuale ripetuto, con fonte [doc: https://code.claude.com/docs/en/worktrees]. Conta perché ogni agente Topics oggi riparte da checkout nudo.
Skill come `SKILL.md` con attivazione automatica e sync da account: confeziona workflow riusabili meglio di prompt incollati, con fonte [doc: https://code.claude.com/docs/en/skills]. Conta perché Topics ha agenti eterogenei (Claude, Codex, Muse) che condividerebbero procedure.
`/doctor` che diagnostica e ripara setup, permessi e istruzioni ridondanti: abbassa i ticket di configurazione, con fonte [doc: https://code.claude.com/docs/en/skills]. Conta perché Topics gira come servizio launchd con più pezzi che si rompono in silenzio.

## Da evitare
Bypass permessi come scorciatoia operativa: la documentazione lo confina a sandbox senza rete, e il changelog mostra fix continui su fughe (sandbox macOS via symlink, scritture in plugin-dir, `rm` costruiti a runtime) [release v2.1.299].
Prompt injection via contenuti esterni: WebFetch riassume apposta senza passare HTML grezzo, MCP e pagine esterne sono vettori noti con classificatori dedicati [doc: https://code.claude.com/docs/en/security].
Auto-approvazioni su `.mcp.json` nei run non interattivi: in `-p` e SDK i server di progetto si caricano senza prompt, serve `disabledMcpjsonServers` per tenerne fuori alcuni [doc: https://code.claude.com/docs/en/mcp].
Skill con nomi che collidono o con caratteri invisibili: non vengono offerte finché non rinominate, e i synced possono perdere lo short name [doc: https://code.claude.com/docs/en/skills].
Regole MCP troppo larghe (`mcp__a` non copre più `a__b` dalla 2.1.299): gli allow devono nominare il server intero o si aprono buchi silenziosi [release v2.1.299].
Review cloud best-effort che non blocca mai la PR: usarla come gate di merge richiede leggere i conteggi dal check run, non fidarsi del semaforo [doc: https://code.claude.com/docs/en/code-review].
Computer use sul desktop reale con accesso alle app approvate: boundary di fiducia diverso dalla sandbox, con lock singola e fuga via `Esc` [doc: https://code.claude.com/docs/en/computer-use].

## Fonti
Documentazione ufficiale, verificata via WebFetch e curl il giorno dello studio, più CLI 2.1.299 installata in locale (`claude --help`, `claude doctor`, `claude mcp --help`).
[doc: https://code.claude.com/docs/en/overview]
[doc: https://code.claude.com/docs/en/cli-reference]
[doc: https://code.claude.com/docs/en/desktop]
[doc: https://code.claude.com/docs/en/agent-view]
[doc: https://code.claude.com/docs/en/worktrees]
[doc: https://code.claude.com/docs/en/mcp]
[doc: https://code.claude.com/docs/en/hooks]
[doc: https://code.claude.com/docs/en/skills]
[doc: https://code.claude.com/docs/en/security]
[doc: https://code.claude.com/docs/en/computer-use]
[doc: https://code.claude.com/docs/en/chrome]
[doc: https://code.claude.com/docs/en/remote-control]
[doc: https://code.claude.com/docs/en/mobile]
[doc: https://code.claude.com/docs/en/code-review]
[doc: https://code.claude.com/docs/en/changelog]
[release v2.1.299]
