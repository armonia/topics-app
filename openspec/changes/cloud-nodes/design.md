# Design: cloud-nodes

Ricerca del 04/10 su tre fronti: l'API e la documentazione Hetzner, Topics come
nodo Linux, cosa pesa sul Mac. Ogni fatto qui sotto è marcato in uno di tre modi:
- **verificato**: comando eseguito o sorgente letto;
- **documentato**: pagina ufficiale;
- **dedotto**: ragionamento non ancora provato. Questi stanno anche in proposal
  §«Prima del codice» e in `tasks.md` §0.

Le letture Hetzner sono state solo GET. Nessun server, snapshot, volume o IP è stato
creato.

## Contesto

- **La corsia remota c'è.** Un nodo è una seconda installazione di Topics, senza
  nessuna «modalità nodo» (`server/services/node-client.ts:4`). Il Mac lo chiama al
  suo `base_url`:
  - le funzioni lato Mac sono `createRun`, `readRun`, `fetchBundle` e `cancelRun`
    (`node-client.ts:238-310`);
  - le rotte del nodo stanno nello stesso server: `POST /api/nodes/runs` a
    `server/routes/nodes.ts:605`, il bundle a `:656`, la lettura a `:707`.

  La corsia vive in `server/services/task-dispatcher-remote-node.ts`: `remoteLaunch`
  a :459, `buryRun` a :496, `landNodeDelivery` a :590, `poll` a :674,
  `queueAfterRestart` a :719, `cancelTask` a :751. In produzione non ha mai girato:
  0 nodi, 0 card con `machine_id` (verificato sul DB in sola lettura).
- **Oggi la scelta del nodo è solo umana.** Si fa dal picker della card
  (`client/src/components/Board/TaskDetail.tsx:1440-1444`), e KANBAN-76 vieta un nodo
  `auto`. Questa change apre un'eccezione stretta (KANBAN-95), lasciando a
  `machine_id` il significato che ha oggi.
- **Il peso esiste già.** C'è la colonna `tasks.dispatch_weight` (migration 090).
  Una card scoperta pesante al lancio torna in coda col tentativo rimborsato
  (`absorbWeight`, `task-dispatcher.ts:2267`), e una pesante in volo ferma ogni
  claim (`hasHeavyInFlight`, `tasks.ts:1474`).
- **La quota è una sola.** Il nodo usa lo stesso abbonamento Claude e Codex del Mac.

## Obiettivi / Non obiettivi

**Obiettivi**
- Togliere dal Mac le card pesanti e i loro alberi di processi (CLI, tsserver,
  controlli, dev server) quando la board lavora.
- Crescere senza riscrivere: la Fase 1 ha un nodo fisso; la Fase 2 un pool di posti
  a nome fisso, con lo stesso instradamento e la stessa riga macchina.
- Che ogni nodo si legga come una macchina: cosa è, quanto lavora, quanto costa,
  con quale quota.

**Non obiettivi**
- Spostare chat o sessioni dal vivo.
- Battere la CI di GitHub sui tempi delle suite di topics-app: è gratis.
- Una GPU.
- Più di un fornitore.

## Decisioni

### D1. Un nodo è la corsia remota che c'è, su Linux

Il nodo non ha un trasporto nuovo né un agente nuovo: è Topics, con le sue rotte
`/api/nodes/runs`. La card specchiata è un task locale del nodo (KANBAN-76), con il
suo tetto e i suoi controlli. Il Mac continua a ricevere un git bundle e a piantarlo.
Il PTY bridge serve solo ai pannelli terminale e le card non lo usano (dedotto,
`server/routes/terminal.ts:830-831`).

Ricetta (dedotta; la Fase 0 la esegue e la porta nel repo come
`deploy/cloud-node/`):
1. Ubuntu 24.04 con un utente `topics` e `loginctl enable-linger`.
2. Pacchetti: git, lsof, build-essential, python3, sqlite3, curl, unzip, più
   Tailscale.
3. Strumenti: Bun, Node 20, `claude` e `codex`. È la stessa ricetta della CI su
   `ubuntu-latest` (`.github/workflows/ci.yml:76-111`), compresi `npm rebuild
   node-pty` e `scripts/fix-node-pty-exec-bit.ts`.
4. Un checkout di topics-app allo stesso commit del Mac, e i checkout dei
   repository su cui lavoreranno le card, registrati come progetti da loopback
   (`server/routes/projects.ts:347-365`).
5. Una unit systemd `--user` che lancia `scripts/start-prod.sh`, con:
   - `TOPICS_SERVER_WATCH=0`;
   - `KillSignal=SIGTERM`, perché il suo giro di riavvio gestisce il SIGTERM
     (`start-prod.sh:290-347`);
   - `TimeoutStopSec=300`;
   - nessun certificato, quindi HTTP semplice dentro la tailnet (`server.ts:3254`):
     `http://topics-node-N.<tailnet>.ts.net:3333`. Gli host `*.ts.net` sono già
     ammessi (`server/lib/auth-gate.ts:299-313`).
6. Auto-dispatch acceso sul nodo e `max_agents` fissato sulla misura della Fase 0.
   Su Linux il pavimento di memoria non morde (`dispatch-capacity.ts:460-475`).

Nel repo si corregge una cosa sola: i sei `/usr/sbin/lsof` scritti a mano
(`server/lib/port-project-owner.ts:129,144`, `port-squatter.ts:190`,
`tree-network-peers.ts:64`, `background-shell-output.ts:45`,
`server/routes/processes.ts:1496`) passano dal binario trovato come fa
`server/lib/listening-ports.ts:61`. Il lettore Linux di `MemAvailable` si scrive
solo se la Fase 0 vede intervenire l'OOM killer: senza quella misura sarebbe una
difesa contro un guasto non osservato.

### D2. Chi va al nodo

Una card va al nodo da sola (KANBAN-95) solo se valgono tutte queste condizioni:
- non ha `machine_id`;
- i nodi sono accesi;
- è pesante, oppure il Mac la terrebbe ferma per memoria (`admissionVerdictNow`,
  `task-dispatcher.ts:1329`, che finisce in `dispatchResourceBlock`,
  `dispatch-capacity.ts:836`);
- c'è un nodo pronto con un posto libero, che ha un progetto con l'origine git della
  card. Il nodo risolve il progetto solo per origine (`nodes.ts:178-185`): un
  repository non registrato sul nodo resta di fatto al Mac. È così che si tiene sul
  Mac un progetto che non deve uscire, senza un interruttore per board.

Altre regole:
- **La macchina del tentativo.** La sceglie il pool, e vive nel tentativo
  (`task_attempts.machine_id`), non nella card. Una sepoltura (KANBAN-77) o un
  rimando fanno ripartire la scelta da capo. `remoteLaunch` riceve la macchina dal
  chiamante invece di leggerla solo da `task.machineId`
  (`task-dispatcher-remote-node.ts:463-465`).
- **«Solo su questo Mac»** è `machine_id` uguale alla macchina locale.
  `remoteLaunch` lo tratta già come «qui» (`:465`); manca solo la voce nel picker,
  che oggi elenca le sole righe con `base_url` (`client/src/state/machinesStore.ts:127-128`).
- **Chat, turni e `spawn_agent`** non passano dal dispatcher della board, quindi
  restano qui per costruzione. Lo scenario di KANBAN-95 lo fissa.
- **Il peso conta dove gira il lavoro** (KANBAN-96). Se la Fase 0 mostra che
  `heavyInFlight` e `dispatchedTaskCount` contano le card remote, entrambi
  escludono le righe la cui macchina del tentativo non è locale.

### D3. Il ripiego

Senza un nodo libero, e senza poterne creare uno entro tetto e massimo, la card
resta nella coda del Mac. Lì la valutano le regole di oggi: peso, pavimento, tetto.
Riceve una nota sola, che cambia solo se cambia il motivo (nessun nodo pronto,
tetto di spesa, tipo esaurito, repository sconosciuto al nodo). Una card con
`machine_id` di un nodo aspetta il suo nodo come oggi (`node_unreachable`).

Questo ripiego non tocca nessun divieto di oggi. KANBAN-76
(`openspec/specs/kanban/spec.md:3999-4001`) vieta il nodo `auto`, ed è per questo
che serve il MODIFIED: KANBAN-95 è l'eccezione. Il divieto di ripiego sul Mac
(`spec.md:4027-4029`, scenario «nodo muto, nessun ripiego locale») vale solo per
una card il cui `machine_id` nomina un nodo irraggiungibile. Per una card senza
`machine_id`, KANBAN-76 dice già «assente vuol dire qui»: rimandarla alla coda del
Mac è il comportamento di oggi.

### D4. Fornitore, progetto, tipi

- **Hetzner Cloud, in un progetto nuovo `topics-nodes`.** Il token è per progetto,
  e il raccoglitore cancella per label: nel progetto del CRM un errore cancellerebbe
  il CRM. Il token Read & Write va nel Keychain come `hcloud/topics-nodes`. Si crea
  solo dalla console.
- **Il nodo fisso (Fase 1) è un cx43** (8 vCPU, 16 GB, 160 GB). Si crea quando
  Hetzner lo rende ordinabile: quattro letture del 04/10 dicono `available:false`
  in fsn1, nbg1 e hel1. Il fisso si tiene acceso perché la creazione è limitata a
  caso anche per i clienti esistenti (incidente `0a75c7ae`, documentato), e un
  server che esiste dovrebbe conservare il suo posto. Quest'ultima parte è
  **dedotta**: il testo dell'incidente parla solo della creazione (proposal §«Prima
  del codice» 7).
- **I tipi del pool sono ammessi in ordine: cx43, poi cpx42.** Ognuno si prova nei
  luoghi nbg1, fsn1 e hel1, dentro il tetto di spesa (POOL-07). cpx42 costa 4,35
  volte l'ora di cx43: il tetto in euro lo tiene in riga.
- **L'IPv4 resta.** github.com, codeload.github.com, api.github.com e
  downloads.claude.ai non hanno record AAAA (`dig`): un nodo solo IPv6 non clona.
- **Un secondo fornitore non c'è.** Il pool usa del fornitore quattro operazioni:
  `create`, `list(label)`, `delete`, `prices`. Il client Hetzner è un file; un altro
  fornitore si scrive quando serve.

### D5. Il pool on demand (Fase 2)

- **Posti, non server.** Ci sono `topics-node-1` (il fisso) e `topics-node-2…N`.
  Ogni posto è una riga `machines` stabile, con il suo `base_url`; ogni server è una
  **vita** del posto, in `node_lives`. Prima del `DELETE` il nodo fa `tailscale
  logout`: così il nome si libera e il posto rinasce con lo stesso indirizzo. Senza
  il logout diventerebbe `<nome>-1` (tailscale.com/kb/1098), e il vincolo `UNIQUE`
  su `hostname` (`020-machines.sql:23`) creerebbe una riga nuova.
- **Quando nasce.** Nasce quando c'è almeno una card instradata senza posto da più
  di 60 s, la spesa resta sotto il tetto dopo la prima ora, il numero di nodi è sotto
  il massimo e nessun'altra creazione è in corso (se ne fa una alla volta). Si crea
  con `POST /servers` dallo snapshot più recente con label `topics-node`; il firewall
  si applica da solo per selettore di label; la chiave SSH è `attilio-macbook`.
- **Quando muore.** Muore quando è senza corse da almeno 10 minuti E alla sua ora
  fatturata mancano meno di 10 minuti. Hetzner arrotonda all'ora per eccesso (billing
  FAQ), quindi cancellarlo prima butta minuti già pagati. Si cancella e non si spegne:
  un server spento si paga uguale (billing FAQ).
- **La scadenza.** Il label `expires=<unix>` viene messo alla creazione a +2 h e
  spostato in avanti finché il nodo lavora. Il raccoglitore, un giro del pool ogni
  60 s sul Mac, cancella con il selettore di label tutto ciò che ha superato
  `expires`, anche quello che il DB non conosce (POOL-03).
- **La spesa.** Per ogni vita del mese vale `min(ceil(ore) × €/h, tetto del tipo)`,
  con il prezzo letto da `GET /v1/pricing` alla creazione e salvato nella vita. Il
  tetto del pool vale per i soli nodi a richiesta: il fisso è un costo dichiarato a
  parte.
- **Il massimo.** Sono 3 nodi in tutto, fisso compreso. Il limite di default è di 5
  server per **account**, e il CRM ne occupa 1. Che gli altri progetti dell'account
  siano vuoti non si vede col token (proposal §«Prima del codice» 7).
- **Il tempo massimo per nascere.** Sono 10 minuti dal `POST` al nodo accoppiato,
  poi `DELETE` e ripiego (POOL-07). Le fonti terze danno 25-40 s fino all'SSH; la
  Fase 0 misura il resto.

### D6. Immagine e segreti

- **Lo snapshot** si fa dal nodo della Fase 0, dopo aver tolto le credenziali:
  sistema, strumenti, checkout con `node_modules`, Topics allo stesso commit del Mac,
  Tailscale installato e disconnesso. Si tiene solo l'ultimo: costa 0,0143 €/GB al
  mese, cioè 0,09-0,17 € per 6-12 GB stimati. All'avvio il nodo allinea topics-app
  al commit del Mac, che arriva in `user_data` come dato non segreto, e fa `git
  fetch` dei repository registrati.
- **`user_data`** contiene solo una chiave Tailscale monouso, effimera,
  preautorizzata, con tag `tag:topics-node` ed `expirySeconds: 900`. La conia il Mac
  per quel nodo con un client OAuth (scope `auth_keys`), il cui secret sta nel
  Keychain come `tailscale/topics-node-oauth`. Hetzner serve `user_data` alla VM per
  tutta la sua vita (`169.254.169.254/hetzner/v1/userdata`, sorgente cloud-init
  `DataSourceHetzner.py`): per questo la chiave deve essere già usata e scaduta
  quando qualcuno la rilegge.
- **Le altre credenziali** le spinge il Mac dopo l'ingresso nella tailnet, via
  Tailscale SSH:
  - **Claude**: nella Fase 1 un `/login` interattivo, una volta sola, sul nodo
    fisso. Nella Fase 2 una credenziale per i nodi a richiesta, tenuta nel
    Keychain. La forma esatta dipende dalla Fase 0: file `.credentials.json`
    oppure `setup-token`. Il `setup-token` chiederebbe di far passare
    `CLAUDE_CODE_OAUTH_TOKEN` da `agent-env.ts:17-30` e di farlo leggere al runtime
    nativo.
  - **Codex**: `codex login --device-auth`.
  - **GitHub**: nessun token finché al nodo vanno solo repository pubblici, e il
    nodo non pusha mai: il ramo torna come bundle.
- **La tailnet.** Dentro `tagOwners` va `tag:topics-node`. Le regole:
  - i membri raggiungono `tag:topics-node` sulle porte `:3333` e `ssh`;
  - `tag:topics-node` non raggiunge niente nella tailnet: il nodo esegue codice
    di agenti e non deve poter aprire la :3333 del Mac (POOL-05);
  - i device taggati non hanno la scadenza della chiave (kb/1085), che è il
    guasto che oggi tiene fuori il PC.
- **Il firewall Hetzner** `topics-node-fw`, applicato per label: nessuna porta in
  ingresso, con UDP 41641 facoltativa per le connessioni Tailscale dirette. Il
  server ascolta su `::` (`server.ts:3397`), e il firewall è ciò che tiene la :3333
  fuori dall'IP pubblico. Davanti a :3333 non si mettono mai `tailscale serve` né un
  tunnel: il proxy arriverebbe come loopback, e il loopback è il proprietario
  (`server/lib/device-auth.ts:176`).

### D7. Accoppiamento senza clic

Il passo di oggi resta (MACHINE-02): il Mac fa `POST /api/machines/pair {baseUrl}`
(`server/routes/machines.ts:386`) e il nodo apre `/api/auth/pair/request`
(`server/routes/auth.ts:433`). L'approvazione la fa il Mac stesso, con `tailscale
ssh topics@topics-node-N`, che chiama `curl` su `127.0.0.1:3333/api/auth/pair/pending`
e poi su `/api/auth/pair/approve` (`auth.ts:529`, `:542`). Dato che il loopback è
il proprietario, sul nodo non serve codice nuovo. La Fase 0 prova che nessun
controllo di Origin blocchi quel `POST`.

### D8. La macchina tracciata

Migration unica, con il backup di `data/topics.db` e del `-wal` fatto prima di
creare il file.
- **`machines`, colonne nuove:**
  - `provider` (`NULL` = macchina propria; `hetzner`);
  - `pool_role`: `fixed`, `on-demand` o `NULL`;
  - `pool_phase`, con CHECK su `provisioning`, `ready`, `deleting` ed `empty`;
  - `cores`, `memory_gb`, `capacity_source` (`provider` | `node`);
  - `price_hourly_eur`, `price_monthly_eur`;
  - `run_cap`;
  - `account_label`.

  `status` resta `online|offline`: il suo CHECK non si altera senza ricostruire la
  tabella che il battito scrive ogni 30 s.
- **`node_lives`:** `id`, `machine_id`, `provider_server_id`, `server_type`,
  `location`, `created_at`, `ready_at`, `deleted_at`, `price_hourly_eur`,
  `price_monthly_eur`, `delete_reason`.
- **`task_attempts.machine_id`:** la macchina scelta dal pool per quel tentativo
  (D2).

`GET /api/machines` restituisce i campi calcolati: spesa del mese per posto e per il
pool, corse in volo sul `run_cap`, fase. Lo stato di un nodo (MACHINE-06) viene
dall'ultimo poll riuscito (KANBAN-77) e da `pool_phase`, non dalla spazzata del
battito locale (`server.ts:2965-2983`). La vista è quella che c'è già:
- le righe stanno in `client/src/components/Settings/NodesSection.tsx`;
- il popover del carico (`client/src/components/Board/DispatchLoadGauge.tsx`)
  mostra una riga per macchina, con le parole e i colori di
  `client/src/components/Shared/MachineBusyLine.tsx`;
- la quota è una seconda barra con la scritta «comprende tutto l'account», oppure
  «non letta».

### D9. La base del lavoro sul nodo

La card sul nodo parte da `origin/<ramo base>`, aggiornato con un `git fetch` sul
nodo prima di ogni corsa. Il bundle di ritorno richiede che il Mac abbia il
`baseSha` (`node-branch-plant.ts:9-16`), e il Mac ha `origin/main` perché lo
scarica. Il prezzo è questo: il main del Mac non pusha a ogni land, quindi il nodo
può lavorare su una base più vecchia, e il land sul Mac fa il merge come per
qualunque ramo. L'alternativa sarebbe spingere la base a ogni corsa, cioè cambiare
la regola «push su main a tornate»: si scarta finché la Fase 1 non misura conflitti
veri.

## Dove si innesta

| Cosa | Dove (verificato) | Fase |
|---|---|---|
| Lancio remoto, prima di ogni worktree | `server/services/task-dispatcher.ts:2913` (`remote.remoteLaunch`) | 1 |
| La corsia e la sua costruzione | `task-dispatcher.ts:1791` (`createRemoteNodeLane`); `task-dispatcher-remote-node.ts:206`; `remoteLaunch` `:459-475` | 1 |
| Ammissione per memoria | `task-dispatcher.ts:1329` (`admissionVerdictNow`) → `server.ts:1966` → `dispatch-capacity.ts:836` | 1 |
| Peso | `tasks.dispatch_weight` (migration 090); `absorbWeight` `task-dispatcher.ts:2267`; `heavyInFlight` `server/services/tasks.ts:1474-1479`; giro del peso `task-dispatcher.ts:4917-4970` | 1 |
| Conteggio degli agenti vivi | `server/services/agent-census.ts:116-127` (`dispatchedTaskCount`), `:163` | 1 |
| Stato di una card remota | `task-dispatcher-remote-node.ts:426` (`working`) | 1 |
| Accoppiamento | `server/routes/machines.ts:386`; `server/routes/auth.ts:433,529,542`; `server/lib/device-auth.ts:176` | 1-2 |
| Rotte del nodo | `server/routes/nodes.ts:605,615-616,656,707`; `server.ts:2954` | 0 |
| Macchine | `server/db/migrations/020-machines.sql:8-26`; `20260906115131-machine-base-url.sql`; battito `server.ts:2965-2983` | 1 |
| Picker della card | `client/src/components/Board/TaskDetail.tsx:1440-1444,2333-2361`; `client/src/state/machinesStore.ts:127-128` | 1 |
| Linux | `/usr/sbin/lsof` ×6 (D1); `dispatch-capacity.ts:460-475`; `server.ts:3397` | 1 |
| Credenziali | `server/lib/agent-env.ts:17-30`; `server/providers/native/auth.ts:115` | 0-2 |

## Costi

Prezzi netti di `GET /v1/pricing`, 04/10; IPv4 a 0,50 €/mese per nodo; negli scenari
on demand è compreso uno snapshot da 10 GB.

| tipo | sempre acceso | on demand 2 h/giorno | suite su 3 nodi per 1 h | la stessa suite × 20 al mese |
|---|---|---|---|---|
| cx43 (8/16) | 16,49 | 1,73 | 0,08 | 1,73 |
| cpx32 (4/8) | 35,99 | 3,61 | 0,17 | 3,61 |
| cpx42 (8/16) | 69,99 | 6,88 | 0,34 | 6,88 |

- On demand conviene finché un nodo resta acceso meno di circa 624 ore al mese,
  cioè il tetto mensile diviso il prezzo orario.
- Le scelte consigliate (fisso cx43 e tetto di 10 €) fanno al massimo 26,49 €/mese.
- Hetzner non ha un tetto di spesa vero: l'allarme in console.hetzner.com/usage è
  una comodità. Il tetto lo tiene il pool (POOL-02), e l'allarme si mette comunque
  alla stessa cifra.
- Da ottobre 2026 Hetzner fattura anche gli importi sotto i 10 € (status page,
  e-invoicing). Il conto quindi arriva anche nei mesi magri: tocca la regola di
  `tools/fatture-ai.md`.

## Fasi

| Fase | Cosa | Spesa | Uscita (si esegue sempre uguale) |
|---|---|---|---|
| 0 | prove a mano su un server a ore, poi cancellato | < 1 € una tantum | gli 11 punti di «Prima del codice» chiusi e scritti qui; `GET /v1/servers?label_selector=topics-node` vuoto; nessuno snapshot rimasto se la Fase 1 non è approvata |
| 1 | un nodo fisso, instradamento, macchina tracciata | 16,49 €/mese | una card pesante va al nodo da sola e torna in review (video `.webm`); la riga del nodo con capacità, uso, €/h, spesa e quota (screenshot chiaro e scuro); test verdi |
| 2 | pool on demand | fino al tetto | tre card pesanti in coda fanno nascere un nodo dallo snapshot, che muore a fine ora (video); la spesa del mese nella vista coincide con console.hetzner.com/usage, entro l'arrotondamento |

## Alternativa scartata: cloud di Claude e Codex

La bozza `cloud-executors` (04/10, non tracciata) mandava le card in overflow su
Claude cloud (`claude --cloud`) e Codex cloud (`codex cloud exec`). È scartata per
tre ragioni.

**1. Sono recinti per una corsa, non macchine.** Ogni sessione ha una VM sua:
- Claude: Ubuntu 24.04, circa 4 vCPU, 16 GB e 30 GB, che «si mette in pausa dopo
  qualche minuto di inattività»;
- Codex: 2 vCPU e 8 GiB sul piano Plus (le fonti non concordano).

La rete esce solo dal proxy o dall'allowlist del fornitore, e in ingresso non c'è
niente. Il Mac non può chiamarle: non hanno un `base_url`, e quindi non possono
ricevere `createRun`, `readRun`, `fetchBundle` o `cancelRun`. Non vedono il Mac,
`localhost` né gli MCP locali, e dentro non ci sono gli strumenti MCP di Topics: una
card plan-first, con sottotask o fan-out lì non può lavorare. Da CLI:
- **Claude.** `claude --cloud "<prompt>"` alla creazione è documentato come
  interattivo. `claude -p "<msg>" --cloud <id>` invia ed esce senza la risposta. Non
  esiste un comando non interattivo per lo stato.
- **Codex.** `codex cloud exec|list|diff` è `[EXPERIMENTAL]`. Il workspace aveva 0
  environment e 0 task, e un environment si crea solo dal web. Non esiste un
  comando per fermare una corsa. Ogni sottocomando scrive nella cartella corrente un
  `error.log` che contiene l'`account_id`.

**2. Non si tracciano come macchine.** Non c'è una capacità leggibile né un processo
da misurare. L'uso è solo «corse in volo», e la quota è quella dell'account intero.
Un nodo Hetzner invece si chiama, si misura e ha un prezzo orario.

**3. La quota è la stessa.** Lo dicono le due documentazioni:
- Claude: «cloud sessions share rate limits with all other Claude and Claude Code
  usage within your account… There is no separate compute charge for the cloud VM»;
- Codex: «Local messages and cloud chats share your plan's usage allowance» e
  «Cloud tasks may use more of your allowance than local messages».

Letture del 04/10 verso le 12:45:
- Claude, account 1: 5 ore al 20%, 7 giorni al 7%;
- Claude, account 2: 7 giorni al 100%, bloccato fino al 07/10 alle 06:00;
- Codex: 5 ore al 24%, 7 giorni al 56%.

Il 03/10 ci sono state 470 attese per quota fra le 06:49 e le 13:12, con due
«all-exhausted»: la cloud non avrebbe aggiunto un turno.

Il nodo condivide il terzo limite: anche lui non aggiunge quota. Supera però i primi
due, ed è per questo che è la strada scelta. Dalla bozza si salva un pezzo
indipendente: la quota Codex si legge (`wham/usage` risponde 200, e le rollout
portano `payload.rate_limits`), mentre tre commenti nel codice dicono il contrario.
Va in una card a parte.

## Rischi / Trade-off

- **Il Mac dorme e i nodi a richiesta restano accesi.** Il pool gira sul Mac.
  Mitigazioni:
  - `expires` a +2 h, quindi al risveglio il raccoglitore li cancella;
  - l'allarme in console alla cifra del tetto.

  L'esposizione massima è uguale alle ore di sonno per il prezzo orario. Col massimo
  di D5 (3 nodi, fisso cx43 compreso) i nodi a richiesta sono al più 2: 2 cpx42 per
  48 ore fanno 2 × 48 × 0,1114 = 10,69 €, oltre il fisso che si paga comunque. Un raccoglitore fuori dal Mac (una GitHub Action pianificata col
  token nei secret) si valuta solo se succede davvero.
- **Hetzner limita la creazione a caso.** Il nodo fisso dovrebbe conservare il suo
  posto (dedotto, D4), i nodi
  a richiesta possono ricevere `412`: hanno un nome e un ripiego (POOL-07). Il Mac
  resta il ripiego di tutto.
- **Il nodo esegue codice di agenti con le credenziali del piano.** Le mitigazioni
  sono tre:
  - la policy della tailnet gli vieta il Mac;
  - nessuna credenziale nello snapshot o in `user_data`;
  - nessun token Hetzner a bordo: un nodo non può cancellare altri nodi.

  Il rischio che resta è la credenziale Claude o Codex sul nodo, la stessa che
  c'è sul Mac.
- **Una versione diversa fra Mac e nodo.** La forma delle rotte `/api/nodes/runs`
  potrebbe non coincidere. Il nodo si allinea al commit del Mac a ogni avvio, e il
  fisso a ogni rilascio.
- **La base vecchia** porta conflitti al land (D9), e si misura nella Fase 1.
- **Linux senza pavimento di memoria.** Lo tiene a bada il tetto a mano, fissato
  sulla misura; il lettore di `MemAvailable` arriva solo se serve (D1).

## Migrazione e rollback

- Dalla Fase 1 la migration è additiva: colonne nullable e una tabella. Il
  rollback consiste nello spegnere i nodi nelle impostazioni, e tutto torna al Mac
  per KANBAN-95. Le colonne restano.
- Per tornare indietro dalla Fase 2: pool spento, poi il raccoglitore cancella tutti
  i nodi con la label, e lo snapshot si cancella a mano.

## Domande aperte

- Se valga la pena di un secondo raccoglitore fuori dal Mac. Si decide sui dati
  della Fase 2, e non cambia né le spec né i task.
- Quale `run_cap` dare al cx43. Lo decide la misura della Fase 0 (tasks §0.8), e
  cambia solo un valore.
