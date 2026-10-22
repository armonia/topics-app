# Agent Deck

## In tre righe
Agent Deck è un centro di comando da terminale per flotte di agenti di coding: una sola TUI mostra
tutte le sessioni attive su più progetti e tool, con gruppi, fork, worktree e costi [README].
È pensato per chi lancia decine di sessioni in parallelo e le orchestra da terminale, CLI, web
locale o telefono via conductor [README].
Il suo punto più forte rispetto a Topics è la maturità operativa sulla flotta: status detection
multi tool, fork nativo, pool di socket MCP e automazione conductor con heartbeat e watcher
[README].

## Identità
Repository `asheshgoplani/agent-deck`, binario `agent-deck`, installazione via script, Homebrew, Go
o sorgenti [README]. Al momento del clone contava 1081 stelle su GitHub [non verificato]. Licenza
MIT [README]. Ultimo commit `8d0f1fe` del 12 ottobre 2026 [non verificato]. Ultima release v1.16.28
del 10 ottobre 2026, preceduta da v1.16.27, v1.16.26, v1.16.25 e v1.16.24 in una settimana
[release v1.16.28]. Progetto nato a dicembre 2025, quindi giovane ma con cadenza di release quasi giornaliera
e pipeline di validazione delle PR dichiarata entro un giorno [README]. Piattaforme: macOS, Linux,
Windows via WSL [README].

## Architettura
Quasi tutto il codice è Go: circa 771 mila righe su 2949 file, per un totale di circa 1,65 milioni
di righe nel repo includendo asset e demo [non verificato]. Il framework TUI è Bubble Tea di Charm,
con i componenti Bubbles e Lipgloss dichiarati nelle dipendenze [codice: go.mod:10]. Il modello dei
processi è a sessioni tmux: ogni sessione agente gira in un pannello tmux creato da una funzione
dedicata [codice: internal/tmux/tmux.go:2042]. Lo stato vive in SQLite via driver
`modernc.org/sqlite`, con checkpoint WAL e gestione dei transient BUSY [codice:
internal/statedb/statedb.go:346]. Con l'agente parla lanciando i CLI originali non modificati
(Claude, Codex, Gemini e altri) dentro tmux e leggendone stato dal pannello, dagli hook o dai
transcript, non via Agent SDK né stream-json documentato [README]. Non risulta uso di Rust: la
velocità è cercata in Go con pooling, cache ed esclusioni mirate, non con un guscio nativo [non
verificato]. IPC: pipe di controllo tmux, socket Unix per il pool MCP, WebSocket e SSE per la web UI
[README].

## Sessioni e task
Le sessioni parallele sono il cuore del prodotto: lista unica, gruppi annidati, ricerca fuzzy, fork
e archiviazione con ripristino [README]. I worktree git isolano i rami per sessione, con creazione,
merge e pulizia degli orfani da CLI [README]. Il fork rapido eredita contesto conversazionale
tramite il fork nativo di ciascun tool ed è supportato per Claude, OpenCode, Pi, Codex e Oh My Pi
[README]. Il fork completo crea anche worktree, riporta le modifiche non committate e replica
l'isolamento Docker del padre [README]. Non c'è una kanban con code, tentativi, review, land e
publish come in Topics: l'orchestrazione spetta alle sessioni conductor, che monitorano le altre,
rispondono in autonomia e scalano a telefono quando serve [README]. Le notifiche di transizione
`running -> waiting|error|idle` viaggiano verso la sessione padre tramite un demone dedicato
[README]. Non risultano PR e CI integrate nel prodotto [non verificato].

## Usabilità
Superfici: TUI nel terminale, CLI completa con completion per bash, zsh e fish, web UI locale e
controllo remoto via Telegram o Slack [README]. I flussi principali sono tastiera-centrici: un tasto
per creare, cercare, forkare, archiviare, aprire MCP, skill, costi e watcher [README]. La ricerca
fuzzy filtra anche per stato con sigilli dedicati, e c'è una ricerca globale sulle conversazioni
Claude [README]. Le notifiche arrivano nella barra di stato di tmux, via web push a tab in
background e via Telegram o Slack dal conductor [README]. L'onboarding privilegia la CLI e il
dialogo di nuova sessione, che ricorda l'ultimo tool e guida modello, path e opzioni senza creare
per sbaglio [README]. Diff e review di codice non sono una vista dedicata: si lavora nel pannello
della sessione agente [non verificato].

## Browser e anteprima
Non ha un browser integrato pilotabile dall'agente né anteprima di pagina: il pannello è un
terminale tmux, e la web UI mostra terminale via xterm, costi, archivio e impostazioni [README]. Non
c'è nulla di simile al co-browse fra dispositivi di Topics [non verificato]. Il terminale web ha
avuto problemi veri di integrazione con gli appunti e la selezione, come l'ignorare OSC 52 verso la
clipboard del browser [issue #2370] e la selezione con Option trascinato nelle sessioni che
catturano il mouse [issue #2372]. La web UI riceve aggiornamenti live via SSE ed è presente un
Command Center per la flotta [README].

## Terminale, editor, file
Il terminale è tmux reale: attach locale e remoto, copia dal pannello, scorciatoie documentate e
badge di notifica nella status bar [README]. Non c'è un editor integrato: i file si modificano
tramite l'agente nel suo pannello o negli strumenti esterni [non verificato]. Per i file offre
sparse checkout ereditato nei worktree, copia dei file gitignored via `.worktreeinclude` e script di
setup per worktree [README]. La sandbox Docker monta il progetto in lettura e scrittura isolando il
resto del sistema, con shell nel container e sessioni one-shot [README]. L'archiviazione ferma il
processo tmux ma conserva conversazione, metadati, worktree e legami di parentela [README].

## Remoto e mobile
L'accesso remoto passa per istanze su server SSH gestite dal terminale locale: registrazione, lista
sessioni, attach, drain dei report e aggiornamento binari [README]. Il polling remoto è in
background, con pausa di 2 minuti dopo un fallimento di autenticazione e comandi JSON per lo
scripting [README]. La web UI si espone in LAN solo con token, con file di token a permessi 600 e
rifiuto del bind non loopback senza autenticazione [codice: internal/web/bind.go:32]. Il telefono è
cittadino di prima classe solo via conductor: bot Telegram o Slack con routing `nome: messaggio`,
heartbeat periodico e comandi di stato aggregato [README]. Non risultano relay cloud proprietari né
cifratura end to end oltre TLS del bridge Slack, token web e verifiche HMAC sui webhook [README].

## Provider e protocolli
La tabella ufficiale elenca Claude Code, Codex, Gemini CLI, OpenCode, Pi e Hermes, con integrazione
piena per Claude e Gemini e parziale per gli altri [codice: internal/harness/table.go:34]. La
documentazione aggiunge Copilot, Crush, Cursor terminale, DeepSeek Harness, Oh My Pi e tool
personalizzati via configurazione [README]. Claude Code gira non modificato con il login dell'utente
e il progetto dichiara di non leggere né riusare token di login per chiamare Anthropic in proprio
[README]. MCP è supportato con manager per sessione, toggle locale o globale e pool di socket
condivisi con riconnessione automatica [README]. Non risulta supporto al protocollo ACP: i
riferimenti trovati riguardano testi interni, non un client ACP [non verificato]. Non risulta un
server MCP esposto da Agent Deck verso gli agenti, a differenza di Topics [non verificato].

## Performance
Dichiarano che il pool di socket MCP riduce la memoria MCP dell'85-90% con recupero in circa 3
secondi dopo un crash [README]. Il resto del quadro viene dalle issue: con circa 30 sessioni la
connessione del terminale web attende 5-7 secondi dietro il refresh degli snapshot [issue #2663]. La
scansione di esclusione Codex era quadratica sui sottoprocessi tmux, con un deck al 250-370% di CPU
e lista JSON in 4,4 secondi [issue #2284]. Il rendering TUI arrivava al 51% di CPU nel passo di
layout con circa 55 sessioni [issue #1753]. Tempeste di fork tmux con 60 sessioni portavano a
150-350% di CPU sostenuta [issue #1728]. Risultano anche freeze UI di 2-11 secondi dopo il detach da
sessioni lunghe [issue #39] e lentezza di digitazione diretta nel TUI [issue #1131]. Sul fronte
remoto, il passaggio di stato non scala sotto carico reale [issue #2332]. Esiste una suite di budget
di performance e un gate nei test [non verificato].

## Affidabilità e qualità
I file di test Go sono 1993 su 2949 file Go totali, una copertura per file molto alta [non
verificato]. La CI elenca decine di workflow: test Go, lint, govulncheck, CodeQL, regressioni
settimanali, accettazione su persistenza, salute runtime e smoke di performance [non verificato]. Le
sessioni persistono in SQLite con snapshot, archiviazione e ripristino senza riavvio automatico del
processo [README]. Gli aggiornamenti sono frequenti e quasi giornalieri, con auto aggiornamento dei
remoti e verifica degli artefatti [README]. I punti deboli emergono dalle issue: processi proxy MCP
orfani dopo l'uscita della sessione [issue #2649], istanze TUI concorrenti che si contendono le pipe
tmux e mandano tutto in errore [issue #927], e la cancellazione che lascia una finestra di undo di
30 secondi [README].

## Sicurezza e privacy
La policy chiede segnalazioni private via advisory o email e dichiara Dependabot, govulncheck,
CodeQL, lint e attestation SLSA sugli artefatti, con tre tag senza attestazione per un guasto di
pipeline [doc: https://github.com/asheshgoplani/agent-deck/blob/main/SECURITY.md]. Le credenziali
restano nei CLI originali: niente copia del login Claude, condivisione dell'autenticazione host nei
container con eccezione per il login macOS in Keychain, e token di setup via file con permessi 600
[README]. La sandbox Docker isola il sistema pur montando il progetto in scrittura [README]. La
telemetria è opt-in, spenta di default, anonima e verificabile in anteprima prima dell'invio [doc:
https://github.com/asheshgoplani/agent-deck/blob/main/TELEMETRY.md]. Le porte esposte sono la web UI
su loopback di default e i listener dei watcher, con webhook GitHub verificati via HMAC e deduplica
in SQLite [README].

## Estendibilità
MCP è il perno: definizione una volta in configurazione, attach per sessione o globale, con riavvio
automatico [README]. Le skill Claude si gestiscono da un pool dedicato con materializzazione in
`.claude/skills` e stato di progetto [README]. Hook per Claude Code, Codex e Pi alimentano lo status
detection e si installano da CLI [README]. I watcher estendono il sistema verso l'esterno con
quattro adattatori inclusi: webhook generico, GitHub, ntfy e Slack [README]. C'è anche una skill
pubblica per contribuire con agenti e una guida di configurazione completa [README]. Non risultano
plugin TUI di terze parti né API di estensione oltre CLI, watcher e hook [non verificato].

## Da prendere per Topics
1. Pool di socket MCP condivisi: riduce la memoria dell'85-90% con riconnessione in 3 secondi [README]. Conterebbe perché Topics lancia molti agenti e ogni duplicazione di server MCP pesa su ogni topic.
2. Fork che eredita worktree, modifiche non committate e isolamento Docker in un tasto [README]. Conterebbe perché rende economico esplorare varianti senza perdere contesto, come i topic paralleli.
3. Notifiche di transizione verso la sessione padre con demone dedicato [README]. Conterebbe perché la kanban di Topics ha già code e review: il segnale `running -> waiting|error` è il tassello per svegliare l'orchestratore.
4. Dashboard costi con budget, breakdown per modello e sincronizzazione storica dai transcript [README]. Conterebbe perché Topics non traccia la spesa per topic e i transcript Claude la contengono già.
5. Ricerca fuzzy con filtri di stato e ricerca globale sulle conversazioni [README]. Conterebbe perché ritrovare un topic fra decine di chat è il collo di bottiglia quotidiano.
6. Dialogo di nuova sessione che non crea mai per sbaglio e ricorda l'ultimo tool [README]. Conterebbe perché evita lanci con modello o path sbagliati, errore costoso con gli agenti.
7. Drain remoto dei report nel conductor locale con deduplica [README]. Conterebbe perché Topics punta su LAN e dispositivi: tirare i report senza consumarli sul remoto è il pattern giusto.
8. Telemetria opt-in verificabile con anteprima esatta del payload [doc: https://github.com/asheshgoplani/agent-deck/blob/main/TELEMETRY.md]. Conterebbe come modello onesto per eventuali statistiche d'uso di Topics.

## Da evitare
1. Status detection con scansioni quadratiche di sottoprocessi: un deck arrivava al 250-370% di CPU [issue #2284]. Meglio eventi push dagli hook che polling ingenuo.
2. Refresh sincrono che blocca il terminale web per secondi con 30 sessioni [issue #2663]. Il percorso di attach deve saltare la coda dello snapshot.
3. Istanze TUI concorrenti che duellano sulle stesse pipe tmux e mandano tutto in errore [issue #927]. Serve single instance o lock chiaro come quello di Topics sulla porta 3333.
4. Processi proxy MCP orfani dopo l'uscita [issue #2649]. Il reaping va verificato nei test di teardown, non solo nel percorso felice.
5. Complessità del bridge Telegram con topologie che perdono poller in ogni sessione [README]. Una sola sessione proprietaria del canale è un vincolo fragile da documentare, non da imitare alla leggera.

## Fonti
- README e documentazione nel clone `repos/agent-deck`, commit `8d0f1fe1506dec1405d774c42c178291d1b20f40`
- https://github.com/asheshgoplani/agent-deck/blob/8d0f1fe1506dec1405d774c42c178291d1b20f40/internal/harness/table.go#L34
- https://github.com/asheshgoplani/agent-deck/blob/8d0f1fe1506dec1405d774c42c178291d1b20f40/internal/tmux/tmux.go#L2042
- https://github.com/asheshgoplani/agent-deck/blob/8d0f1fe1506dec1405d774c42c178291d1b20f40/internal/statedb/statedb.go#L346
- https://github.com/asheshgoplani/agent-deck/blob/8d0f1fe1506dec1405d774c42c178291d1b20f40/internal/web/bind.go#L32
- https://github.com/asheshgoplani/agent-deck/blob/main/SECURITY.md
- https://github.com/asheshgoplani/agent-deck/blob/main/TELEMETRY.md
- Release v1.16.28, issue #2663, #2674, #2284, #1753, #1728, #2332, #39, #1131, #2370, #2372, #2649, #927, #2646

