# Claude Squad

## In tre righe
Claude Squad è un'app da terminale che avvia più agenti di coding in parallelo, uno per sessione tmux e uno per worktree git isolato [README].
È pensata per chi lavora già nel terminale e vuole far macinare più task in background senza conflitti fra branch [README].
Il suo punto più forte rispetto a Topics è la leggerezza operativa: un solo binario Go, nessuna rete, review del diff e push per sessione già integrati [README].

## Identità
Il repository è `smtg-ai/claude-squad`, con circa 8601 stelle e 51 issue aperte al momento della misura [doc: https://api.github.com/repos/smtg-ai/claude-squad].
La licenza è AGPL-3.0, quindi riuso e modifiche esposte in rete richiedono attenzione legale [codice: LICENSE.md:1].
L'ultimo commit del clone è del 20 agosto 2026, con messaggio di bump alla versione 1.0.20 [release v1.0.20].
Le ultime release sono v1.0.20 (agosto 2026), v1.0.19 (giugno 2026), v1.0.18 (maggio 2026), v1.0.17 e v1.0.16 (marzo 2026): cadenza di qualche release all'anno, con periodi fermi [release v1.0.20].
Il progetto è nato a marzo 2025 ed è maturo come flusso base, ma la manutenzione dichiarata è ridotta, con focus su bug fix e poche migliorie [issue #250].
Le piattaforme di build sono darwin, linux e windows su amd64 e arm64, tranne windows su arm64 [codice: .goreleaser.yaml:6].
Il supporto Windows è comunque rotto nella pratica: l'avvio di una sessione fallisce subito per la dipendenza PTY non supportata [issue #275].
I prerequisiti obbligatori sono `tmux` e la CLI `gh` [README].

## Architettura
Il codice applicativo è quasi tutto Go: 9392 righe in 48 file `.go` misurati con `git ls-files` e `wc -l` [codice: session/instance.go:1].
L'interfaccia è una TUI Bubble Tea con componenti bubbles e lipgloss, senza Electron, Tauri o server web [codice: go.mod:8].
La cartella `web/` contiene solo la landing page statica in Next.js, non un client dell'app [codice: web/package.json:1].
Il modello dei processi è semplice: un processo `cs` più un server tmux esterno, con una sessione tmux per ogni agente [codice: session/tmux/tmux.go:95].
Lo storage è un JSON locale in `~/.claude-squad`, con `state.json` per stato e istanze serializzate [codice: config/state.go:56].
Il dialogo con l'agente non usa Agent SDK, stream-json o ACP: scrive tasti nel PTY e legge l'output con `tmux capture-pane` [codice: session/tmux/tmux.go:476].
Il rilevamento di attività confronta hash SHA-256 dell'output a ogni tick e cerca stringhe di prompt note per programma [codice: session/tmux/tmux.go:246].
Go è usato per tutto: TUI, gestione tmux tramite PTY, comandi git via CLI e demone di background [codice: main.go:27].

## Sessioni e task
Le sessioni parallele sono supportate fino a un limite globale di 10 istanze [codice: app/app.go:24].
Ogni sessione crea un worktree git dedicato con un branch nuovo derivato da HEAD, oppure riusa un branch esistente scelto dall'utente [codice: session/git/worktree.go:72].
La pausa fa commit locale delle modifiche, rimuove il worktree e conserva il branch, copiandolo anche negli appunti [codice: session/instance.go:422].
Il resume ricrea il worktree dal branch e riavvia o riattacca la sessione tmux [codice: session/instance.go:510].
Il push fa commit, poi `gh repo sync` con fallback a `git push -u origin`, e può aprire il branch nel browser del sistema [codice: session/git/worktree_git.go:70].
La creazione con prompt iniziale esiste, tasto `N`, ma ha un bug noto: il prompt può essere inviato prima che la CLI sia pronta e andare perso [issue #266].
Non ci sono code, kanban, tentativi automatici, review assegnate, merge o CI integrate: il flusso finisce al push del branch [README].
Non c'è creazione di PR dal TUI, solo sincronizzazione del branch e apertura pagina [codice: session/git/worktree_git.go:96].

## Usabilità
L'unica superficie è la TUI nel terminale: lista sessioni a sinistra, pannello a tab con anteprima, diff e terminale [codice: app/app.go:124].
I flussi principali sono: `n` nuova sessione, `N` nuova con prompt, `enter` o `o` per attaccarsi, `ctrl-q` per staccarsi, `s` push, `c` pausa, `r` resume, `D` elimina [README].
Il diff è colorato per aggiunte, rimozioni e hunk, con statistiche di righe aggiunte e rimosse [codice: ui/diff.go:12].
I profili di programma permettono di definire comandi nominati e scegliere con frecce in creazione sessione [README].
Le scorciatoie in stile vim includono `j`, `k`, `J`, `K` per navigare e riordinare, più `tab` per cambiare pannello [codice: keys/keys.go:38].
L'onboarding è minimo: va lanciato dentro un repository git, altrimenti esce con errore [codice: main.go:48].
Le schermate di aiuto sono mostrate una volta e tracciate con bitmask nello stato [codice: config/state.go:42].
Non risultano notifiche di sistema, suoni o badge: lo stato si vede solo nella lista [non verificato].

## Browser e anteprima
Non ha un browser integrato né un'anteprima web: la voce non si applica per scelta di design [README].
L'anteprima è il testo del pannello tmux catturato con sequenze ANSI preservate [codice: session/tmux/tmux.go:476].
Non c'è pilotaggio di pagine da parte dell'agente oltre l'invio di tasti nel terminale [codice: session/tmux/tmux.go:239].
Non c'è nulla di simile al co-browse fra dispositivi [non verificato].
L'unico contatto con un browser è `gh browse`, che apre il branch nel browser predefinito del sistema [codice: session/git/worktree_git.go:190].

## Terminale, editor, file
Il terminale è centrale: l'attach collega stdin e stdout direttamente al PTY della sessione tmux [codice: session/tmux/tmux.go:269].
Il detach sano chiude il PTY, cancella il contesto e attende le goroutine; esiste anche un detach che in caso di errore chiama panic [codice: session/tmux/tmux.go:346].
Il pannello terminale separato apre shell tmux nella cartella del worktree dell'istanza selezionata, con sessioni in cache per istanza [codice: ui/terminal.go:28].
Non c'è un editor integrato: i file si modificano tramite l'agente o shell esterna [non verificato].
La vista file è il pannello diff, calcolato contro lo SHA del commit base registrato a setup [codice: session/git/worktree_ops.go:70].
I file non tracciati sono inclusi nel diff tramite `git add -N` prima del calcolo [codice: session/git/diff.go:29].
Lo scrollback tmux è alzato a 10000 righe per conservare più storia [codice: session/tmux/tmux.go:136].

## Remoto e mobile
Non ha accesso da telefono, relay, LAN o cloud: la voce non si applica, è un'app locale [README].
Il demone autoyes gira sullo stesso host e interroga le sessioni a intervalli configurati, senza esporre porte [codice: daemon/daemon.go:17].
Lo stato resta in file locali sotto la home dell'utente [codice: config/config.go:20].
L'unico uso remoto possibile è avviarlo dentro una propria sessione SSH, ma non è una funzione del prodotto [non verificato].
Non risultano cifratura di trasporto, autenticazione o condivisione fra dispositivi [non verificato].

## Provider e protocolli
Il programma predefinito è `claude`, risolto cercando il comando nella shell o nel PATH [codice: config/config.go:107].
Codex si usa passando `-p "codex"` con chiave API esportata, con esempi analoghi per Aider e Gemini [README].
Qualunque comando va bene come programma, quindi altri agenti locali funzionano se parlano da terminale [README].
Il supporto a OpenCode è stato chiesto dagli utenti come programma aggiuntivo da lanciare allo stesso modo [issue #232].
Il rilevamento dei prompt conosce solo stringhe di Claude, Aider e Gemini, mentre Codex non ha rilevamento dedicato [codice: session/tmux/tmux.go:253].
MCP compare solo nel dismiss automatico del prompt di fiducia che cita un nuovo server MCP [codice: session/tmux/tmux.go:167].
Non risultano ACP, server MCP, plugin, hook o skill nel codice ispezionato [non verificato].

## Performance
Non sono dichiarati benchmark di avvio, memoria o rendering [README].
L'avvio sessione attende la comparsa in tmux con backoff esponenziale fino a 2 secondi, poi fallisce [codice: session/tmux/tmux.go:116].
Il polling di stato cattura l'intero pannello e ne calcola due hash SHA a ogni tick, con allocazioni notate come migliorabili nel codice [codice: session/tmux/tmux.go:213].
Gli utenti lamentano TUI lenta con 3 o più sessioni, con tasti ritardati di secondi e creazione attorno ai 10 secondi [issue #215].
Una regressione ha reso lenta l'apertura di nuovi pannelli in una release, poi corretta nella successiva [issue #183].
Il pannello diff teneva l'intero diff in memoria per ogni sessione attiva, poi è stato alleggerito con conteggi numstat per le istanze non selezionate [issue #280].
Go contribuisce alla distribuzione come binario statico senza runtime pesante, ma il collo di bottiglia resta il polling tmux [non verificato].

## Affidabilità e qualità
I file di test misurati sono 10, più un helper, su 48 file Go totali [codice: session/tmux/tmux_test.go:1].
La CI compila su cinque combinazioni di sistema e architettura ed esegue `go test` su tutto il repo, con lint separato [codice: .github/workflows/build.yml:28].
La persistenza salva le istanze in JSON e al riavvio ripristina le sessioni tmux ancora vive [codice: session/instance.go:248].
Se il server tmux è morto, l'istanza viene parcheggiata in pausa invece di bloccare il caricamento delle altre [codice: session/instance.go:254].
Il comando `reset` elimina stato, sessioni tmux e worktree in un colpo solo [codice: main.go:80].
La pausa aveva un bug per cui un errore di controllo modifiche lasciava l'istanza inconsistente, poi corretto [issue #284].
Restano aperti il prompt perso su CLI non pronte e una corsa fra lettore di input e attach tmux [issue #266].
Gli aggiornamenti passano da Homebrew o script di installazione in `~/.local/bin`, senza autoupdate integrato [README].

## Sicurezza e privacy
Usa le CLI già installate con le loro credenziali, senza gestire token propri nel codice ispezionato [codice: config/config.go:107].
La modalità autoyes preme invio automaticamente quando rileva prompt noti, con ovvio rischio di approvare azioni non lette [codice: daemon/daemon.go:48].
Il prompt di fiducia di Claude e quello di Aider vengono chiusi automaticamente cercando stringhe fisse nell'output [codice: session/tmux/tmux.go:159].
L'isolamento è solo a livello di worktree e branch, non risulta sandbox di comandi, container o rete [non verificato].
Non risulta telemetria nel codice ispezionato [non verificato].
Non espone porte in rete: tutto avviene via PTY, tmux e file locali [codice: daemon/daemon.go:17].

## Estendibilità
Non ha MCP, plugin, hook o skill: la voce si applica solo in forma minima [non verificato].
L'unica estensione reale sono i profili di programma in `config.json`, con nome e comando shell [README].
Il flag `-p` permette comandi arbitrari per sessione, senza schema né validazione [codice: main.go:148].
Un hook di setup dell'ambiente nel worktree, con dipendenze e porte isolate, è richiesto ma non implementato [issue #260].
Il sito di documentazione è generato dalla cartella `web`, separata dal binario [codice: web/package.json:1].

## Da prendere per Topics
1. Limite globale di istanze con avvio in background e finalizzazione alla risposta: evita doppi invii durante il setup, come fa il flag dedicato [codice: app/app.go:80].
2. Pausa con commit automatico locale e branch copiato negli appunti: rende il resume a prova di distrazione [codice: session/instance.go:460].
3. Diff leggero con numstat per le righe non selezionate e diff completo solo per la selezione: riduce memoria con molte sessioni [codice: session/instance.go:609].
4. Dismiss assistito dei prompt di fiducia noti, limitato a stringhe esatte: riduce gli stop ripetitivi senza autoyes totale [codice: session/tmux/tmux.go:159].
5. Profili di programma nominati con default riordinato per primo: commuta fra agenti senza ricordare comandi lunghi [codice: config/config.go:61].
6. Parcheggio in pausa quando il backend di sessione è morto, senza bloccare le altre: un riavvio non deve nascondere il lavoro superstite [codice: session/instance.go:248].
7. Push con `gh repo sync` e fallback a `git push -u origin`: copre sia repo già collegati sia branch nuovi [codice: session/git/worktree_git.go:96].
8. Ricerca branch con limite ai primi 50 ordinati per data: rende riusabile il selettore di branch esistenti senza liste infinite [codice: session/git/worktree_git.go:21].

## Da evitare
1. Invio del prompt subito dopo l'avvio senza attesa di prontezza: perde il prompt su CLI lente, come mostra il bug ancora aperto [issue #266].
2. Autoyes che preme invio su match testuale di prompt: approva alla cieca, anche in un demone che gira da solo [codice: daemon/daemon.go:48].
3. Detach che chiama panic in caso di errore PTY: meglio degradare che buttare giù tutta la TUI [codice: session/tmux/tmux.go:387].
4. Dipendenze esterne obbligatorie come tmux e `gh`: chi non li ha non parte proprio, e Windows resta scoperto [issue #275].
5. Polling che lancia `git add -N` in concorrenza con commit e pause: la corsa risultante ha già corrotto stati di pausa [issue #284].
6. Salvataggio del contenuto intero del diff nello stato persistito: gonfia lo state e ripropone il problema di memoria già corretto a runtime [codice: session/storage.go:37].
7. Assunzioni Unix nel lancio shell e nella risoluzione comandi: su Windows servono rami dedicati, non fallback a `/bin/sh` [issue #275].

## Fonti
- Repository e documentazione: [doc: https://github.com/smtg-ai/claude-squad]
- Sito del progetto: [doc: https://smtg-ai.github.io/claude-squad/]
- README del progetto [README]
- Metadati stelle, licenza e push: [doc: https://api.github.com/repos/smtg-ai/claude-squad]
- Release v1.0.20, v1.0.19, v1.0.18, v1.0.17, v1.0.16 [release v1.0.20]
- Avvio sessione tmux con backoff: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/session/tmux/tmux.go#L95
- Cattura pannello e hash di stato: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/session/tmux/tmux.go#L246
- Gestione trust prompt: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/session/tmux/tmux.go#L159
- Ciclo vita istanza, pausa e resume: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/session/instance.go#L203
- Diff completo e numstat: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/session/git/diff.go#L25
- Setup worktree e commit base: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/session/git/worktree_ops.go#L13
- Push e sync con `gh`: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/session/git/worktree_git.go#L70
- Configurazione e profili: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/config/config.go#L35
- Stato e storage JSON: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/config/state.go#L56
- Demone autoyes: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/daemon/daemon.go#L17
- Piattaforme di build: https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/.goreleaser.yaml#L4
- Issue su prompt perso, lentezza TUI, regressione pannelli, memoria diff, pausa inconsistente, Windows, manutenzione, OpenCode, hook ambiente: [issue #266], [issue #215], [issue #183], [issue #280], [issue #284], [issue #275], [issue #250], [issue #232], [issue #260]
