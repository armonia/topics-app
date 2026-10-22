# OpenCockpit

## In tre righe

OpenCockpit è una postazione di lavoro web per sviluppatori che usano Claude Code e altri motori nello stesso ciclo di sviluppo: chat multi progetto, terminale, database e browser pilotabili dall'agente, tutto in locale.
È pensata per chi segue più repository in parallelo, vuole una seconda opinione da un altro modello o condivide un box di sviluppo con il team.
Il suo punto più forte rispetto a Topics è la combinazione di snapshot a ogni tool call con Code Map e CodeGraph, che rendono la revisione e l'esplorazione del codice più precise del giro chat più file.

## Identità

Repository: https://github.com/Surething-io/cockpit, clone verificato allo SHA `6aa303d3b1ce516621aa299b09ea86069a394a07` [codice: repos/opencockpit, rev-parse HEAD].
Stelle: 43 e 12 fork al momento della misura, licenza MIT, linguaggio principale TypeScript [doc: https://github.com/Surething-io/cockpit].
Ultimo commit: 2026-10-14 con messaggio sul blog per il comando di delega, release più recente v1.0.285 del 2026-10-13, poi v1.0.284 e v1.0.283 a ridosso [release v1.0.285].
Versione `1.0.285` dichiarata anche in `package.json`, quindi il tag e il manifest sono allineati [codice: package.json:3].
Progetto creato il 2026-02-06, quindi ha circa otto mesi di vita e una cadenza di release molto rapida, con cinque release visibili nel canale stabile [doc: https://github.com/Surething-io/cockpit].
Piattaforme: macOS, Linux e Windows sperimentale, richiede Node maggiore o uguale a 20 e Git, Chrome solo facoltativo per la bolla browser [README].
Maturità: prodotto giovane ma attivamente mantenuto, con tabella comparativa onesta contro desktop ufficiale e soluzioni native [README].

## Architettura

Linguaggi misurati sul clone con conteggio righe: TypeScript circa 98.764 righe, TSX circa 59.288 righe, JavaScript e MJS circa 10.203 righe, CSS circa 2.578 righe, Markdown circa 14.632 righe, JSON circa 29.260 righe, totale circa 262.759 righe su 1.212 file [codice: repos/opencockpit, git ls-files più wc -l].
Stack dichiarato: Next.js 16, React 19, TypeScript, TailwindCSS, xterm.js, node-pty, Shiki, tree-sitter in WASM, i18next, Claude Agent SDK e Vercel AI SDK [README].
Modello: app web client più server, non app nativa. Il server è un custom server Next avviato da `server.mjs`, porta 3456 in sviluppo e 3457 in produzione, con directory dati in `~/.cockpit` isolabile via `COCKPIT_HOME` [codice: server.mjs:16].
Organizzazione del codice: `src/` contiene solo routing Next e bootstrap, tutto il dominio vive in `packages/`, con pacchetti condivisi e pacchetti di funzionalità [codice: MODULES.md:14].
Regole di dipendenza a due strati: le funzionalità possono usare le librerie condivise e altre funzionalità senza cicli, le librerie condivise non possono dipendere dalle funzionalità salvo un hub di runtime esplicito [codice: MODULES.md:40].
Come parla con l'agente: usa la funzione ufficiale `query()` del Claude Agent SDK, avvolta in uno Stream neutro rispetto al provider [codice: packages/feature/agent/src/effect/claudeSdkAdapter.ts:18].
Gli altri motori passano per endpoint compatibili con Anthropic cambiando baseURL e chiave: OpenAI, Kimi, DeepSeek e BigModel hanno URL dedicati, Ollama usa un adattatore proprio [codice: packages/feature/agent/src/effect/claudeSdkAdapter.ts:39].
Comunicazione interna: route API Next più WebSocket per stato globale, file watcher, terminale, browser e stream di sessione, con dispatch centralizzato [codice: src/lib/wsServer.ts:13].
Storage: file locali sotto la home, credenziali per motore, snapshot in stile shadow git per progetto, transcript e rollout per sessione [codice: packages/feature/agent/src/effect/snapshotLive.ts:3].
Niente Rust o Go nel percorso principale: la velocità è affidata a Node, Effect e indicizzazione WASM, non a estensioni native oltre node-pty [non verificato oltre grep].

## Sessioni e task

Sessioni parallele: sì, tab multi progetto con sessioni concorrenti, badge con pallino rosso e notifiche desktop [README].
Ogni motore vive nel suo tab con cronologia propria, commutabile dal menu di nuovo tab [README].
Persistenza e riuso: pinning e fork delle sessioni, browser cross progetto con Cmd più K, ricerca semantica con `/ss` che risponde con link diretto [README].
Delega: `/dl` affida un sotto compito a una nuova sessione in un'altra directory o su un altro motore senza attendere, con variante di attesa che prosegue nello stesso turno [README].
Sotto agenti persistenti: i Bot sono directory locali con file di identità, richiamati con `@nome`, eseguiti in sessioni separate e ispezionabili, con memoria esplicita e comandi di revisione [README].
Istantanee: ogni tool call che tocca file produce uno snapshot locale con vista diff in stile cronologia git, incluse le modifiche fatte da Bash [README].
Attività programmate: task una tantum, a intervallo o con cron, con pausa, ripresa, riordino e tracciamento risultati [README].
Gestione worktree: lista e creazione da interfaccia tramite API dedicata, con lettura di `worktree list` in formato porcelain [codice: packages/feature/explorer/src/server/api/git/worktree.ts:144].
Niente board kanban globale con code, tentativi, review, land e publish come quella di Topics: nessuna occorrenza di kanban nel codice e nei documenti [non verificato oltre grep].
Niente PR o CI integrate nella chat: la revisione è su file e snapshot, non su richieste di merge [non verificato oltre grep].

## Usabilità

Superfici: app web locale da aprire nel browser, anche da telefono o tablet in LAN, più prova online in sola lettura senza chat [README].
Niente app desktop nativa e niente TUI: è dichiarato che non esiste un binario desktop e serve Node [README].
Layout a tre pannelli sempre montati, Agent più Explorer più Console, con cambio pannello tramite traslazione CSS senza smontare i componenti [codice: AGENTS.md:13].
Flussi principali: casi d'uso documentati per refactor paralleli, specialista che ricorda, primo giorno in repo ignoto, team su box condiviso, revisione di PR generate, QA notturna [README].
Diff e review: commenti a livello di riga su qualsiasi file, con invio del commento all'IA come contesto per la correzione [README].
Notifiche: pallino rosso in inbox, notifiche desktop e notifiche browser per completamenti e richieste di approvazione [README] [issue #8].
Scorciatoie: Cmd più K per le sessioni, Cmd più F per la ricerca file, prefisso `!` per eseguire shell dalla chat, allegati con trascinamento [README].
Onboarding: installazione con un comando globale, apertura della directory corrente o indicata, aggiornamento in place con rollback [README].

## Browser e anteprima

Ha un browser integrato pilotabile: la bolla Browser controlla Chrome tramite albero di accessibilità, con click, digitazione, navigazione, screenshot e rete [README].
C'è un'estensione Chrome in Manifest V3 dentro il repository, progetto indipendente con script di automazione, contenuto e cattura rete [codice: chrome-extension/manifest.json:1].
La bolla si può aprire e chiudere anche da CLI, riusando lo stesso meccanismo di broadcast della console, con stato di registrazione esplicito quando nessuna UI è collegata [codice: packages/feature/console/src/server/plugins/browser/browserBubbleControl.ts:1].
C'è anche una CLI per istantanea dell'albero, click, lista dei terminali, lettura output e lista delle bolle [README].
Niente co-browse fra dispositivi come quello di Topics: nessuna replica del DOM da Mac a iPad nel codice e nei documenti [non verificato oltre grep].
Una issue chiusa chiedeva sincronizzazione streaming in tempo reale per nuovi client browser e ripresa cross dispositivo, segnale che il tema è noto ma non equivale al mirror DOM [issue #10].
Anteprima file: visualizzatore JSON, anteprima Markdown, app HTML locali servite da route con SDK iniettato [codice: AGENTS.md:78].

## Terminale, editor, file

Terminale completo con xterm.js e integrazione di shell, più bolle trascinabili con layout a griglia o massimizzato, variabili d'ambiente e alias per tab [README].
Il server usa node-pty per la modalità PTY, con astrazione che distingue PTY da altre modalità di esecuzione [codice: packages/feature/console/src/server/terminal/ptyHostClient.ts:9].
Editor: browser file a 4 tab, Directory più Recent più Git Changes più Git History, evidenziazione con Shiki e modifica in modo Vi [README].
Git integrato: blame, diff, cambio branch, gestione worktree, confronto per branch con modalità su worktree [codice: packages/feature/explorer/src/server/api/git/branch-diff.ts:8].
LSP integrato per definizione, riferimenti e informazioni al passaggio del mouse [README].
Code Map: ogni funzione diventa un chip con pin di chiamanti e chiamati, clic per camminare nel grafo, multi linguaggio senza LSP e senza configurazione, anche offline [README].
CodeGraph per l'agente: indice tree-sitter esposto come 10 endpoint HTTP, con ricerca, chiamanti, chiamati, impatto, file, co modifica e quattro analisi con PageRank e clustering, solo coordinate senza sorgente [README].
Ricerca file fuzzy, visualizzatore JSON e anteprima Markdown completano la dotazione [README].

## Remoto e mobile

Accesso da telefono o tablet via qualsiasi browser in LAN, il codice gira sulla macchina dell'utente senza relay cloud [README].
Self hosting su box condiviso: ogni membro del team apre il browser, prende un posto e lavora su progetto o worktree proprio [README].
Protezione: token facoltativo via flag di avvio, con esenzione per richieste locali e verifica contro header di forwarding che smascherano proxy e tunnel [codice: src/lib/auth.ts:10].
Cancello di origine contro DNS rebinding e pagine cross site, con controllo di Host e Origin su ogni richiesta HTTP e ogni upgrade WebSocket [codice: AGENTS.md:78].
Una issue chiusa chiedeva UI responsive per monitoraggio in movimento, segnale di attenzione al mobile [issue #7].
Niente integrazione launchd o systemd: dopo un riavvio serve rilanciare il comando di avvio in background [README].
Porte: 3457 di default in produzione, 3456 in sviluppo, log in directory dati [README].

## Provider e protocolli

Claude è il motore di default con SDK ufficiale e zero configurazione se la CLI è già pronta [README].
Codex riusa la configurazione esistente dell'utente senza variabili da modificare [README].
DeepSeek, GLM e Kimi richiedono chiave incollata nel selettore modello, con selettore modello live e controlli di saldo o quota [README].
Ollama con avvio automatico del demone e scelta del modello scaricato dall'intestazione chat, per sessioni completamente offline [README].
Nessuna occorrenza di Agent Client Protocol nel codice applicativo, solo lockfile del sito: il dialogo con i modelli passa da SDK e compatibilità Anthropic, non da ACP [non verificato oltre grep].
MCP in lettura: le chiamate Codex verso MCP usano spazi con prefisso `mcp__`, e la normalizzazione conserva la convenzione con doppio trattino basso basso usata anche da Claude [codice: packages/feature/agent/src/server/api/session/codexTools.ts:32].
La lista di tool in sola lettura è una deny list, quindi un tool MCP sconosciuto va trattato con cautela perché non classificato [codice: packages/feature/agent/src/shared/toolMutation.ts:8].
Nessun server MCP proprio esposto ai modelli come quello di Topics risulta dai documenti e dal README [non verificato oltre grep].

## Performance

Avvio e memoria: nessun benchmark dichiarato nel repository [non verificato].
Latenza locale dichiarata sotto i 10 millisecondi per le richieste API, motivo per cui non esiste caching applicativo [codice: AGENTS.md:122].
Rendering: tre pannelli e ogni tab chat restano montati, quindi le convenzioni impongono callback stabili, oggetti memoizzati e lavoro costoso fuori dal JSX per non invalidare i componenti pesanti [codice: AGENTS.md:20].
File browser con scorrimento virtuale ed evidenziazione efficiente [codice: AGENTS.md:102].
Streaming reale via WebSocket con gestione incrementale dei messaggi ed eventi di avanzamento [codice: packages/feature/agent/src/client/mergeIncrementalMessages.ts:1].
Lavoro in background: comandi di avvio, stato, riavvio e stop, con handoff che preserva porta e token [README].
Snapshot a ogni tool call con serializer per repository e uso diretto di git con directory separata, così il `.git` del progetto non viene toccato [codice: packages/feature/agent/src/effect/snapshotLive.ts:3].
Lamentele di performance nelle issue: nessuna issue aperta su lentezza, memoria, crash o batteria fra le poche issue presenti [issue #11].

## Affidabilità e qualità

Test: 124 file con suffisso di test TypeScript e 132 file che contengono `test` nel nome, con runner `vitest run` [codice: package.json:106].
CI su Ubuntu, macOS e Windows, con test automatici e nota che Windows ha copertura reale minore rispetto alle altre piattaforme [codice: .github/workflows/ci.yml:25] [README].
Persistenza sessioni: transcript e rollout salvati su disco per motore, con recupero all'avvio delle trascrizioni interrotte da task indipendenti mai terminati [codice: src/lib/wsServer.ts:36].
Recupero dopo crash: sweep idempotente che ricuce transcript e rollout lasciati da esecuzioni interrotte [codice: src/lib/wsServer.ts:36].
Aggiornamenti: comando dedicato che installa mentre nulla blocca la directory, rilancia con stessa porta e token, esegue rollback in caso di fallimento e chiede reload ai tab aperti [README].
Issue totali molto poche: sei voci fra bug di installazione, richieste di funzionalità e prove video, quasi tutte chiuse [issue #11] [issue #10] [issue #9].
Conteggio test, CI multipiattaforma e sweep di recupero sono verificati sui file, i tassi di successo restano non verificati senza accesso alla CI [non verificato].

## Sicurezza e privacy

Dichiarazione di località totale: nessuna telemetria e nessun relay cloud, le chiavi restano sul portatile [README].
Chiavi per motore in file separati sotto directory dati, mai incluse nel payload delle impostazioni spedito al browser [codice: packages/feature/agent/src/server/engines/credentials.ts:1].
Claude usa la configurazione esistente della CLI, Codex riusa la propria directory, quindi non c'è gestione OAuth propria da valutare [README].
Cancello di origine su ogni ingresso: controllo Host contro rebinding e controllo Origin contro pagine cross site, più regola più severa sul canale shell che rifiuta anche Origin assente [codice: AGENTS.md:78].
Token condiviso facoltativo con confronto a tempo costante, cookie di lunga durata e rimozione del segreto dalla barra degli indirizzi [codice: src/lib/auth.ts:23].
Avviso esplicito sul rischio anteprima: aprire un HTML locale lo esegue con accesso shell completo, senza sandbox nell'iframe, e può navigare l'intera finestra [codice: AGENTS.md:78].
Porte esposte in rete solo se l'utente pubblica il servizio: di default è pensato per localhost e LAN fidata [non verificato].
Nessuna dipendenza di telemetria applicativa trovata oltre tracer volutamente senza OpenTelemetry per costi eccessivi in locale [codice: packages/shared/effect-core/src/tracer.ts:8].

## Estendibilità

Skill come file Markdown: una directory per comando sotto cartella dedicata, con dispatch e autocompletamento che leggono la stessa sorgente, aggiunta pari a una directory più un file [codice: AGENTS.md:52].
Modalità slash integrate per chiarire, diagnosticare, esplorare, atterrare, grafo del codice, CLI, revisione e delega, più comandi personalizzati da sidebar [README].
Bot persistenti in Markdown locale, senza database nascosto né lock del fornitore, con comandi di creazione, collegamento skill e revisione memoria [README].
Bolle per database oltre al browser: PostgreSQL, MySQL, Redis e altri connettori presenti nel server console [codice: packages/feature/console/src/server/api/services-config.ts:1].
CLI esterna per browser, terminali e connessioni, utile per automazioni e QA notturna con task schedulati [README].
CodeGraph come API per l'agente: 10 endpoint che danno coordinate invece di testo, con trigger da chat [README].
Nessuna API di plugin generica oltre questi meccanismi documentati [non verificato oltre grep].

## Da prendere per Topics

1. Snapshot a ogni tool call con shadow git: cosa, un commit per chiamata mutante in directory git separata con retention di 7 giorni e diff per risposta, dove [codice: packages/feature/agent/src/effect/snapshotLive.ts:3], perché Topics non ha undo di sessione e questo copre anche Bash.
2. Code Map a chip con chiamanti e chiamati: cosa, vista a chip cliccabile senza LSP, dove [README], perché l'onboarding su repo ignoti in Topics oggi passa da albero file e grep.
3. CodeGraph con endpoint per l'agente: cosa, 10 endpoint con coordinate e analisi di impatto e rischio, dove [README], perché riduce contesto e trova accoppiamenti che la ricerca testuale manca.
4. Delega `/dl` fra sessioni e motori: cosa, sotto compito in altra directory o motore con attesa facoltativa, dove [README], perché la board di Topics può riusarlo per fan out senza worktree manuali.
5. Bot persistenti in file Markdown: cosa, directory ordinaria con file di identità e memoria esplicita, dove [README], perché gli agenti di board di Topics diventerebbero portabili e ispezionabili.
6. Ricerca sessioni `/ss` in linguaggio naturale: cosa, ritrova qualsiasi sessione da una frase con link diretto, dove [README], perché i topic di Topics sono molti e il browser attuale è per progetto.
7. Gestione worktree da UI con API: cosa, lista e creazione con parsing porcelain e calcolo del prossimo percorso, dove [codice: packages/feature/explorer/src/server/api/git/worktree.ts:144], perché la board che lancia agenti in worktree separate ne ha bisogno.
8. Credenziali per motore in file separati: cosa, un file per chiave mai spedito al browser, dove [codice: packages/feature/agent/src/server/engines/credentials.ts:1], perché Topics in LAN non deve mai esporre segreti al client.
9. Aggiornamento in place con rollback: cosa, handoff che preserva porta e token e ripristina la versione precedente in caso di errore, dove [README], perché il servizio launchd di Topics ha lo stesso problema di update a caldo.
10. Convenzioni React per pannelli sempre montati: cosa, callback stabili e memoizzazione contro re render di alberi fratelli, dove [codice: AGENTS.md:20], perché Topics ha chat, file, terminale e browser coesistenti nello stesso guscio.

## Da evitare

1. Anteprima HTML locale con shell completa e senza sandbox: la documentazione interna ammette esecuzione immediata e navigazione dell'intera finestra, da non replicare senza gabbia [codice: AGENTS.md:78].
2. Supporto multi motore via baseURL: comodo ma insegue i rilasci SDK con ritardo dichiarato, meglio isolarlo dietro adattatore come fanno loro [README].
3. Windows sperimentale con doppia anima nativa e WSL: il vincolo di tenere codice e server nello stesso mondo genera percorsi non risolti, da documentare prima di promettere supporto [README].
4. Tre pannelli sempre montati senza disciplina di memo: un prop instabile invalida silenziosamente i renderer pesanti, e il loro stesso documento lo segnala come rischio [codice: AGENTS.md:20].
5. Estensione Chrome come secondo progetto: utile ma raddoppia la superficie di manutenzione fra web app e Manifest V3 [codice: chrome-extension/manifest.json:1].
6. Deny list per tool in sola lettura: i tool MCP sconosciuti restano fuori classifica, e una classificazione aperta va replicata con allow list esplicita [codice: packages/feature/agent/src/shared/toolMutation.ts:8].
7. Istanze multiple sullo stesso home: il doppio server WebSocket duplica ogni messaggio, serve il guard a istanza singola che loro hanno dovuto aggiungere [codice: src/lib/wsServer.ts:52].

## Fonti

- Repository e stelle: https://github.com/Surething-io/cockpit
- Release: https://github.com/Surething-io/cockpit/releases (v1.0.285 del 2026-10-13, v1.0.284, v1.0.283)
- SHA del clone: `6aa303d3b1ce516621aa299b09ea86069a394a07` via `git -C repos/opencockpit rev-parse HEAD`
- README e tabella comparativa: https://github.com/Surething-io/cockpit/blob/6aa303d3b1ce516621aa299b09ea86069a394a07/README.md
- Manifest e versione: https://github.com/Surething-io/cockpit/blob/6aa303d3b1ce516621aa299b09ea86069a394a07/package.json#L3
- Moduli e dipendenze: https://github.com/Surething-io/cockpit/blob/6aa303d3b1ce516621aa299b09ea86069a394a07/MODULES.md#L14
- Adattatore Agent SDK: https://github.com/Surething-io/cockpit/blob/6aa303d3b1ce516621aa299b09ea86069a394a07/packages/feature/agent/src/effect/claudeSdkAdapter.ts#L18
- Server WebSocket: https://github.com/Surething-io/cockpit/blob/6aa303d3b1ce516621aa299b09ea86069a394a07/src/lib/wsServer.ts#L13
- Autenticazione e token: https://github.com/Surething-io/cockpit/blob/6aa303d3b1ce516621aa299b09ea86069a394a07/src/lib/auth.ts#L10
- Snapshot shadow git: https://github.com/Surething-io/cockpit/blob/6aa303d3b1ce516621aa299b09ea86069a394a07/packages/feature/agent/src/effect/snapshotLive.ts#L3
- Worktree: https://github.com/Surething-io/cockpit/blob/6aa303d3b1ce516621aa299b09ea86069a394a07/packages/feature/explorer/src/server/api/git/worktree.ts#L144
- Credenziali per motore: https://github.com/Surething-io/cockpit/blob/6aa303d3b1ce516621aa299b09ea86069a394a07/packages/feature/agent/src/server/engines/credentials.ts#L1
- Controllo bolla browser: https://github.com/Surething-io/cockpit/blob/6aa303d3b1ce516621aa299b09ea86069a394a07/packages/feature/console/src/server/plugins/browser/browserBubbleControl.ts#L1
- CI multipiattaforma: https://github.com/Surething-io/cockpit/blob/6aa303d3b1ce516621aa299b09ea86069a394a07/.github/workflows/ci.yml#L25
- Issue citate: #7, #8, #9, #10, #11 su https://github.com/Surething-io/cockpit/issues
