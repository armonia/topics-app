# HolyClaude

## In tre righe

HolyClaude è una workstation AI containerizzata: un'immagine Docker che impacchetta Claude Code, altri 7 CLI agentici, una web UI e un browser headless già configurati, con un solo `docker compose up` [README].
È pensata per sviluppatori che vogliono un ambiente remoto sempre acceso senza configurare nulla a mano.
Il suo punto più forte rispetto a Topics è l'operatività remota curata nei dettagli: persistenza della sessione OAuth fra rebuild, supervisione dei processi, tunnel consigliati e notifiche push quando l'agente finisce.

## Identità

Repository `CoderLuii/HolyClaude`, descritto come stazione di lavoro con Claude Code, web UI, 8 CLI AI, browser headless e oltre 50 tool [README].
Al 14 ottobre 2026 conta circa 2583 stelle e 271 fork, con linguaggio primario JavaScript [doc: https://github.com/CoderLuii/HolyClaude].
La licenza è MIT [codice: LICENSE:1].
L'ultimo commit verificato è `762bf70` del 10 ottobre 2026, corrispondente al tag v1.6.6 [release v1.6.6].
Le release sono frequenti, circa una a settimana: v1.6.2 il 18 settembre, v1.6.3 il 24 settembre, v1.6.4 il 2 ottobre, v1.6.5 il 6 ottobre, v1.6.6 il 10 ottobre 2026 [release v1.6.6].
Il progetto è giovane, nato a marzo 2026, ma mostra maturità operativa: changelog dettagliato, policy di sicurezza pubblicata e revisione degli advisory di dipendenza a ogni release [codice: docs/CHANGELOG.md:15].
Le piattaforme supportate sono Linux amd64 e arm64 native, macOS via Docker Desktop, Windows via WSL2, NAS Synology e QNAP; Kubernetes è dichiarato in roadmap ma non disponibile [README].
Esistono due varianti di immagine, `full` con tutto preinstallato e `slim` con soli tool essenziali, entrambe per amd64 e arm64 [README].

## Architettura

Il sistema è un solo container Docker con supervisore s6-overlay come PID 1.
I servizi gestiti sono `cloudcli` (web UI su porta 3001), `persist-claude-json`, `xvfb` e l'opzionale `sshd` [codice: docs/architecture.md:28].
L'entrypoint gira a ogni avvio: rimappa UID e GID, ripristina la sessione Claude salvata, prepara la configurazione Git e GitHub CLI, poi passa il controllo a s6 che riavvia i servizi in caso di crash [codice: docs/architecture.md:55].
Il bootstrap con sentinel file gira solo al primo avvio, così le personalizzazioni dell'utente non vengono mai sovrascritte dagli update [codice: docs/architecture.md:186].
La web UI è CloudCLI 1.37.3, software di terze parti vendorizzato come tarball con checksum SHA e patch applicate in build, non codice scritto dal progetto [codice: Dockerfile:669].
Il Dockerfile è di 924 righe, con stage di build Go per i binari esbuild pinnati e stage runtime Node 26 su Debian Bookworm [codice: Dockerfile:1].
Misure sul clone: 216 file tracciati, 94 script `.mjs`, 28 shell, 26 markdown, 18 JSON e 7 Python; gli script di `scripts/`, `s6-overlay/` e `config/` sommano circa 9000 righe [non verificato].
Non esiste un `package.json` proprio del progetto: i manifest sono il Dockerfile, i tre compose file e `contracts/product-facts.json`, che registra versioni, porte e feature ed è verificato in CI contro Dockerfile e compose [codice: contracts/product-facts.json:1].
Con l'agente non parla via Agent SDK né via stream-json diretto: CloudCLI lancia i CLI reali nel container e gli hook di Claude Code (`Stop`, `PostToolUseFailure`) richiamano uno script di notifica [codice: config/settings.json:1].
Rust e Go non sono nel runtime: Go serve solo in build per compilare esbuild pinnati, il resto è Node, Python e shell [codice: docs/architecture.md:11].
Lo storage è su bind mount: `./data/claude` per impostazioni e credenziali, `./workspace` per il codice; il database SQLite di CloudCLI resta di default effimero nel container, con opt-in a named volume locale [codice: docs/architecture.md:44].

## Sessioni e task

CloudCLI offre gestione progetti e sessioni multiple verso i CLI dal browser, con statistiche di progetto fra i plugin inclusi [README].
Non esiste una kanban, non esistono code di task, worktree automatiche, tentativi con retry, review strutturate o merge assistiti: è l'utente che lancia le sessioni e le segue una per una.
La pianificazione del lavoro è delegata al CLI TaskMaster AI incluso nell'immagine, che usa le chiavi dei provider già configurati [codice: contracts/product-facts.json:77].
Per git e GitHub sono preinstallati `git` e `gh`, usati a mano o dall'agente nel terminale, senza automazioni di PR o CI proprie del progetto [README].
Il pezzo di session handling fatto bene è il recupero automatico della sessione Claude fra un rebuild e l'altro: un servizio dedicato salva lo stato valido ogni 60 secondi e lo ripristina prima che l'avvio possa creare un file di default vuoto [codice: docs/architecture.md:117].
La configurazione Git globale e l'autenticazione `gh` sono anch'esse persistite nel mount `.claude` e riapplicate a ogni boot senza sovrascrivere le modifiche manuali [codice: docs/architecture.md:55].
Resta un limite strutturale: la perdita dell'account CloudCLI al rebuild è un known issue accettato, perché il suo database è container locale di default e la ricreazione richiede dieci secondi [README].

## Usabilità

Le superfici sono la web UI nel browser e il terminale SSH opzionale; non esiste un'app desktop nativa, né una TUI propria, né un'app mobile [README].
Il flusso principale è volutamente banale: `docker compose up -d`, aprire `http://localhost:3001`, creare l'account CloudCLI in dieci secondi, autenticarsi con l'account Anthropic via OAuth [README].
Nessun file `.env` obbligatorio: ogni variabile ha un default sensato e il compose full documenta ogni opzione inline [README].
Le notifiche push usano Apprise con oltre 100 servizi supportati, fra cui Discord, Telegram, Slack, email, Pushover e Gotify [README].
Si configurano con variabili `NOTIFY_*` e si attivano creando il file flag `~/.claude/notify-on`; senza configurazione non parte alcuna chiamata di rete e non c'è overhead [codice: docs/architecture.md:215].
Gli eventi notificati sono la fine di un task e gli errori di hook o di chat, mentre i prompt di permesso non passano mai per le notifiche [codice: docs/configuration.md:186].
Diff e review del codice non hanno una vista dedicata documentata: si lavora nel terminale web o si lascia fare ai CLI [non verificato].
La documentazione operativa è il punto curato meglio: la guida troubleshooting copre decine di casi reali come shm insufficiente, permessi UID, mount NAS, terminale illeggibile e watcher rotti [README].
Il progetto dichiara apertamente i known issue upstream, come il bottone Continue in Shell rotto per una race condition, e indica il workaround con il proprio plugin [README].

## Browser e anteprima

Il browser integrato è sostanzioso: Chromium Debian 154.0.8037 pinnato per entrambe le architetture, Playwright Node e Python 1.63.0 in entrambe le varianti di immagine, display di compatibilità Xvfb `:99` [codice: docs/architecture.md:144].
Il modulo Browser Use di CloudCLI è agganciato allo stesso binario di sistema tramite patch applicata in build, così non esiste alcun download di browser a runtime [codice: Dockerfile:779].
L'agente pilota il browser in due modi: via Playwright diretto nel container per screenshot, test e scraping, e via modulo Browser Use della web UI [codice: docs/architecture.md:144].
Le variabili `CHROME_PATH` e `PUPPETEER_EXECUTABLE_PATH` puntano al wrapper canonico `/usr/bin/chromium` [codice: docs/architecture.md:144].
Non esiste nulla di simile al co-browse Mac iPad di Topics: l'accesso remoto condivide la stessa UI e lo stesso workspace, senza rispecchiamento del DOM fra dispositivi [codice: contracts/product-facts.json:224].
L'anteprima dei dev server avviene mappando le porte dal compose (3000 per Next.js, 5173 per Vite, 4321 per Astro e altre) e aprendole nel browser dell'host, non in un pannello integrato [README].
Lighthouse per gli audit di performance è incluso solo nell'immagine full [codice: docs/architecture.md:144].

## Terminale, editor, file

Il terminale web è il plugin Web Terminal di CloudCLI, basato su xterm.js, con patch propria che decodifica l'output PTY da byte UTF-8 grezzi prima del rendering [codice: docs/architecture.md:202].
La stessa patch allarga lo stack di font di fallback e aggiunge un escape hatch per disabilitare WebGL, che in alcuni browser sceglie font deboli e mostra quadrati neri al posto dei caratteri [README].
I file si sfogliano nella web UI e soprattutto nel bind mount `/workspace`, editabile direttamente dall'host con il proprio editor preferito [codice: docs/architecture.md:217].
I bind mount tengono i dati visibili e gestibili su disco, a differenza dei named volume Docker che li nascondono nello storage interno [codice: docs/architecture.md:217].
Non esiste un editor integrato con partecipazione dell'agente: l'integrazione con VS Code via tunnel è in roadmap, non implementata [README].
Per i file ci sono anche tool dedicati preinstallati: `ripgrep`, `fd`, `fzf` per la ricerca veloce, `bat` per la lettura con highlight, `jq` e `yq` per JSON e YAML [README].
Un limite noto: se `/workspace` contiene directory illeggibili, la navigazione file della UI falliva, con fix nelle release 1.3.4 e successive [issue #51].

## Remoto e mobile

Non esiste una cloud proprietaria: la web UI resta legata a `127.0.0.1:3001` di default e il progetto sconsiglia esplicitamente il port forwarding pubblico [README].
La ragione è scritta a chiare lettere: la UI espone una shell completa, può eseguire codice arbitrario e custodisce i token OAuth e le API key del provider [README].
Le strade consigliate sono due: Tailscale come mesh VPN per uso personale e piccoli team, Cloudflare Tunnel con Access davanti per hostname pubblici e SSO [README].
Il supporto di subpath via `HOLYCLAUDE_BASE_PATH` permette di servire la UI sotto un path come con Tailscale Serve, e corregge il bug storico della UI rotta sotto reverse proxy [issue #64].
In più c'è SSH opzionale con sole chiavi: login come `claude`, niente password, niente root, con `authorized_keys` montato in sola lettura fuori da `.claude` e `/workspace`, più Mosh su UDP per connessioni instabili [codice: docs/architecture.md:165].
Da telefono si accede via browser sul tunnel oppure via SSH e Mosh: non esiste un'app e non c'è una UI ottimizzata per schermi piccoli [README].
Attenzione al modello di condivisione: l'accesso remoto condivide lo stesso account CloudCLI, lo stesso workspace e le stesse credenziali, senza alcun isolamento fra utenti [codice: contracts/product-facts.json:224].

## Provider e protocolli

L'immagine full include otto CLI, la slim cinque: Claude Code 2.1.296, Gemini 0.63.0, Codex 0.162.1, Cursor, TaskMaster AI 0.43.1 in entrambe; Junie, OpenCode 1.18.35 e Pi solo nella full [codice: contracts/product-facts.json:35].
Claude Code accetta piano Max o Pro via OAuth nella web UI, API key, backend Bedrock o Vertex, e Ollama via endpoint compatibile Anthropic [README].
Il Codex di OpenAI accetta API key oppure login con sottoscrizione ChatGPT, con callback su porta 1455 da esporre se serve il flusso da browser [README].
Gemini vuole `GEMINI_API_KEY`, Cursor vuole `CURSOR_API_KEY`, TaskMaster riusa le chiavi esistenti, Junie richiede l'account JetBrains [README].
OpenCode è il percorso indicato per OpenRouter e il routing multi provider, con scoperta delle skill compatibili Claude [README].
MCP: non esiste un server MCP proprio di HolyClaude, ma la web UI di CloudCLI offre un dialogo di configurazione MCP, confermato da una issue sui suoi campi di variabili d'ambiente [issue #20].
Non c'è traccia di ACP, di Agent SDK o di protocolli propri fra UI e agente: l'integrazione passa dai CLI eseguiti nel container e dagli hook [non verificato].
I permessi di default per Claude Code sono in modalità `acceptEdits`, con `bypassPermissions` documentata solo per utenti esperti [codice: config/settings.json:1].

## Performance

Numeri dichiarati: nessuno, nessun benchmark è presente nel repository e nessuna misura di avvio o memoria è pubblicata.
Le scelte di performance sono tutte architetturali e documentate come tali [codice: docs/architecture.md:193].
I plugin CloudCLI sono compilati in build perché compilarli all'avvio aggiungerebbe oltre 30 secondi al primo boot e fallirebbe su storage di rete [codice: docs/architecture.md:193].
Non esiste download di browser a runtime: tutto è cotto nell'immagine e verificato con checksum in build [codice: Dockerfile:779].
Lo `shm_size` di default è 2 GB perché con i 64 MB di Docker le tab di Chromium crashano in modo casuale; per uso pesante è consigliato 4 GB [README].
L'heap Node è fissato a 4 GB nel compose full per i monorepo grandi, mentre il compose quick non imposta limiti [README].
Le lamentele degli utenti riguardano la dimensione dell'immagine e gli update pesanti, specie su NAS Synology, ed è da lì che nasce la variante slim [issue #45].
Altri problemi reali: crash immediato di Chromium con SIGTRAP su arm64 nella 1.4.4 [issue #66], e watcher che non rilevano modifiche su mount SMB e CIFS, dove l'unica via è il polling con maggior costo in CPU [README].
Nessun uso di Rust per la velocità nel runtime: il Go in build serve solo a compilare esbuild pinnati [codice: docs/architecture.md:11].

## Affidabilità e qualità

La suite è ampia ma specializzata: 102 file in `tests/`, quasi tutti contract test su policy di sicurezza, SBOM, checksum degli input immutabili e fumo Docker, non test di funzionalità del prodotto [non verificato].
I soli test `.mjs` sommano circa 14126 righe, segno di un investimento reale ma concentrato sulla supply chain [non verificato].
I workflow GitHub sono due: pubblicazione delle immagini Docker e sicurezza della supply chain [codice: .github/workflows/].
Il recupero dopo un crash è affidato a s6 con restart automatico dei servizi longrun, forwarding dei segnali e reaping dei processi zombie [codice: docs/architecture.md:84].
Il ponte di sessione rifiuta di sovrascrivere uno stato valido con file vuoti, corrotti, link simbolici o di solo onboarding, e gira come servizio supervisionato ogni 60 secondi [codice: docs/architecture.md:117].
Il bootstrap con sentinel non tocca mai le personalizzazioni dopo il primo avvio, e il retrigger è un semplice `rm` del file sentinel [README].
Punti deboli noti e ammessi: l'account CloudCLI si perde al rebuild senza il volume opt-in [README], e il database SQLite si blocca su share di rete quindi va tenuto su disco locale [README].
Le issue storiche poi risolte mostrano il metodo del manutentore: sessione `.claude.json` azzerata a ogni restart [issue #48], configurazione Git persa fra update [issue #72], database CloudCLI non apribile su volume [issue #70].
Altri casi istruttivi: OAuth in loop con UI ferma allo 0 per cento [issue #28], sessioni Codex che rimbalzano a nuova sessione dopo il primo prompt [issue #19], Claude non disponibile [issue #96], update con plugin mancanti [issue #44].
L'unica issue ancora aperta al momento dello studio riguarda un deploy con avvio fallito del container [issue #97].

## Sicurezza e privacy

Il modello è onesto ma permissivo: i compose di default chiedono `SYS_ADMIN`, `SYS_PTRACE` e `seccomp=unconfined` per il profilo browser [codice: .github/SECURITY.md:1].
La stessa SECURITY.md ammette che queste capability allargano i privilegi e riducono l'isolamento, e rimanda l'hardening a un passaggio separato [codice: .github/SECURITY.md:1].
Le credenziali vivono in chiaro nei bind mount: `./data/claude` contiene sessioni OAuth e ora anche l'auth GitHub, con avviso esplicito di non committare né condividere la cartella [README].
Il lato positivo è architetturale: nessun relay di credenziali, i tool leggono file locali e contattano i provider direttamente, e l'auth parte dal flusso OAuth ufficiale nella web UI [README].
Telemetria propria non documentata: le notifiche Apprise sono completamente silenti quando non configurate, con zero chiamate di rete e zero log [README].
L'SSH opzionale è disegnato con cura: sole chiavi, niente password, niente root, chiavi fuori dai path con segreti [codice: docs/architecture.md:165].
La supply chain è il pezzo più serio del progetto: input pinnati con checksum, SBOM CycloneDX e SPDX, scansioni Grype, policy di revisione degli advisory [codice: docs/architecture.md:153].
Le vulnerabilità upstream accettate restano elencate con versione installata, severità grezza e fix disponibili: l'accettazione non è spacciata per risoluzione [codice: docs/architecture.md:153].
I componenti di terze parti modificati e trattenuti in build sono etichettati separatamente dalle release ufficiali e non possono autorizzare release future [codice: docs/architecture.md:153].

## Estendibilità

Due plugin CloudCLI impacchettati e patchati in build: Project Stats e Web Terminal, con lock verificati in CI e ricostruzione bloccante in caso di drift delle sorgenti pinnate [codice: docs/configuration.md:297].
Le skill per gli agenti passano da Desloppify: CLI preinstallato ma passivo di default, con setup globale opt-in per interfaccia via `HOLYCLAUDE_DESLOPPIFY_SETUP`, senza scansioni automatiche del workspace [README].
Il setup rifiuta le combinazioni non sicure, come `claude` insieme a `opencode`, per evitare doppia scoperta delle skill [README].
Gli hook coprono Stop e PostToolUseFailure di Claude Code, gli hook dei CLI Codex e Gemini, e gli eventi di chat Codex di CloudCLI, tutti verso lo stesso script Apprise [README].
L'hook Cursor è preconfigurato e si attiverà quando il CLI supporterà gli eventi di stop [README].
MCP solo lato client, tramite il dialogo della web UI per i server [issue #20].
Non risulta un'API di plugin propria del progetto né un server MCP esposto da HolyClaude stessa [non verificato].
Le richieste di nuovi pacchetti passano da un template di issue dedicato, con indicazione della variante di destinazione [README].

## Da prendere per Topics

1. Ponte di sessione fail closed: salvataggio periodico dello stato valido e ripristino che rifiuta file vuoti, corrotti o di solo onboarding. Si vede in [codice: docs/architecture.md:117] e risolve il caso dell'utente che perde il login a ogni restart [issue #48]. Per Topics conterebbe perché la persistenza delle sessioni fra riavvii è già un requisito e questo disegno elenca i casi da rifiutare.
2. Bootstrap con sentinel: default copiati una volta sola, mai più toccati in seguito. Si vede in [codice: docs/architecture.md:186]. Per Topics conterebbe nel setup iniziale, senza il rischio di sovrascrivere le scelte dell'utente a ogni update.
3. Notifiche con file flag: un `touch` abilita Apprise su oltre 100 servizi, zero traffico quando spento. Si vede in [codice: config/settings.json:1]. Per Topics conterebbe perché il lavoro in background e da mobile ha bisogno di sapere quando l'agente finisce, senza telemetria involontaria.
4. Contract dei fatti di prodotto: un JSON versionato con versioni, porte e feature, verificato in CI contro Dockerfile e compose. Si vede in [codice: contracts/product-facts.json:1]. Per Topics conterebbe come barriera contro derive fra documentato e spedito.
5. Vendoring checksummato della dipendenza UI: tarball con SHA e manifest, patch esplicite, update solo via immagine. Si vede in [codice: Dockerfile:669]. Per Topics conterebbe se mai si appoggerà a una UI di terze parti: niente auto update che rompe le patch in produzione.
6. Supervisione con restart e shutdown pulito: s6 come PID 1 con servizi longrun e forward dei segnali. Si vede in [codice: docs/architecture.md:84]. Per Topics conterebbe come modello per i processi del server oltre launchd.
7. Layout dati con avvisi di privacy: tabella di cosa sopravvive al rebuild e di cosa contiene segreti. Si vede in [README]. Per Topics conterebbe perché la cartella dati contiene token e va trattata con gli stessi avvisi.
8. SSH con chiavi fuori dal workspace: mount in sola lettura e percorso vietato sotto le cartelle con segreti. Si vede in [codice: docs/architecture.md:165]. Per Topics conterebbe come riferimento per l'accesso remoto senza esporre i segreti via file condivisi.
9. Supporto subpath per reverse proxy e Tailscale Serve: una variabile, niente slash finale, test dedicato [issue #64]. Per Topics conterebbe perché l'uso da LAN e tunnel presenta lo stesso problema di mount sotto path.
10. Runbook di troubleshooting onesto: ogni bug storico con causa e fix, e issue upstream dichiarate apertamente. Si vede in [README]. Per Topics conterebbe come standard di documentazione operativa da imitare.

## Da evitare

1. Capability permissive di default: `SYS_ADMIN` più `seccomp=unconfined` come profilo browser standard, con hardening sempre rimandato [codice: .github/SECURITY.md:1]. Le stesse pagine ammettono che Chromium non li richiede universalmente: non copiare il default.
2. Condivisione single user spacciata per accesso remoto: stesso account, stesso workspace, stesse credenziali per chiunque si colleghi [codice: contracts/product-facts.json:224]. Per Topics va bene solo se resta esplicito come qui, mai come multiutenza vera.
3. Account della web UI perso al rebuild senza opt-in al volume [README]. Se Topics persiste le sessioni, la persistenza deve essere il default, non un'opzione da scoprire.
4. Immagine pesante con update pesanti, lamentati soprattutto su NAS [issue #45]. La variante slim è un rimedio, non una soluzione: meglio dipendenze magre fin dall'inizio.
5. Patch trattenute su codice di terze parti senza upstreaming: Web Terminal e CloudCLI portano patch proprie in build [codice: docs/architecture.md:202]. Funziona ma crea debito a ogni release upstream: meglio contribuire o astrarre dietro interfacce.
6. Documentare `bypassPermissions` come modo d'uso personale consigliato [README]. È comodo ma trasforma ogni prompt in esecuzione senza conferma: per Topics il default deve restare con conferma esplicita.

## Fonti

- Repository: [doc: https://github.com/CoderLuii/HolyClaude]
- SHA del clone: `762bf704da5a3fd12a3afc4ed6d169357ddfd439`, tag v1.6.6 del 10 ottobre 2026: [release v1.6.6]
- Release precedenti v1.6.2 e v1.6.5 per la cadenza: [release v1.6.2], [release v1.6.5]
- Architettura e servizi s6: [codice: docs/architecture.md:28], entrypoint: [codice: docs/architecture.md:55], persistenza sessione: [codice: docs/architecture.md:117]
- Bootstrap con sentinel e plugin in build: [codice: docs/architecture.md:186], [codice: docs/architecture.md:193]
- Browser pinnato e Playwright: [codice: docs/architecture.md:144], patch Browser Use: [codice: Dockerfile:779]
- Fatti di prodotto, CLI, porte e feature: [codice: contracts/product-facts.json:1], CLI AI: [codice: contracts/product-facts.json:35], modello single user: [codice: contracts/product-facts.json:224]
- CloudCLI vendorizzato nel Dockerfile: [codice: Dockerfile:669], Dockerfile da 924 righe: [codice: Dockerfile:1]
- Hook e notifiche negli hook: [codice: config/settings.json:1], plugin impacchettati: [codice: docs/configuration.md:297], eventi Apprise: [codice: docs/configuration.md:186]
- Security model e capability: [codice: .github/SECURITY.md:1], SSH e Mosh: [codice: docs/architecture.md:165]
- Changelog e maturità del progetto: [codice: docs/CHANGELOG.md:15], licenza MIT: [codice: LICENSE:1]
- README per setup, varianti, remoto, troubleshooting e roadmap: [README]
- Issue: dialogo MCP [issue #20], callback Codex su porta 1455 [issue #21], loop OAuth [issue #28], sessioni Codex [issue #19]
- Issue: terminale illeggibile [issue #40], notifiche [issue #38], file illeggibili [issue #51], `.claude.json` azzerato [issue #48]
- Issue: update e plugin [issue #44], dimensione immagine [issue #45], download corrotti [issue #46], Pi CLI [issue #47]
- Issue: volume database [issue #70], Git non persistente [issue #72], subpath [issue #64], Chromium SIGTRAP arm64 [issue #66]
- Issue: Claude non disponibile [issue #96], avvio fallito del container [issue #97]
