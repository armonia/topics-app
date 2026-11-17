# Analisi

Sezioni: 1 Cosa succede oggi quando il Mac sparisce · 2 Mappa di ciò che gira solo sul Mac · 3 Account Claude sul server · 4 Il ritorno del Mac.

## 1. Cosa succede oggi a una card su un nodo quando il Mac sparisce

Tutto letto dal codice di questo ramo (base `main`). «Dedotto» = non ho eseguito niente, l'ho concluso dalle righe citate. I file sono in `server/` salvo indicazione.

### a) Mac spento o senza rete a metà turno, ritorno dopo 10 minuti o 8 ore

**Esito: dipende da una sola cosa, se il PROCESSO Topics del Mac è ripartito. Se no, si riattacca da solo. Se sì, la corsa del nodo viene cancellata e rifatta da zero: una consegna già finita sul nodo viene buttata.** Il tempo (10 min, 8 h) conta solo perché 8 ore di Mac spento vogliono quasi sempre dire processo ripartito.

1. **Cosa fa il nodo mentre il Mac non c'è.** La card specchiata è una card normale del Topics del nodo, con `machineId: null` («Runs HERE», `routes/nodes.ts:655-659`, intestazione 1-12) nel DB del nodo: il nodo ha un DB suo e un suo dispatcher (dedotto: stesso server, `deploy/cloud-node/user-data.sh.tmpl:49-58` lo lancia con `HOME=/home/topics`; `autoDispatch` acceso da `node-pool:477`). Il turno però parla col modello dal tunnel inverso: `ANTHROPIC_BASE_URL=http://127.0.0.1:<rport>` (`node-pool:458-472`). Con il Mac fuori il tunnel muore in circa 45 s (`ServerAliveInterval=15`, `CountMax=3`, `node-pool:411`): vedi (b).
2. **Mac che torna a processo vivo (sospensione, coperchio, rete: 10 min o 8 h).** La corsa è nello slot in memoria `inFlight` (`task-dispatcher-remote-node.ts:106-132`). Il Mac non fa giri, quindi non conta fallimenti: la sepoltura scatta solo dopo `NODE_DEAD_POLLS = 30` giri falliti di fila (`:171`, giri ogni 10 s, `boot/governor.ts:41`), cioè 5 minuti di nodo muto con il Mac sveglio, mai per silenzio del Mac (commento `:162-169`, `sweepVerdict :828-832`). Al ritorno il giro rilegge lo stato del nodo (`poll :1134`), rispecchia chip e commenti e, a corsa finita, riporta il ramo con `fetchBundle` (`landNodeDelivery :919`). **Lavoro recuperato.**
3. **Mac che torna a processo ripartito (riavvio, spegnimento vero).** `inFlight` è vuoto. Il recupero all'avvio (`boot/governor.ts:121` → `task-dispatcher-reconcile.ts:183`) chiama `queueAfterRestart` (`remote-node.ts:1278-1318`): se `node_run_open` è 1 (persistito sulla card, `tasks/worktree.ts:264-276`) la card torna in coda con il tentativo rimborsato e la nota «Il server è ripartito… Riparte sul nodo, dopo aver cancellato la corsa vecchia». **Non si riattacca, non va in errore, non resta appesa: riparte da capo.** Una card `in_progress` senza corsa aperta viene lasciata com'è (`:1285`).
4. **Il rilancio cancella la corsa vecchia.** Prima di crearne una nuova il dispatcher manda `cancelRun` sull'id persistito (`:522-536`), che sul nodo è `DELETE /api/nodes/runs/:id`: ferma l'agente vivo e archivia la card specchiata (`routes/nodes.ts:752-760`, via `deleteBoardTask`). Poi `createRun` sul nodo: se la copia precedente è ferma in `review`/`done` la archivia comunque come «copia finita = rinvio» (`routes/nodes.ts:617-622`), libera la chiave e crea una card nuova (`:613-670`) che parte da `main` o dal ramo che la card porta sul Mac (`carriedBranch`, `remote-node.ts:454-474`). **Un lavoro finito sul nodo mentre il Mac era spento è il caso peggiore: consegna archiviata, mai portata sulla card, lavoro rifatto.**
5. **Il lavoro fatto sul nodo si perde?** Fisicamente no, per la card sì. L'archiviazione conserva la punta del ramo sotto `refs/topics/archive/<task>` (`services/worktree-gc.ts:19`, dedotto che valga anche per le card specchiate), ma il Mac non la scarica e non la mostra; per quanto tempo il nodo la tiene non l'ho verificato. I commenti scritti sul nodo dopo l'ultimo giro non arrivano alla card (la corsa nuova è un'altra card). I messaggi già rispecchiati restano sulla card del Mac.
6. **Se all'avvio il nodo non risponde.** Il rilancio non va in locale mai: la card aspetta in coda 5 minuti alla volta con il chip «nodo non risponde» (`deferForSilentNode :368-384`, `NODE_RETRY_MINUTES :200`). Il cancel che fallisce viene solo loggato (`:535`).

### b) Turno sul nodo senza il proxy dei modelli

**Esito: ritenta e aspetta, poi chiude in review o in errore sul nodo. Non resta appeso per sempre e non cade mai sul Mac.**

- Il CLI sul nodo trova la porta chiusa e stampa `system/api_retry` fino a 10 volte; senza stato HTTP vale come «API giù» (`providers/claude/events.ts:111-125`, `providers/stop-reason.ts:286-288`), e apre il blocco `api-down` (`providers/claude/api-outage.ts:36-41`). Se il turno resta muto, il watchdog lo taglia dopo 30 minuti con causa `api-unavailable` (`api-outage.ts:48-60`).
- Il dispatcher del nodo tratta l'errore del provider come non colpa dell'agente: i primi `FREE_PROVIDER_ERRORS = 3` non consumano tentativi (`task-dispatcher-support.ts:78`, `task-dispatcher-turn-end.ts:229-243`), poi riprova «sulla stessa sessione» dopo `max(backoff 60 s, blocco)` (`:265-300`, `services/tasks.ts:809-810`). Esauriti i 2 tentativi (`dispatchRetryCap` = 2) la card va in review con le parole recuperate dell'agente se ha lavorato, in errore se non ha prodotto niente (`:304-330`).
- Se il Mac c'è ma senza login: il proxy risponde 503 «No Claude login on the coordinator» (`services/model-proxy.ts:225`), stesso ramo.
- Durata fino a review/errore: dedotta, decine di minuti o più; non misurata. Con un Mac spento 8 ore, quasi certamente la card del nodo è già chiusa (review o errore) quando il Mac torna.

### c) Il PC segue lo stesso schema?

**Esito: sì per ingresso, corsia, DB del nodo, proxy e riattacco (stesso codice); cambia chi apre il tunnel e chi sveglia la macchina, che stanno fuori da questo repo.**

- Stessa corsia (`routes/nodes.ts`, `remote-node.ts`), stessa riga `machines` e stesso proxy `:3391` via tunnel `-R` (`openspec/changes/pc-nodo/proposal.md`, «Cosa cambia» e «Deciso da me»).
- Differenze (da `pc-nodo/proposal.md`, non verificabili qui perché in winfleet): tunnel `-L`/`-R` aperti da uno script del Mac fuori dal repo; il modello passa dal `~/.claude/settings.json` del PC; l'hook `node-run` (`remote-node.ts:492`) sveglia il PC dal Mac, e `wf-autosleep` conta le card del nodo come lavoro. Dedotto: a Mac spento nessuno sveglia un PC addormentato, e un PC sveglio perde il modello come il Hetzner. Non c'è `node-pool` per il PC (`deploy/cloud-node` è solo Hetzner).
- Il PC dorme e può essere in uso: non è un candidato a principale (`pc-nodo/proposal.md`, «Non ancora specificato»).

## 2. Mappa: cosa gira solo sul Mac e cosa serve al sistema agentico

Fonti: `launchctl list` e i plist in `~/Library/LaunchAgents` (82 plist, ognuno letto con il suo `ProgramArguments`), `jobs.json` di jarvis-channels (254 lavori, 100 non in pausa: 38 agent, 62 command), `hub-service` (Cargo.toml, `sb/cred.rs`, `sb/oauth.rs`), `README.md` di jarvis-channels. **Sul server Linux non ho provato nulla**: «come si sostituisce» è dedotto dal codice.

**Legenda.** SEGUE = deve stare sul principale, altrimenti il sistema agentico si ferma. RESTA = del Mac come computer personale, non si sposta. SERVE = non si sposta ma il principale ne ha bisogno e lo raggiunge dal Mac (nodo) quando c'è.

| Servizio | Dove oggi | Dipendenze macOS | Verdetto | Su Linux | Al ritorno del Mac |
|---|---|---|---|---|---|
| Topics server: DB, board, dispatcher, motore nativo dei turni delle chat | launchd `com.armonia.topics-server` (Topics Host.app) | Keychain per login e cookie (`providers/native/auth.ts:181-218`, `integrations/chrome-cookies.ts`), 31 file del server toccano macOS | SEGUE | Gira già su Linux come `topics.service` (nodo permanente, `user-data.sh.tmpl:49-58`); `getAccessToken` legge `~/.claude/.credentials.json` (`auth.ts:117`) | Diventa nodo: DB stale messo da parte, poi sovrascritto dal riporto (sez. 4) |
| Proxy modelli per i nodi (:3391) | dentro Topics, `TOPICS_MODEL_PROXY_PORT` (`boot/listen.ts:191-208`) | nessuna (usa `getAccessToken`) | SEGUE | stesso codice sul principale | Il Mac lo usa dal tunnel, come oggi i nodi |
| hub-service (proxy account Claude :3336/:3335, hub :3360, ponte :3361, freno, coda delega, trust) | launchd, `--keychain --shed --live`, 51 MB | Keychain come deposito dell'account attivo (`sb/cred.rs:62-91`) e `--shed` (freno del Mac: `macsample.rs`, `procclose.rs`) | SEGUE (parte proxy e coda). Il freno `--shed` RESTA sul Mac | Il deposito ha già la variante file (`ActiveStore::File`, `cred.rs:11-15`): si lancia senza `--keychain` e senza `--shed`; dipendenze solo `libc` e `reqwest` rustls (`Cargo.toml`), compilazione Linux non provata | Il Mac riparte con il suo hub in sola lettura verso il principale (sez. 3) |
| Account Claude (`~/.claude/jarvis/data/switchboard/accounts/*.json`) | file sul Mac, più la voce Keychain «Claude Code-credentials» per l'attivo | Keychain solo per l'attivo | SEGUE | cartella copiata, attivo su `~/.claude/.credentials.json` | Vedi sez. 3: un solo titolare dei refresh |
| jarvis-channels: WhatsApp, Discord, voce, cron, motore dei turni di Jarvis | launchd `com.jarvis.channels` (Rust, `channels.sqlite`, `whatsapp.db`) | Token Discord e altri nel Keychain (`keychain:servizio/uso` in `config.json`); `compat.rs:556` chiama `launchctl` | SEGUE | Rust: `cargo build` Linux (non provato); `tools/cutover.sh pack/unpack` sposta già lo stato su un'altra macchina (README «Spostare su un'altra macchina», ~8 MB, ~1 s); `launchctl` → `systemctl` solo in `compat.rs`; Keychain → deposito segreti (T4) | Il dispositivo WhatsApp collegato è uno solo: si spegne qui e si accende là, mai due insieme (dedotto dal modello «dispositivo collegato») |
| Cron di jarvis-channels, 38 agent | dentro jarvis-channels | nessuna propria (girano un turno) | SEGUE con jarvis-channels | invariati | restano sul principale |
| Cron di jarvis-channels, 62 command | `jobs.json` | molti usano percorsi del Mac (`/Users/...`, `~/bin/...`, `/opt/homebrew/bin/...`) e il Keychain (es. fatture Zeno) | Divisi: SEGUONO quelli del sistema agentico (Guardiano, Punto, brief, board-notte, giri dell'hub, Spinta della board, cron-health, Salute dei canali, richiamo, solido, misure CI); RESTANO `mac-health`, `Avviso di riavvio del Mac`, backup, `task-sync` con Promemoria | percorsi in variabili (`$JARVIS_HOME`), eseguibili Node/Python/sh già portabili salvo i `~/bin` | Ogni lavoro ha il campo `host`: gira dove sta il suo host (T7) |
| Repo `~/.claude/jarvis` (script, private cifrato git-crypt), `~/.agents` | Mac | chiave git-crypt solo nel Keychain e in app Password | SEGUE (clone sul server) | `git clone` + `git-crypt unlock` | si riallinea con `git pull` (c'è già `repo-ff`) |
| Gateway MCP (:gateway start.sh), docs-index, ai-memory, memblocks | launchd KeepAlive | 3 file dei server MCP locali usano `security` o `osascript` (conteggio con grep, non letti uno per uno) | SEGUE (gateway e memoria), i figli macOS (Reminders, Messaggi, iPhone) RESTANO | figli con segreto nel deposito, i macOS esclusi con messaggio chiaro | il Mac espone i suoi figli macOS come nodo MCP solo se acceso (non ora) |
| node-pool (Hetzner, tunnel, hook `node-run`), hetzner-tetto, offload-hetzner | launchd ogni 60 s | `ssh`, chiave `~/.ssh/offload_hetzner`, token hcloud nel Keychain | SEGUE (il principale è chi crea e apre i nodi) | Python già portabile, tunnel `-L` aperti dal principale; chiave e token nel deposito | Il Mac è un nodo: apre lui `ssh -R` verso il principale (non è raggiungibile da fuori) |
| Litestream del DB | launchd `com.jarvis.litestream-topics`, cifrato age in iCloud | iCloud Drive come destinazione, chiave age solo nel Keychain | SEGUE (il principale replica il suo DB), la destinazione cambia | destinazione raggiungibile da Linux (storage di oggetti o SFTP), chiave age nel deposito | La replica del Mac resta l'ultima copia da prima del passaggio |
| Backup del Mac, mac-health, memlog, devreap, gpu-guardia, fseventsd, lyricfever, browser-reaper | launchd | tutto macOS | RESTA | — | invariati |
| Reminders, CallHistory, Beeper, ActivityWatch, Finicky, iPhone agente | launchd/app | tutto macOS | RESTA, SERVE: il principale vede i risultati se il Mac è acceso (task-sync, giornata) | — | riprendono dove erano |
| Progetti su cartelle non git (163 su 365 dei figli, `sottoagenti-nodo/proposal.md`) e card con `stayLocal` | filesystem del Mac | filesystem | RESTA sul Mac, SERVE | il principale mette la card in attesa con il motivo, e la manda al Mac quando torna | il Mac, come nodo, le prende |
| jcode, free-router, gateway locale, darkroom-server, patto-pagina, edm-report, salvati, mockup-flussi, postgres, pmd | launchd | dev e hobby del Mac | RESTA | — | invariati |

**Lettura.** Il «sistema agentico» sono cinque pezzi: Topics (DB, board, dispatcher, turni), hub-service (account), jarvis-channels (canali, voce, cron), node-pool e la memoria/gateway. Gli altri servizi di launchd (una sessantina) sono del Mac come computer.

## 3. Lo switch degli account Claude sul server

**Fatti dal codice.** Quattro account nel pool. Due (`auto-2`, `auto-3`) sono token da un anno senza refresh (`refreshToken` assente, solo `user:inference`, scadenza 2027-11); due (`auto-4`, `auto-5`) sono login completi con refresh e access token da 8 ore (scadenza 2026-11-17, scope completi). `hub-service` rinnova ogni account sotto un lock suo e **salva il nuovo refresh token ricevuto** (`sb/oauth.rs:58,173`): il refresh ruota. Esiste un test «shared refresh token never overwrites another account» (`sb/discover.rs:116`), cioè il caso è già stato un problema.

**Conseguenza (dedotta).** Un token da un anno si può usare da due macchine insieme senza problemi: nessun refresh, nessuna rotazione. Un account con refresh no: se due hub rinnovano lo stesso, il secondo presenta un refresh token già ruotato e riceve `invalid_grant` (gestito come `invalidGrant` in `oauth.rs`), e l'account resta scollegato finché non si rifà il login. Il caso è documentato come bug aperto per più processi sullo stesso account nel tracker di Claude Code ([anthropics/claude-code#98693](https://github.com/anthropics/claude-code/issues/98693): rinnovi concorrenti invalidano la sessione; segnalazione di un utente, non confermata da Anthropic).

**Forma pulita, consigliata (scelta 2).**
1. Gli hub non sono due vivi insieme: l'hub gira **sul principale**, e chi non è principale usa il suo proxy via tunnel (`ANTHROPIC_BASE_URL` verso la porta del tunnel). Un solo titolare dei refresh per volta, sempre.
2. Nello switch la cartella `accounts/` si **sposta** (copia, verifica, poi sul vecchio titolare i file diventano `.passato-<epoca>` e il suo hub si ferma): mai una copia viva per parte.
3. Per togliere il rischio alla radice, i due account con refresh vengono convertiti in token da un anno con `~/.claude/jarvis/scripts/switchboard-token <email>`: un login nel browser di Attilio per account, una volta, poi niente più rotazione e nessun trasferimento da custodire. Gli account già in quel formato dimostrano che lo switch automatico funziona anche senza scope `user:profile` (legge i limiti dagli header di risposta, `migrate_state` in `oauth.rs`).
4. Se un token muore, parte da solo la voce in «Ti aspetta» che c'è già per gli account in scadenza (cron «Login di switchboard per … in scadenza»).

**Solo abbonamenti (Attilio, 17/11).** L'hub ha anche un ripiego a chiave API quando nessun account OAuth può servire (`sb/apikey.rs:1-4`, `api-accounts.json`, oggi 3 voci, segreti nel Keychain). Sul principale quel ripiego resta spento e le chiavi non vengono copiate; con tutti gli account al limite il turno aspetta il reset invece di costare. Il segno di un turno in abbonamento è la finestra 5h dell'account che sale (`sb/acct.rs:50`) e gli header `anthropic-ratelimit-unified-*` (`acct.rs:75-79`); che una chiamata a chiave API non li porti è dedotto, non verificato.

**Non verificato.** Che l'abbonamento regga da un IP di datacenter: si prova con un turno vero (T2) prima di costruire il resto.

## 4. Il ritorno del Mac e il passaggio senza perdere scritture

**Regola.** Principale è chi ha l'epoca più alta; il Mac che riparte legge `role` dal suo file di stato e, se non è il principale, parte con il dispatcher e i cron spenti e la app che punta al principale. Mai un ritorno automatico: il riporto è un comando a mano dal menù (deciso da me, vedi proposal).

**Passaggio pianificato (in entrambe le direzioni).**
1. `drain`: il principale smette di assegnare card nuove; quelle in volo finiscono o vengono parcheggiate con la nota «passaggio in corso».
2. Il principale sospende jarvis-channels (`jarvis-channels staccati --aspetta` già c'è, README «Mettere in servizio») e l'hub.
3. `sqlite3 .backup` (o `VACUUM INTO`) di `data/topics.db`, `PRAGMA integrity_check`, conteggio righe delle tabelle chiave; copia con la cartella di stato (token dei nodi, hash dei token modello, licenza) e `cutover.sh pack` di jarvis-channels, `accounts/` degli account.
4. Sul nuovo principale: restore, `unpack`, avvio con epoca+1; il vecchio principale rifiuta da quel momento ogni richiesta con epoca più bassa e rinomina il suo DB `topics.db.prima-<epoca>`.
5. Nessuna fusione di DB: scrive uno solo alla volta, per costruzione. Una scrittura fatta sul vecchio durante il drain è nel backup del punto 3; una dopo, no, perché è rifiutata.

**Mac morto senza preavviso.** `claim` sul nodo: restore dall'ultimo replicato di Litestream (finestra di perdita ~1 s dichiarata dal prodotto, copia ogni 10 s nostra), epoca+1, jarvis-channels da pack più recente (stato WhatsApp fino a un'ora di vecchiaia: dopo un `claim` può servire il ricollegamento del dispositivo, da verificare). Richiede la chiave age sul nodo (decisione 1).
