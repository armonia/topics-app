# App di Codex (OpenAI)

## In tre righe

L'app di Codex, oggi evoluta nella ChatGPT desktop app, è il client desktop con cui OpenAI fa lavorare gli agenti Codex in thread paralleli organizzati per progetti, tra locale, worktree Git e cloud, con CLI, estensione IDE, web e mobile legati allo stesso account.
È pensata per sviluppatori e team che delegano task lunghi e poi rivedono diff, PR e anteprime dallo stesso posto.
Il suo punto più forte rispetto a Topics è l'ecosistema maturo e multipiattaforma: sandbox con approvazioni granulari, skill e plugin condivisi tra tutte le superfici, automazioni schedulate e code review con PR GitHub dentro l'app [doc: https://developers.openai.com/codex/app] [doc: https://developers.openai.com/codex/features].

## Identità

L'app desktop è closed source: non esiste un repository pubblico da clonare, quindi niente stelle, niente SHA e niente misura sul codice dell'app. Tutte le fonti sotto sono documentazione ufficiale, changelog e pagine pubbliche, come previsto dal livello documentazione.
Sono invece open source alcuni componenti satellite: Codex CLI, Codex SDK, Codex App Server, skill, plugin ed estensione IDE, tutti elencati nella pagina dedicata [doc: https://developers.openai.com/codex/open-source].
Il changelog pubblico mostra release molto frequenti, con la CLI arrivata alla 0.162.1 il 9 ottobre 2026 e note quasi settimanali tra agosto e ottobre 2026 [release v0.162.1] [doc: https://developers.openai.com/codex/changelog].
Piattaforme: app desktop per macOS, Windows e Linux, Codex sul web, app mobile iOS e Android, CLI da terminale ed estensione per VS Code, Cursor, Windsurf, Xcode e IDE JetBrains [doc: https://developers.openai.com/codex/app] [doc: https://developers.openai.com/codex/mobile] [doc: https://developers.openai.com/codex/cli] [doc: https://developers.openai.com/codex/ide].
Piani: Free e Go con GPT-6 Luna su task leggeri, Plus a 20 dollari al mese, Pro da 100 a 500 dollari al mese, più Business, Enterprise ed Edu con limiti più alti validi ovunque si usi Codex, cioè app, CLI, IDE e cloud [doc: https://developers.openai.com/codex/pricing].
Maturità: prodotto centrale nella strategia OpenAI del 2026, con pagina di maturità delle feature, programma per ambassador, studenti e open source, e integrazioni enterprise gestite [doc: https://developers.openai.com/codex/feature-maturity] [doc: https://developers.openai.com/codex/resources].

## Architettura

Il modello centrale è: 1 progetto contiene più chat e thread, ogni thread gira in una modalità tra Local, Worktree e Cloud, e i thread paralleli non interferiscono tra loro [doc: https://developers.openai.com/codex/projects] [doc: https://developers.openai.com/codex/environments/git-worktrees].
Local lavora nella directory corrente del computer, Worktree isola le modifiche in un Git worktree creato dal checkout locale, Cloud gira in un ambiente remoto pubblicato con repository, tool e accessi propri [doc: https://developers.openai.com/codex/environments/cloud-environments].
L'app condivide cronologia delle sessioni e configurazione con CLI ed estensione IDE, così si passa da una superficie all'altra senza rifare il setup [doc: https://developers.openai.com/codex/app].
La configurazione vive in `config.toml`, di default in `~/.codex/config.toml`, con override per progetto in `.codex/config.toml` per i progetti fidati, e copre sandbox, approvazioni, profili di permessi, MCP e notifiche [doc: https://developers.openai.com/codex/config-file/config-basic] [doc: https://developers.openai.com/codex/extend/mcp].
Le istruzioni persistenti per l'agente stanno in `AGENTS.md`, con subagenti, regole e velocità di esecuzione documentate a parte [doc: https://developers.openai.com/codex/agent-configuration/agents-md] [doc: https://developers.openai.com/codex/agent-configuration/subagents].
L'integrazione profonda con client terzi passa da Codex App Server, che espone autenticazione, cronologia, approvazioni ed eventi in streaming via JSON-RPC 2.0 su stdio, WebSocket o socket Unix, ed è open source nel repo Codex [doc: https://developers.openai.com/codex/app-server].
Per automazioni e CI esiste invece Codex SDK, mentre app-server resta pensato per client ricchi come l'estensione VS Code [doc: https://developers.openai.com/codex/app-server] [doc: https://developers.openai.com/codex/codex-sdk].
Linguaggi e framework dell'app desktop sono [non verificato]: la documentazione pubblica non li dichiara. Il sandbox usa enforcement nativo per OS, cioè Seatbelt su macOS, bubblewrap su Linux e WSL2, sandbox nativa su Windows PowerShell [doc: https://developers.openai.com/codex/sandboxing].
Lo storage delle sessioni e il protocollo IPC tra app, CLI e IDE non sono documentati pubblicamente: [non verificato].

## Sessioni e task

Ogni chat è un thread che può partire anche senza scegliere prima una cartella di progetto, utile per ricerca, scrittura e analisi, e poi convergere sul codice [doc: https://developers.openai.com/codex/projects].
Il lavoro parallelo è nativo: thread multipli per progetto, worktree Git per non sporcare il checkout locale, ambienti cloud che continuano a lavorare a computer spento, e Handoff per spostare una chat tra Local e Worktree con le operazioni Git gestite da Codex [doc: https://developers.openai.com/codex/environments/git-worktrees] [doc: https://developers.openai.com/codex/cloud].
Per il lavoro lungo esiste la Goal mode con `/goal`, che trasforma il testo in prompt e criterio di completamento, con riga di avanzamento per pausa, ripresa e modifica, più `/plan` per farsi intervistare e raffinare l'obiettivo prima di partire [doc: https://developers.openai.com/codex/long-running-work].
I task schedulati girano in background su base ricorrente o su eventi delle app, con vista Scheduled per attivi, in pausa e completati, e nei repo Git possono usare worktree dedicati così non confliggono col lavoro in corso [doc: https://developers.openai.com/codex/automations].
Le thread automations risvegliano lo stesso thread su schedule preservando il contesto, per controlli periodici e follow up senza ripartire da zero [doc: https://developers.openai.com/codex/automations].
Il flusso di chiusura per il codice è: diff in app, commit, push e apertura di pull request direttamente dall'app, più review cloud automatiche delle PR GitHub e plugin Code Review con inbox, pin, mark as viewed e gestione degli stack di PR [doc: https://developers.openai.com/codex/code-review] [doc: https://developers.openai.com/codex/third-party/github].
Le integrazioni portano il lavoro dove nasce: GitHub Action, GitLab in beta con review via `@codex review`, Slack, Linear e trigger da issue, MR e canali [doc: https://developers.openai.com/codex/github-action] [doc: https://developers.openai.com/codex/third-party/gitlab] [doc: https://developers.openai.com/codex/third-party/slack] [doc: https://developers.openai.com/codex/third-party/linear].
Non risulta una board kanban globale con code, tentativi, review e land automatico come quella di Topics: l'organizzazione è per progetti, pin e sidebar dei task [non verificato].

## Usabilità

Superfici: desktop, web, mobile, CLI con TUI, estensione IDE, niente co-browse tra dispositivi come quello di Topics [doc: https://developers.openai.com/codex/app] [doc: https://developers.openai.com/codex/web] [doc: https://developers.openai.com/codex/mobile].
Il pannello Git in app mostra il diff con commenti inline da far indirizzare a Codex, stage e revert per chunk o file interi, commit, push e PR senza uscire dall'app [doc: https://developers.openai.com/codex/features].
La review delle PR ha Summary con descrizione, attività, commenti e check, Changes con file e commenti accanto al diff, e vista Stack per PR dipendenti [doc: https://developers.openai.com/codex/code-review].
Scorciatoie documentate: `Cmd+K` per la palette dei comandi, `Ctrl+\`` per il terminale, `Cmd+T` per un nuovo tab browser, `Cmd+Shift+B` per passare tra vista piena e affiancata nel browser, `Cmd+Option+U` per la vista Activity [doc: https://developers.openai.com/codex/integrated-terminal] [doc: https://developers.openai.com/codex/browser] [doc: https://developers.openai.com/codex/notifications].
Le notifiche segnalano completamento dei turni, permessi e domande, con controlli separati per desktop, web, CLI e vista Activity con unread, running e waiting [doc: https://developers.openai.com/codex/notifications].
Dettaglio originale: i pet fluttuanti mostrano lo stato delle chat, cioè Running, Needs input, Ready o Blocked, mentre si lavora in altre app [doc: https://developers.openai.com/codex/notifications].
L'onboarding è: installa, accedi con l'account ChatGPT, scegli dove lavorare tra chat, progetto o cartella, e invia il primo messaggio, con `Sign in with ChatGPT` anche per CLI e IDE [doc: https://developers.openai.com/codex/app] [doc: https://developers.openai.com/codex/cli].
La dettatura vocale e la finestra pop-out fluttuante completano le superfici desktop [doc: https://developers.openai.com/codex/features].

## Browser e anteprima

L'app include un browser integrato con profilo separato da quello personale, senza condivisione automatica di tab e sessioni, con cronologia propria, gestione dei download e permessi agente per sito [doc: https://developers.openai.com/codex/browser].
Il flusso di verifica visiva è: avvia il dev server nel terminale integrato, apri la route locale, lascia commenti di annotazione sugli elementi o aree, chiedi a Codex di indirizzarli con scope stretto, poi riverifica la pagina [doc: https://developers.openai.com/codex/browser].
Le annotazioni supportano feedback di stile granulare con Adjust, cioè font, testo, spaziatura e colore con anteprima live prima dell'invio [doc: https://developers.openai.com/codex/browser].
L'agente pilota il browser direttamente: apre pagine, clicca, digita, ispeziona lo stato renderizzato e fa screenshot per verificare il proprio lavoro, con conferma richiesta prima di azioni sensibili come invii, acquisti o cancellazioni [doc: https://developers.openai.com/codex/browser].
La Developer mode dà accesso controllato al Chrome DevTools Protocol per profiling JS, console, rete e DOM, con approvazione esplicita e possibilità per gli admin di disabilitarla via policy [doc: https://developers.openai.com/codex/browser].
Quando serve il profilo reale dell'utente si usa invece l'estensione per Chrome, Edge, Brave, Opera e Vivaldi, che lavora nei tab esistenti [doc: https://developers.openai.com/codex/chrome-extension].
Oltre al browser c'è Computer Use, che vede e opera le GUI di macOS e Windows per test di app native, flussi su simulatori e bug solo grafici, con permessi di Screen Recording e Accessibilità su Mac [doc: https://developers.openai.com/codex/computer-use].
L'artifact viewer mostra in sidebar PDF, fogli di calcolo, documenti e presentazioni generati prima di condividerli [doc: https://developers.openai.com/codex/artifacts-viewer].
Niente di tutto questo è co-browse tra dispositivi: il browser è condiviso tra utente e agente sullo stesso host, e il telefono controlla i thread ma non rispecchia il DOM come fa l'iPad di Topics [doc: https://developers.openai.com/codex/mobile].

## Terminale, editor, file

Ogni chat dell'app ha un terminale integrato nello scope del progetto o worktree corrente, apribile come tab o con scorciatoia, per test, lint, script e operazioni Git senza cambiare app [doc: https://developers.openai.com/codex/integrated-terminal].
L'agente legge l'output del terminale corrente, così verifica un dev server in esecuzione o un build fallito mentre lavora [doc: https://developers.openai.com/codex/integrated-terminal].
I comandi ricorrenti diventano azioni riusabili dell'ambiente locale, che appaiono come scorciatoie nell'app e girano nel terminale integrato [doc: https://developers.openai.com/codex/integrated-terminal].
L'estensione IDE si sincronizza automaticamente con l'app quando entrambe sono sullo stesso progetto: l'app vede i file aperti con Auto context, e i thread dell'app sono visibili nell'IDE e viceversa [doc: https://developers.openai.com/codex/ide].
Dall'IDE si lavora con contesto dell'editor, cioè file aperti e selezioni, si revisionano le modifiche in place e si delegano i task lunghi al cloud per poi rientrare con contesto preservato [doc: https://developers.openai.com/codex/ide].
La CLI resta il terzo polo locale: ispeziona il repo, modifica, esegue i tool installati sulla macchina e si presta a script e CI via `codex exec` non interattivo [doc: https://developers.openai.com/codex/cli] [doc: https://developers.openai.com/codex/non-interactive-mode].
Non risulta un editor integrato proprietario: la modifica avviene via agente, diff in app o editor esterno [non verificato].

## Remoto e mobile

L'app mobile ChatGPT su iOS e Android include Codex completo: si avviano task su Cloud o computer connesso, si segue l'avanzamento, si approvano comandi e azioni, si revisionano file, diff e test dal telefono [doc: https://developers.openai.com/codex/mobile].
Il collegamento col computer passa da Settings, Connections, Control this Mac or PC, con QR da scansionare, stesso account e workspace, e approvazione esplicita, solo con dispositivi propri e fidati [doc: https://developers.openai.com/codex/mobile].
L'app desktop rileva gli host dalla configurazione SSH e fa girare progetti e thread nelle macchine remote come in locale, e quegli ambienti diventano raggiungibili dagli altri dispositivi autorizzati tramite relay sicuro [doc: https://developers.openai.com/codex/remote-connections].
Il cloud copre l'assenza: task che continuano a computer spento, ambienti riusabili per repo, avvio e review da web, mobile o desktop [doc: https://developers.openai.com/codex/cloud].
Tutto passa però per il cloud OpenAI, con policy di sicurezza dell'organizzazione applicate: non esiste uso in LAN senza cloud come quello di Topics, e il computer connesso deve restare acceso e online [doc: https://developers.openai.com/codex/mobile] [doc: https://developers.openai.com/codex/enterprise/chatgpt-work-cloud-security].
Il supporto Windows per il collegamento dal telefono era in arrivo al momento della documentazione, quindi da riverificare prima di prometterlo [doc: https://developers.openai.com/codex/mobile].

## Provider e protocolli

I modelli sono solo OpenAI: GPT-6.1 Sol per il lavoro complesso, GPT-6 Luna per i task leggeri, GPT-6 Astra per giudizio visivo, con effort di reasoning regolabile e modalità Ultra che parallelizza via subagenti [doc: https://developers.openai.com/codex/models] [doc: https://developers.openai.com/codex/model-selection].
L'accesso è con account ChatGPT nei piani citati oppure con API key con setup aggiuntivo, e uso condiviso tra Codex e ChatGPT Work negli stessi crediti e limiti [doc: https://developers.openai.com/codex/cli] [doc: https://developers.openai.com/codex/pricing].
MCP è supportato come client: i server si configurano in Settings, MCP servers, o in `config.toml`, valgono per app, CLI e IDE insieme, con OAuth quando serve e comando `/mcp` per vedere le connessioni [doc: https://developers.openai.com/codex/extend/mcp].
Skill e plugin sono il riuso condiviso: una skill creata nell'app vale anche in CLI e IDE, si versiona nel repo per tutto il team, e i plugin impacchettano skill, server MCP, UI custom e hook di lifecycle [doc: https://developers.openai.com/codex/skills-and-plugins].
Non risultano Claude Code, Gemini, OpenCode o ACP come provider o protocolli supportati: l'ecosistema è monomodello OpenAI con MCP come unica apertura documentata [non verificato].
Per gli sviluppatori: Codex SDK per automazioni, App Server JSON-RPC per client ricchi, GitHub Action per CI, comandi slash e impostazioni documentate per superficie [doc: https://developers.openai.com/codex/codex-sdk] [doc: https://developers.openai.com/codex/app-server] [doc: https://developers.openai.com/codex/reference/slash-commands].

## Performance

La leva dichiarata per la velocità è Ultrafast mode, che accelera la generazione di token con GPT-6.1 Sol in Codex e ChatGPT Work, su piani Pro alti ed Enterprise ed Edu idonei [doc: https://developers.openai.com/codex/agent-configuration/speed].
Accanto stanno Fast mode, effort di reasoning regolabile per non pagare pianificazione profonda quando non serve, e Ultra mode che divide i task grandi su subagenti [doc: https://developers.openai.com/codex/agent-configuration/speed] [doc: https://developers.openai.com/codex/models].
Il 2 ottobre 2026 la documentazione segnalava GPT-6.1 Sol come scelta per lavoro complesso a costo inferiore rispetto ad Astra [doc: https://developers.openai.com/codex/whats-new].
Numeri misurati di avvio, memoria o rendering non sono pubblicati nelle docs lette: nessun benchmark dichiarato su liste virtualizzate, streaming o lavoro in background [non verificato].
Lamentele degli utenti su lentezza, memoria o crash non sono state raccolte perché il livello dello studio è documentazione e l'app è closed source; il repo CLI open source ha issue pubbliche ma esula dal perimetro assegnato [non verificato].
Un segnale indiretto di attenzione alla reattività: la CLI 0.162.0 limita output dei comandi persistiti a 64 KiB nella cronologia paginata e raggruppa l'output di esecuzione, cioè taglia il carico di rendering dei log lunghi [release v0.162.0].

## Affidabilità e qualità

Il changelog pubblico è lo strumento di qualità più visibile: CLI a release ravvicinate con note dettagliate di fix, come crash TUI su domande multilinea e fallimenti di avvio per mismatch di feature col server di background nella 0.162.1 [release v0.162.1] [doc: https://developers.openai.com/codex/changelog].
La pagina di maturità delle feature dichiara lo stato di ogni capacità, così un team sa cosa è stabile e cosa è in anteprima prima di adottarlo [doc: https://developers.openai.com/codex/feature-maturity].
La persistenza attraversa le superfici: stessa cronologia e configurazione tra app, CLI e IDE, thread cloud che sopravvivono alla chiusura del laptop, retry che onora l'header Retry-After del server [doc: https://developers.openai.com/codex/app] [doc: https://developers.openai.com/codex/cloud] [release v0.162.0].
Il recupero dopo crash a livello di thread e il conteggio dei file di test non sono documentati pubblicamente: [non verificato].
Gli aggiornamenti passano per installer standalone, npm, Homebrew e download da CDN con fallback su GitHub Releases, più gestione dei deployment Windows per gli admin [doc: https://developers.openai.com/codex/cli] [doc: https://developers.openai.com/codex/enterprise/windows-deployment].

## Sicurezza e privacy

Il modello è a due assi: il sandbox definisce i confini tecnici, la policy di approvazione decide quando fermarsi a chiedere, e i due controlli lavorano insieme [doc: https://developers.openai.com/codex/sandboxing].
Le modalità sandbox sono `read-only`, `workspace-write` come default a bassa frizione, e `danger-full-access` senza restrizioni da usare solo con intento esplicito, con policy `on-request` o `never` [doc: https://developers.openai.com/codex/sandboxing].
I permission profiles applicano least privilege a comandi locali con regole filesystem e rete, con tre profili built in e profili nominati per progetto, ed enforcement via proxy di rete quando attivo [doc: https://developers.openai.com/codex/permissions].
Approve for me instrada le richieste idonee a una review automatica invece del prompt manuale, riducendo la fatica da approvazione senza allargare il sandbox [doc: https://developers.openai.com/codex/sandboxing/auto-review].
Il contenuto delle pagine è trattato come contesto non fidato, con review di sito e azione proposta prima di condividere dati sensibili, e ChatGPT chiede conferma prima di invii, pagamenti, cambi di permessi o cancellazioni [doc: https://developers.openai.com/codex/browser].
Per i team: configurazione gestita via MDM, profili di permessi imposti, audit e analytics di workspace, compliance API ed eventi, configurazione HIPAA per Enterprise in ambienti locali [doc: https://developers.openai.com/codex/enterprise/managed-configuration] [doc: https://developers.openai.com/codex/hipaa-configuration] [doc: https://developers.openai.com/codex/enterprise/compliance-api].
Dettagli su telemetria, trattamento dei token OAuth e porte esposte in rete non sono documentati nelle pagine lette: [non verificato].

## Estendibilità

Le skill impacchettano istruzioni e risorse per task ripetitivi, con nome e descrizione per il matching automatico, menzione esplicita con `@` in ChatGPT e `$` in Codex, e scaffolding via `@skill-creator` o `$skill-creator` [doc: https://developers.openai.com/codex/skills-and-plugins] [doc: https://developers.openai.com/codex/build-skills].
I plugin sono bundle installabili con skill, server MCP, UI custom ed eventi, con flusso di build, test, submit e review, anche solo per desktop [doc: https://developers.openai.com/codex/build-plugins].
Gli hook Codex eseguono script o tool MCP dentro il loop agentico su eventi come PreToolUse, PermissionRequest, PostToolUse, UserPromptSubmit, SubagentStop e SessionStart, caricati da `hooks.json` o tabelle inline in `config.toml` a quattro livelli utili, più quelli impacchettati nei plugin [doc: https://developers.openai.com/codex/hooks].
I subagenti accelerano il lavoro complesso in Ultra mode e sono configurabili a parte [doc: https://developers.openai.com/codex/agent-configuration/subagents].
Record e Replay cattura sessioni riusabili, mentre WebMCP espone site tools e le annotation API estendono il browser [doc: https://developers.openai.com/codex/extend/record-and-replay] [doc: https://developers.openai.com/codex/webmcp] [doc: https://developers.openai.com/codex/annotations-extensibility].
I repo `openai/skills` e `openai/plugins` raccolgono i riusi ufficiali, tra cui deploy su Cloudflare, Netlify, Render e Vercel, generazione immagini e skill per le API OpenAI [doc: https://developers.openai.com/codex/open-source].

## Da prendere per Topics

1. Commenti di annotazione sulla preview che diventano task per l'agente: i browser comment con Adjust mostrano come chiudere il loop tra occhio umano e fix automatico, e Topics ha già il pannello browser su cui innestarli [doc: https://developers.openai.com/codex/browser].
2. Handoff Local Worktree gestito dall'app: spostare una chat tra checkout e worktree con le operazioni Git fatte dal sistema abbassa il rischio di pasticci, e la board di Topics con worktree per agente è il posto naturale [doc: https://developers.openai.com/codex/environments/git-worktrees].
3. Goal mode con `/goal` e criteri di done misurabili: dare all'agente outcome, vincoli e definizione di done verificabile riduce i giri a vuoto nei task lunghi della kanban [doc: https://developers.openai.com/codex/long-running-work].
4. Permission profiles con tre default chiari: read-only, workspace e full access esplicito danno un modello mentale semplice per il least privilege, più presentabile degli switch tecnici attuali [doc: https://developers.openai.com/codex/permissions].
5. Approve for me con review automatica: invece di chiedere tutto o niente, le richieste idonee passano da una review automatica e il sandbox resta stretto, cioè meno interruzioni senza allargare i confini [doc: https://developers.openai.com/codex/sandboxing/auto-review].
6. Skill condivise nel repo e valide ovunque: una skill committata vale in app, CLI e IDE, così le best practice del team viaggiano col codice e non restano nella testa di qualcuno [doc: https://developers.openai.com/codex/skills-and-plugins].
7. Code review con inbox, pin e mark as viewed: portare nella review di Topics gli stati di avanzamento per file e PR impilate rende la revisione di più agenti in parallelo molto meno caotica [doc: https://developers.openai.com/codex/code-review].
8. Thread automations sullo stesso thread: risvegliare la conversazione esistente su schedule invece di aprirne una nuova conserva il contesto per sorveglianze e follow up ripetitivi [doc: https://developers.openai.com/codex/automations].

## Da evitare

1. Monocloud come unico modello remoto: tutto il remoto di Codex passa per l'infrastruttura OpenAI e il PC deve restare acceso per l'accesso locale, mentre Topics vince proprio con LAN senza cloud, da non sacrificare per inseguire il relay [doc: https://developers.openai.com/codex/mobile].
2. Full access come scorciatoia abituale: la doc stessa lo relega a uso intenzionale ed eccezionale, e normalizzarlo in Topics significherebbe regalare all'agente filesystem e rete senza confini [doc: https://developers.openai.com/codex/sandboxing].
3. Fidarsi del contenuto delle pagine: le docs ricordano che il contenuto web è contesto non fidato e che un permesso sito non rende il sito affidabile, avviso da replicare pari pari se Topics pilota il browser con più poteri [doc: https://developers.openai.com/codex/browser].
4. Parco modelli chiuso: legarsi a un solo provider come fa Codex con i modelli OpenAI è l'opposto della scommessa Topics su Claude, Codex e Muse insieme, e toglierebbe la leva negoziale sui prezzi [non verificato].
5. Pet e gamification come scorciatoia per le notifiche: il pet carino non sostituisce Activity view, stati e canali configurabili, e Topics dovrebbe copiare la sostanza, cioè gli stati, non la mascotte [doc: https://developers.openai.com/codex/notifications].
6. Developer mode CDP sempre attiva: l'accesso completo al protocollo espone gli interni sensibili del browser, e va tenuta dietro approvazione esplicita e policy admin, mai come default [doc: https://developers.openai.com/codex/browser].

## Fonti

- [doc: https://developers.openai.com/codex]
- [doc: https://developers.openai.com/codex/app]
- [doc: https://developers.openai.com/codex/features]
- [doc: https://developers.openai.com/codex/projects]
- [doc: https://developers.openai.com/codex/cloud]
- [doc: https://developers.openai.com/codex/mobile]
- [doc: https://developers.openai.com/codex/cli]
- [doc: https://developers.openai.com/codex/ide]
- [doc: https://developers.openai.com/codex/browser]
- [doc: https://developers.openai.com/codex/computer-use]
- [doc: https://developers.openai.com/codex/chrome-extension]
- [doc: https://developers.openai.com/codex/artifacts-viewer]
- [doc: https://developers.openai.com/codex/sandboxing]
- [doc: https://developers.openai.com/codex/sandboxing/auto-review]
- [doc: https://developers.openai.com/codex/permissions]
- [doc: https://developers.openai.com/codex/extend/mcp]
- [doc: https://developers.openai.com/codex/skills-and-plugins]
- [doc: https://developers.openai.com/codex/build-skills]
- [doc: https://developers.openai.com/codex/build-plugins]
- [doc: https://developers.openai.com/codex/hooks]
- [doc: https://developers.openai.com/codex/extend/record-and-replay]
- [doc: https://developers.openai.com/codex/webmcp]
- [doc: https://developers.openai.com/codex/annotations-extensibility]
- [doc: https://developers.openai.com/codex/integrated-terminal]
- [doc: https://developers.openai.com/codex/code-review]
- [doc: https://developers.openai.com/codex/automations]
- [doc: https://developers.openai.com/codex/long-running-work]
- [doc: https://developers.openai.com/codex/notifications]
- [doc: https://developers.openai.com/codex/remote-connections]
- [doc: https://developers.openai.com/codex/models]
- [doc: https://developers.openai.com/codex/model-selection]
- [doc: https://developers.openai.com/codex/pricing]
- [doc: https://developers.openai.com/codex/agent-configuration/speed]
- [doc: https://developers.openai.com/codex/agent-configuration/agents-md]
- [doc: https://developers.openai.com/codex/agent-configuration/subagents]
- [doc: https://developers.openai.com/codex/app-server]
- [doc: https://developers.openai.com/codex/codex-sdk]
- [doc: https://developers.openai.com/codex/open-source]
- [doc: https://developers.openai.com/codex/changelog]
- [doc: https://developers.openai.com/codex/whats-new]
- [doc: https://developers.openai.com/codex/feature-maturity]
- [doc: https://developers.openai.com/codex/config-file/config-basic]
- [doc: https://developers.openai.com/codex/environments/git-worktrees]
- [doc: https://developers.openai.com/codex/environments/cloud-environments]
- [doc: https://developers.openai.com/codex/non-interactive-mode]
- [doc: https://developers.openai.com/codex/github-action]
- [doc: https://developers.openai.com/codex/third-party/github]
- [doc: https://developers.openai.com/codex/third-party/gitlab]
- [doc: https://developers.openai.com/codex/third-party/slack]
- [doc: https://developers.openai.com/codex/third-party/linear]
- [doc: https://developers.openai.com/codex/web]
- [doc: https://developers.openai.com/codex/hipaa-configuration]
- [doc: https://developers.openai.com/codex/enterprise/managed-configuration]
- [doc: https://developers.openai.com/codex/enterprise/compliance-api]
- [doc: https://developers.openai.com/codex/enterprise/windows-deployment]
- [doc: https://developers.openai.com/codex/enterprise/chatgpt-work-cloud-security]
- [doc: https://developers.openai.com/codex/reference/slash-commands]
- [doc: https://openai.com/codex]
- [doc: https://openai.com/index/introducing-the-codex-app]
- [release v0.162.1]
- [release v0.162.0]
