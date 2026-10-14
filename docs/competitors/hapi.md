# HAPI

## In tre righe

HAPI è un'alternativa locale e open source a Happy: avvolge gli agenti
già installati (Claude Code, Codex, Cursor e altri) e li rende pilotabili
da telefono, web o Telegram senza perdere la sessione nel terminale.
È pensato per chi programma alla postazione e vuole continuare da mobile,
con approvazione dei permessi in un tocco e handoff senza restart.
Il suo punto più forte rispetto a Topics è il parco mobile maturo: app
native iOS e Android, PWA installabile, Telegram Mini App e relay cifrato
già pronti e documentati.

## Identità

Repository `tiann/hapi`, circa 5233 stelle e 604 fork al momento del clone,
licenza AGPL-3.0 [README].
Progetto giovane, nato a fine dicembre 2025, ma molto attivo: ultimo commit
il 13 ottobre 2026 con SHA `5847b03`, release frequenti a settembre 2026
fino a [release v0.30.7].
Si dichiara esplicitamente discendente di Happy, con credito al progetto
originale [README].
Piattaforme: macOS, Linux e Windows per CLI e hub, più iOS 17 o successivi
e Android 8.0 o successivi per le app native
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/native-apps.md].
La maturità è buona per l'uso da telefono, minore per orchestrazione
multi agente: non ha board kanban né code di task, solo lista sessioni
e runner remoto.
Il confronto dichiarato con Happy è architetturale: hub decentralizzato
per singolo utente contro cloud centralizzato multiutente
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/why-hapi.md].
Per Topics è un concorrente laterale: non fa topic né co-browse, ma copre
benissimo il caso d'uso "agente pilotato dal divano".

## Architettura

Il monorepo usa workspace Bun: `cli`, `shared`, `hub`, `web`, `website`,
`docs` e `relay`, più cartelle `ios` e `android` con toolchain separate
[codice: package.json:5].
Misure sul clone: circa 391.000 righe TypeScript e TSX in 1904 file, circa
63.700 righe Swift in 314 file, circa 56.000 righe Kotlin in circa 300 file,
per un totale di 2905 file tracciati.
Il modello dei processi è semplice: la CLI avvolge l'agente nativo
in locale e parla all'hub via Socket.IO sul namespace `/cli` con token
di accesso; l'hub espone REST più SSE ai client; i terminali web usano
il namespace `/terminal` con JWT client [codice: AGENTS.md:38].
Lo storage è SQLite incorporato nell'hub, senza PostgreSQL né Redis
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/why-hapi.md].
Il deploy è un singolo binario che include CLI, hub, web app e database
[codice: package.json:19].
Non usa Rust né Go: la velocità viene da Bun come runtime unico per CLI
e hub, con binari tunwg scaricati a parte per il relay
[codice: package.json:21].
Con l'agente parla in tre modi: wrapper del TUI nativo in locale, Claude
Agent SDK o `codex app-server` per i casi speciali, ACP su stdio come
backend condiviso per quasi tutti gli agenti in remoto
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/agents.md].
Il protocollo condiviso è `@hapi/protocol`, con schemi Zod in `shared/src/schemas.ts`
e aggiornamenti versionati con rifiuto degli update obsoleti [codice: AGENTS.md:33].

## Sessioni e task

Le sessioni sono uno a uno con l'agente lanciato: `hapi <agente>`
da terminale oppure spawn remoto da web o telefono tramite runner
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/how-it-works.md].
Sessioni parallele sì, su più macchine e namespace; code, kanban,
tentativi automatici, review strutturata, merge e CI: no, non esistono.
La ripresa funziona con `hapi resume`, anche per sessioni nate da telefono
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/agents.md].
Il supporto worktree è delegato all'agente: per Cursor usa `--worktree`
nativo in `~/.cursor/worktrees`, con guardia esplicita contro worktree
annidati che bloccano ACP
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/agents.md].
C'è una Work Graph per sessione nell'hub, con store dedicato
[codice: hub/src/store/workGraph.ts:1], ma resta una vista di avanzamento,
non un orchestratore.
Le issue aperte mostrano i limiti: resume di Claude che può creare un nuovo
id e perdere la memoria dell'agente [issue #1933], sessioni DSH che restano
attive dopo l'uscita del processo [issue #1925], cambio Yolo di Codex
applicato solo al turno successivo per limite upstream [issue #1923].
Per Topics il divario è chiaro: HAPI gestisce sessioni singole molto bene,
ma non sa orchestrare flotte di agenti con code e land.

## Usabilità

Superfici: terminale, web app React, PWA installabile, Telegram Mini App,
app native iOS (SwiftUI e UIKit) e Android (Kotlin Compose)
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/how-it-works.md].
Flussi principali: lista sessioni, chat con streaming, approvazione
o diniego dei permessi, composer con allegati e bozze, controlli
di sessione come pin, archivio, stop e resume
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/native-apps.md].
Diff e review: il file browser mostra file e diff Git, anche da telefono
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/how-it-works.md].
Notifiche su cinque canali: push native, Telegram, ServerChan, Web Push
e voce [doc: https://github.com/tiann/hapi/blob/main/docs/guide/notifications.md].
Onboarding semplice: un comando per l'hub con relay, QR o link
`hapicompanion://bind` per associare il telefono
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/native-apps.md].
Dettaglio curato: doppio spazio per tornare all'input locale dal terminale,
comandi slash inoltrati all'agente in remoto, dettatura che inserisce testo
senza inviarlo da sola
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/agents.md].
La resa matematica usa KaTeX con delimitatori `\(...\)` preferiti
per non confondere i dollari delle valute
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/agents.md].
Nei aperti: bersaglio touch troppo piccolo per pulire la ricerca [issue #2019],
mancano filtri di lista per sessioni attive e lavorate [issue #2002].

## Browser e anteprima

Non ha un browser integrato né anteprima pilotabile dall'agente: questa
sezione non si applica per confronto diretto con il co-browse di Topics.
Quello che c'è è un file browser con ricerca file, stato Git e lettura
dei diff, più terminale remoto e Work Graph solo su web
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/how-it-works.md].
Le app native non hanno terminale né Work Graph: quelle restano funzioni
web [doc: https://github.com/tiann/hapi/blob/main/docs/guide/how-it-works.md].
Niente di simile al co-browse Mac e iPad con DOM rispecchiato: la
sincronizzazione fra dispositivi è a livello di messaggi di chat via REST
e SSE, non di pagina web condivisa.
Per Topics questo è il divario più netto a nostro favore, e va difeso.

## Terminale, editor, file

Il terminale remoto è una vista web su PTY reale: `TerminalManager`
lancia sottoprocessi Bun con terminale dedicato, massimo 4 per sessione
e timeout di inattività di 15 minuti
[codice: cli/src/terminal/TerminalManager.ts:28].
Le variabili sensibili (`CLI_API_TOKEN`, chiavi API, token Telegram) sono
filtrate dall'ambiente ereditato, mentre i marcatori di contesto agente
sono rimossi apposta perché il terminale web è per persone, non per tool
[codice: cli/src/terminal/TerminalManager.ts:30].
Sul socket ci sono buffer separati per terminale agente e terminale utente
[codice: hub/src/socket/terminalRegistry.ts:1].
L'editor non esiste come tale: si sfogliano file e diff, poi si chiede
all'agente di modificare.
I workspace remoti sono esposti in modo opt-in con
`hapi runner start --workspace-root <path>` [README].
La web app può mettere lo scrollback del terminale nel composer [issue #2011];
gli allegati partono in upload appena selezionati, con limite di 50 MiB
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/pwa.md].

## Remoto e mobile

È il cuore del progetto.
L'hub ascolta di default su loopback `127.0.0.1:3006` e l'accesso remoto
passa per tunnel: relay pubblico `hapi hub --relay` con WireGuard più TLS,
Cloudflare Tunnel con named tunnel, Tailscale o ngrok
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/deployment.md].
Il relay inoltra solo pacchetti cifrati e non legge i contenuti
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/why-hapi.md].
Le app native richiedono origine HTTPS e si associano con QR, deep link
o inserimento manuale di URL e token, con token per namespace del tipo
`token:team` [doc: https://github.com/tiann/hapi/blob/main/docs/guide/native-apps.md].
Android rifiuta gli URL in chiaro ovunque, anche nelle build debug; iOS
accetta HTTP solo se scelto esplicitamente e avvisa che non è cifrato
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/native-apps.md].
La PWA pesa circa 500 KB al primo caricamento, funziona offline
in lettura e supporta share target su Android; le azioni offline non sono
accodate, con banner visibile e ripresa alla riconnessione
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/pwa.md].
La persistenza in background è affidata a launchd, systemd, pm2 o nohup,
con nota esplicita sul sonno di macOS che sospende i processi
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/deployment.md].
Più hub associabili con uno attivo alla volta; il logout rimuove
credenziali e tenta di deregistrare il token push
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/native-apps.md].

## Provider e protocolli

Dieci agenti supportati con matrice esplicita: Claude Code, Codex, Cursor,
Grok Build, Copilot, Kimi, OpenCode, DeepSeek Harness, Antigravity e Pi;
Gemini è stato rimosso dopo il tramonto della CLI consumer di Google
e resta solo come comando fantasma con errore chiaro
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/agents.md].
Il protocollo remoto dominante è ACP su stdio con backend condiviso,
che dà permessi bidirezionali, piani, todo, domande, cataloghi modelli
e resume via `session/load`
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/agents.md].
Casi speciali: Claude usa Agent SDK in remoto, Codex usa `codex app-server`
dalla 0.154.0, Pi usa RPC JSON su stdio, Antigravity gira headless per turno
con NDJSON [doc: https://github.com/tiann/hapi/blob/main/docs/guide/agents.md].
MCP è esposto come bridge stdio con tool come `change_title`, `display_image`, `display_video`, `display_media`, `list_peers`, `ping_peer` e `inspect_peer` [codice: cli/src/codex/happyMcpStdioBridge.ts:4].
I peer sulla stessa hub e namespace permettono scoperta e messaggi
fra sessioni, anche cross host
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/how-it-works.md].
I modi di permesso sono per agente, con cataloghi dedicati in
`shared/src/modes.ts` [codice: shared/src/modes.ts:1].

## Performance

Nessun benchmark dichiarato nel repo.
L'architettura punta sulla leggerezza: un binario, SQLite, SSE, PWA
da 500 KB con cache differenziata per shell e API
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/pwa.md].
Lamentele e rischi nelle issue: SSE che diffonde `active:false` fasulli
e fa sfarfallare i client fra online e offline [issue #1986], lista modelli
Codex che avvia `app-server` a freddo e può andare in timeout [issue #1937],
proposta aperta di riuso paginato e scroll virtualizzato stabile per
conversazioni lunghe [issue #1956].
Rust per la velocità non si applica: il runtime è Bun ovunque.
Il relay pubblico limita l'emissione chiavi per IP pubblico, con 429
esplicito che può colpire chi condivide CGNAT o egress aziendale
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/deployment.md].

## Affidabilità e qualità

Il repo conta 945 file di test e spec, con Vitest per CLI e web e Bun test
per hub, shared e relay, più Playwright per end to end e conformance nativa
[codice: AGENTS.md:53].
Le fixture in `shared/fixtures` sono generate dalla pipeline di chat web
e mai modificate a mano, con controllo di drift in CI
[codice: AGENTS.md:40].
Lo store SQLite ha migrazioni numerate almeno dalla v8 alla v25, segno
di schema in evoluzione ma gestita [codice: hub/src/store/index.ts:1].
Il recupero dopo crash è affidato al supervisore esterno (pm2, systemd
con `Restart=always`, launchd con `KeepAlive`) più reaping degli orfani
nel runner [doc: https://github.com/tiann/hapi/blob/main/docs/guide/deployment.md].
Punti deboli noti: la ripresa può fallire in worktree quando Claude Code
sposta il transcript [issue #1950], e i PID recuperati possono confermare
resume mentre la CLI è disconnessa [issue #1939].
La verifica richiesta dal repo scala con l'impatto: doc, package locale,
contratti condivisi, codice nativo [codice: AGENTS.md:44].

## Sicurezza e privacy

Modello onesto e documentato: i dati a riposo sull'hub sono in chiaro,
protetti dal sistema operativo, non cifrati a livello applicativo
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/why-hapi.md].
Le credenziali degli agenti sono riusate dal CLI locale, non inventate:
login via device code per Grok, chiavi da ambiente, mai scritte in config
o log [doc: https://github.com/tiann/hapi/blob/main/docs/guide/agents.md].
Il relay pubblico vede solo pacchetti cifrati WireGuard più TLS
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/why-hapi.md].
Il relay push ufficiale cifra i contenuti con AES-256-GCM sotto chiave
per dispositivo, con rate limit di 30 push al minuto per token e 300
per IP, senza persistenza dei payload
[doc: https://github.com/tiann/hapi/blob/main/relay/README.md].
Scelta controversa ma dichiarata: nessuna autenticazione client sul relay
push, il possesso del device token è la capability; chi lo ruba consuma
budget e scatena avvisi generici ma non legge i contenuti
[doc: https://github.com/tiann/hapi/blob/main/relay/README.md].
Porte esposte: hub su 3006 in loopback di default, da aprire solo dietro
proxy HTTPS o tunnel; il bypass TLS è solo per sviluppo, mai su reti
pubbliche [doc: https://github.com/tiann/hapi/blob/main/docs/guide/deployment.md].
Telemetria non documentata; la policy di sicurezza del repo rimanda solo
alla segnalazione vulnerabilità
[doc: https://github.com/tiann/hapi/blob/main/SECURITY.md].

## Estendibilità

MCP con bridge stdio e proxy HTTP, più tool peer fra sessioni, con
`spawn_peer` su macchina remota proposto in [issue #1931].
Hook: un `hookForwarder` in CLI inoltra eventi, e il legacy Cursor
intercetta risposte sintetiche pericolose di `AskQuestion` riscrivendole
come errore esplicito
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/agents.md].
Skill: scoperta da `.grok/skills`, `~/.grok/skills` e `.agents/skills`
condivise, con picker su web
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/agents.md].
Plugin veri e propri no: l'estensione passa da nuovi flavor agente
nel registry CLI e da comandi slash inoltrati
[codice: cli/src/commands/registry.ts:1].
Il contratto client per le app native è documentato e versionato,
con conformance su fixture ma senza parità UI garantita
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/native-apps.md].

## Da prendere per Topics

1. Handoff locale e remoto senza restart: stessa sessione guidata dal TUI
nativo oppure dal telefono, con ritorno all'input locale con doppio spazio
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/how-it-works.md].
Per Topics significherebbe topic continui fra desktop e iPad senza ricreare
contesto.
2. Approvazione permessi one tap da mobile con composer unificato e coda
di messaggi: il flusso permesso, notifica, approva, continua è il meglio
rifinito del progetto
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/how-it-works.md].
Conterebbe perché Topics ha già i 15 tool di co-browse ma non il percorso
mobile di approvazione.
3. Relay cifrato a zero configurazione con fallback a tunnel propri:
`hub --relay` contro Cloudflare named tunnel, con avviso che Quick Tunnel
non supporta SSE
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/deployment.md].
Per Topics in LAN sarebbe la via per uscire dalla rete locale senza
account terzi.
4. Push relay E2E con AES-256-GCM per dispositivo e rate limit in memoria:
disegno copiabile per le notifiche Topics su iPad e telefono senza tenere
credenziali Apple e Firebase sui client
[doc: https://github.com/tiann/hapi/blob/main/relay/README.md].
5. Backend ACP condiviso per N agenti con catalogo permessi per flavor
in `shared/src/modes.ts` [codice: shared/src/modes.ts:1].
Per Topics ridurrebbe il costo di aggiungere Codex, Cursor o OpenCode
accanto a `claude -p`.
6. Fixture di conformance generate dalla pipeline web come verità per
i client: niente modifiche a mano, CI che controlla il drift
[codice: AGENTS.md:40].
Conterebbe per tenere allineati Mac e iPad sul co-browse DOM.
7. PWA con banner di aggiornamento non liquidabile e ricarica controllata
dall'utente, più share target Android via service worker
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/pwa.md].
Per Topics significherebbe PWA telefono credibile senza app native subito.
8. Comando fantasma per provider rimossi, con errore chiaro e sessioni
vecchie ancora leggibili
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/agents.md].
Per Topics è il modo pulito di gestire il motore nativo fuori studio
senza rompere i topic esistenti.

## Da evitare

1. Database in chiaro sull'hub senza cifratura a riposo
[doc: https://github.com/tiann/hapi/blob/main/docs/guide/why-hapi.md].
Topics gira in LAN ma su Mac con conversazioni sensibili: meglio cifrare
o almeno documentare il rischio.
2. Push relay senza autenticazione client, con token come unica capability
[doc: https://github.com/tiann/hapi/blob/main/relay/README.md].
Il contenimento via rate limit non basta se il token gira nei log.
3. SSE come unico realtime senza ripresa garantita: epoch perse e broadcast
fasulli di presenza sono issue note [issue #1986] [issue #1941].
Per il co-browse DOM servono epoch e riconciliazione, non solo event stream.
4. Worktree delegati all'agente con casi di hang e transcript spostati
[issue #1085] [issue #1950].
Topics lancia agenti in worktree proprie: meglio un solo gestore worktree
interno invece di N dialetti per agente.
5. Sessioni fantasma dopo uscita del processo agente [issue #1925].
Topics deve sorvegliare i PID reali invece di fidarsi dello stato
dichiarato.
6. Cambio permessi mid-turn applicato solo al turno dopo [issue #1923].
Se Topics copia i modi di permesso, deve mostrare quando il cambio
è attivo davvero, non quando è chiesto.

## Fonti

- Repository e README: https://github.com/tiann/hapi
- Commit SHA del clone: `5847b03` del 13 ottobre 2026
- Architettura e flussi: https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/docs/guide/how-it-works.md
- Agenti supportati: https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/docs/guide/agents.md
- Perché HAPI contro Happy: https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/docs/guide/why-hapi.md
- App native e pairing: https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/docs/guide/native-apps.md
- Deploy e tunnel: https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/docs/guide/deployment.md
- PWA: https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/docs/guide/pwa.md
- Notifiche: https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/docs/guide/notifications.md
- Push relay e minaccia: https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/relay/README.md
- Convenzioni e verifica: https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/AGENTS.md
- MCP bridge: https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/cli/src/codex/happyMcpStdioBridge.ts#L4
- Terminale PTY: https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/cli/src/terminal/TerminalManager.ts#L28
- Catalogo permessi: https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/shared/src/modes.ts#L1
- Release: https://github.com/tiann/hapi/releases/tag/v0.30.7
