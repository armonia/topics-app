## Da decidere

Nodi cloud, piano parcheggiato: 4 scelte. Il nodo libera RAM al Mac, non quota.
1. Al nodo vanno da sole le card pesanti o ferme per memoria; chat e sessioni restano qui. Perché: peso e pavimento esistono già (o: solo card scelte a mano).
2. Fase 1: un cx43 fisso (8 vCPU, 16 GB, 16,49 €/mese) appena torna in vendita. Perché: un server vivo dovrebbe tenere il posto, dedotto (o: cpx42 subito, 69,99 €/mese).
3. Nessun nodo libero: la card torna nella coda del Mac. Perché: è il comportamento di oggi (o: aspetta il nodo).
4. Fase 2: pool da snapshot, fino a 3 nodi col fisso, tetto 10 €/mese oltre il fisso, cancellato da fermo a fine ora pagata. Perché: spento si paga (o: solo il fisso).
Compreso: progetto Hetzner separato dal CRM; niente segreti in snapshot e user_data; ogni nodo è una macchina con vCPU, RAM, €/h, spesa del mese e quota.
Non verificato: Topics come nodo su Linux (la corsia remota non ha mai girato), login CLI senza schermo, Tailscale da cloud-init, quanta RAM sposta un nodo (misurata solo a board ferma: circa 0 GB). È la Fase 0.
Col sì: Fase 0 su un server a ore poi cancellato (meno di 1 €); progetto Hetzner e client OAuth Tailscale li crei tu. Costo: col Mac che dorme il conto corre.
«ok» = tutte le consigliate · «ok ma 2 no» = cambio la 2.

## Dove cambiarla

| # | Scelta | Requisito |
|---|--------|-----------|
| 1 | da sole le card pesanti o ferme per memoria; chat, sessioni e `spawn_agent` mai | `KANBAN-95` (primo paragrafo e scenari «pesante», «ferma per memoria», «una chat»); `KANBAN-76` modificato (paragrafo sulla scelta umana); design §D2 |
| 2 | Fase 1 su un cx43 fisso, solo quando Hetzner lo vende | design §D4 (tipo del fisso) e §Fasi; tasks §1.1 |
| 3 | nessun nodo libero → coda del Mac | `KANBAN-95` (scenario «nessun nodo libero»); `POOL-02` e `POOL-07` (ripiego); design §D3 |
| 4 | pool on demand: 3 nodi col fisso, 10 €/mese oltre il fisso, cancellazione a fine ora pagata | `POOL-01`, `POOL-02`; design §D5 |

---

# Nodi cloud: il lavoro pesante su macchine affittate, da un nodo fisso a un pool che nasce e muore

Bozza parcheggiata (`status: draft`, `parcheggiata` in `.openspec.yaml`, con il testo
esatto della richiesta del 04/10). È un piano futuro: niente codice e niente spesa
finché non arriva il sì a questo blocco.

## Why

**Il Mac muore di RAM, non di CPU.** È un M2 Max con 32 GiB. Il 04/10 alle 14:50
lo swap era a 11,65 GiB su 13,00 (89,6%), le pagine libere sotto i 70 MiB, il
compressore teneva 9,46 GiB di RAM fisica: quota 0,296 dei 32 GiB, lo stesso livello
del blocco del 10/09 (`sysctl vm.swapusage`, `vm_stat`; tutto in GiB). La barra B3 di `mac-usabile-sotto-carico` è
rossa sulle 72 ore dal 01 al 03/10: p95 di swap-in 1241,3/s contro 1092, p95 del
load1 91,2 contro 81,1 (`b3-measure.ts --since 2026-10-01`, exit 1). Il 15/09, con
la board al lavoro: load 253, 12,7 GB di swap, server di Topics fermo fino a 146 s.

**Cosa pesa, e quanto se ne sposterebbe.** Le righe `[memsig]` dal 27/09 sono
10.114, una al minuto; 4243 sono di swap sostenuto. In quei minuti le prime tre
famiglie di processi fanno 16,3 GB di mediana. Il tooling (tsserver, `next dev`,
vite, Playwright, bun, Python, tsc, CLI `claude`) ne vale 5,9 di mediana (p90 15,0):
è il **tetto superiore del tooling**, non la parte spostabile. In 4140 di quei
minuti `inFlight` era 0 e la board era ferma (ultimo tentativo il 27/09 alle 12:09),
quindi quel tooling era delle chat. Il tsserver compare nell'87% dei minuti (mediana
4,6 GB) e resta sul Mac con la chat che lo lancia (§Fuori). Senza tsserver il
tooling ha mediana 0 GB (p90 10,0) ed è presente nel 39,8% dei minuti. In questa
finestra, quindi, le card valevano circa 0 GB: la quota spostabile va rimisurata
con la board al lavoro (`inFlight>0`, «Prima del codice» 11). Il resto sono i
browser e le app di chi usa il Mac (Helium fino a 16,6 GB, OpenBrowser fino a
17,3), che nessun nodo tocca. Una card costa circa 1,5 GB in più quando girano i controlli, a cui si
aggiungono la sua CLI (0,3-0,85 GB misurati) e il suo tsserver (fino a 2,3 GB).
`next dev` è arrivato a 24,5 GB.

**Cosa NON serve spostare.** L'e2e di topics-app non gira sul Mac: fuori da GitHub
Actions la config lo rifiuta, salvo `--list` e `--project=webkit`
(`playwright.config.ts:182-193`). `bun test` invece non ha nessun blocco e sul Mac
può ancora girare. Unit ed e2e delle card si leggono dalla CI della PR (mediane 618 s e 927 s), che è
gratis perché il repo è pubblico: un nodo non batte nove shard gratuiti. In più la
board è ferma dal 27/09, con 0 tentativi da allora, quindi lo swap di questa
settimana non viene dalle card. Per questo il piano resta parcheggiato: il
risparmio arriva quando la board torna a lavorare.

**Il pezzo grosso esiste, ma non ha mai girato.** Un nodo è una seconda
installazione di Topics, che il Mac chiama al suo `base_url`
(`server/services/node-client.ts:238-310`, KANBAN-76 e KANBAN-77). Nel DB di
produzione ci sono 6 macchine, tutte darwin, nessuna con `base_url`, e nessuna card
ha un `machine_id`. Il PC Windows non è un nodo di Topics: è un bersaglio ssh, e
la sua chiave Tailscale è scaduta il 18/09 (offline da 18 giorni).

**Costi letti oggi all'API Hetzner** (`GET /v1/server_types`, `/v1/pricing`; prezzi
netti, `vat_rate` 0, uguali a fsn1, nbg1 e hel1):

| tipo | vCPU / RAM | €/h | tetto €/mese | in vendita oggi in EU |
|---|---|---|---|---|
| cx23 | 2 / 4 GB | 0,0088 | 5,49 | sì in fsn1 e hel1, no in nbg1 |
| cx33 | 4 / 8 GB | 0,0136 | 8,49 | **no** |
| cx43 | 8 / 16 GB | 0,0256 | 15,99 | **no** |
| cx53 | 16 / 32 GB | 0,0473 | 29,49 | **no** |
| cpx32 | 4 / 8 GB | 0,0569 | 35,49 | sì |
| cpx42 | 8 / 16 GB | 0,1114 | 69,49 | sì |

A questo si aggiungono l'IPv4 (0,50 €/mese) e lo snapshot (0,0143 €/GB al mese).
cx33, cx43 e cx53 sono risultati `available:false` in tutte e tre le location in
quattro letture (14:48, 14:54, 15:03 e 15:15 ora di Roma); cpx32 e cpx42 `true`
ovunque. Su status.hetzner.com c'è un incidente aperto dal 26/06 (`0a75c7ae`): la
creazione di nuovi server è limitata «for new customers and some of our existing
customers», scelti a caso. Sui server che esistono già il testo non dice niente:
che non vengano toccati è **dedotto** («Prima del codice» 7). Gli scenari, IPv4
compresa:
- un cx43 sempre acceso costa 16,49 €/mese;
- un nodo on demand 2 ore al giorno costa 1,73 €/mese su cx43 e 6,88 su cpx42;
- una suite su 3 nodi per un'ora costa 0,08 € su cx43 e 0,34 su cpx42.

**La quota resta una.** Il nodo usa lo stesso abbonamento Claude e Codex del Mac. Il
03/10 il cambia-account ha registrato 470 attese per quota, con entrambi gli account
Claude bloccati: quel giorno un nodo non avrebbe aggiunto un turno. Il nodo libera
RAM e CPU, non token.

## What Changes

Tre fasi; ognuna parte solo quando la precedente ha chiuso la sua uscita (design §Fasi).

**Fase 0: prove a mano, nessuna spesa ricorrente.** Un server Hetzner a ore viene
creato, provato e cancellato a mano, per meno di 1 € in tutto. Chiude i punti di
«Prima del codice»: ricetta Linux, login delle CLI, Tailscale da cloud-init,
accoppiamento senza clic, primo giro vero `createRun → bundle → plant`, RAM di una
card e di uno shard su Linux, tempo dal `POST` al nodo pronto, dimensione dello
snapshot. Nel repo entra solo la ricetta (`cloud-init`, unit systemd) e l'esito
scritto nel design.

**Fase 1: un nodo fisso.**
1. **Instradamento** (KANBAN-95, KANBAN-96, KANBAN-76 modificato). Una card senza
   `machine_id` va da sola al nodo se è pesante (`dispatch_weight = heavy`, che
   esiste già) o se il Mac la terrebbe ferma per memoria, purché il nodo sia pronto,
   abbia un posto libero e conosca il suo repository. Il nodo scelto vale per quel
   tentativo e non diventa il `machine_id` della card. «Solo su questo Mac» diventa
   una voce del picker che c'è già. Una pesante sul nodo non ferma i claim del Mac.
2. **Ripiego.** Senza un nodo libero, la card resta nella coda del Mac con le regole
   di oggi.
3. **Il nodo è una macchina tracciata** (MACHINE-05, MACHINE-06). Vengono mostrati:
   - vCPU e RAM, con la fonte;
   - corse in volo sul suo tetto;
   - €/h e tetto mensile dal listino;
   - spesa del mese;
   - account e quota.

   Lo stato viene dai poll, non dal battito del Mac. Tutto sta nella vista delle
   macchine e nel popover del carico che ci sono già.
4. **Linux.** I sei `/usr/sbin/lsof` scritti a mano passano dal binario trovato nel
   `PATH`; il tetto del nodo si fissa in base alla misura della Fase 0.

**Fase 2: pool on demand** (capability nuova `node-pool`, POOL-01…07).
1. Nodi creati da snapshot quando la coda pesante non trova posto, e cancellati da
   fermi alla fine dell'ora già pagata; il fisso non si tocca.
2. Tetto di spesa in euro e numero massimo di nodi; sopra il tetto si ripiega sul
   Mac con una nota.
3. Un progetto Hetzner solo per i nodi; ogni risorsa ha la label `topics-node`, e il
   pool tocca solo ciò che porta quella label; un raccoglitore cancella ciò che ha
   superato `expires`, anche se il DB l'ha dimenticato.
4. Nessun segreto nello snapshot né in `user_data`: dentro ci va solo una chiave
   Tailscale monouso, effimera e a scadenza breve; il resto lo spinge il Mac dopo
   l'ingresso nella tailnet.
5. Accoppiamento senza clic attraverso la tailnet; la porta del nodo non risponde
   sull'IP pubblico.
6. Posti a nome fisso (`topics-node-N`): un nodo che rinasce ritrova la sua riga e
   il suo indirizzo; ogni sua vita resta nella storia con tipo, luogo, ore e costo.
7. I rifiuti del fornitore (`412`, `403`, `422`, `429`) hanno un nome e un ripiego.

## Capabilities

### New Capabilities
- `node-pool`: nodi Linux affittati a ore, creati da un'immagine preparata e cancellati quando non servono, con la spesa sotto un tetto e nessun segreto durevole fuori dal Mac.

### Modified Capabilities
- `kanban`: KANBAN-76 lascia instradare una card senza `machine_id` a un nodo (KANBAN-95); KANBAN-96 conta il peso dove gira.
- `machines`: un nodo porta capacità, uso, costo e quota (MACHINE-05), e il suo stato viene dai poll (MACHINE-06).

## Fuori

- **Chat, turni di chat e sotto-agenti** (`spawn_agent`) sul nodo. Vogliono risposte
  dal vivo, mentre la corsia remota consegna un ramo.
- **Lavoro che vuole il Mac**: `localhost`, Keychain, `~/Darkroom`, MCP locali, il
  WebKit dei tool browser, build e hotfix Tauri macOS, vision. Una card così si
  segna «solo su questo Mac».
- **Lavoro che vuole la GPU o Windows**: la batteria POSE di DanceRooms (WebGL, «GPU
  al 99%, 7 GB di VRAM»), pop-demo (Unreal Win64), il build Windows di Topics.
  Restano sul PC; un server GPU non è stato letto né prezzato.
- **Browser e app dell'utente, server :3333, Topics.app.** Sono il grosso dello swap,
  e nessun nodo li tocca.
- **Il tsserver delle chat** (fra le prime tre famiglie nell'87% dei minuti di swap
  sostenuto, mediana 4,6 GB): resta sul Mac insieme alla chat che lo lancia. È una
  leva a parte, ed è quasi tutto il tooling misurato finora (§Why).
- **Le cloud di Claude e Codex come esecutori.** Scartate: design §«Alternativa
  scartata».
- **Capacità oltre il piano**: extra usage, crediti Codex, chiave API.
- **Un secondo fornitore.** Il pool chiede al fornitore quattro cose (creare,
  elencare, cancellare, prezzi); un altro fornitore si scrive solo quando serve.
- **Il PC come nodo.** Se ci gira Topics è già un nodo per MACHINE-02, e qui non c'è
  niente da aggiungere.
- **La quota Codex** (`wham/usage`, misurata nella bozza `cloud-executors`). Serve
  anche senza cloud: va in una card a parte.

## Prima del codice

Ciò che il piano presume e nessuno ha ancora eseguito. Ogni punto è un passo della
Fase 0 (`tasks.md` §0), e la parte di codice che ne dipende non parte finché il
punto non è chiuso.

1. **Topics come nodo su Linux non è mai girato.** La corsia remota l'hanno provata
   solo i test con un nodo finto. La ricetta è dedotta da codice e CI, e ha questi
   punti da provare:
   - unit systemd su `scripts/start-prod.sh` col watcher spento (usa `fswatch` e
     `stat -f`);
   - `/usr/sbin/lsof` scritto a mano in 6 punti, mentre su Ubuntu sta in
     `/usr/bin/lsof`;
   - `node-pty` con il suo bit `+x`;
   - bind su `::` (`server.ts:3397`), che senza firewall esporrebbe la :3333
     sull'IP pubblico;
   - auto-dispatch acceso sul nodo: `app_settings.auto_dispatch` su
     un'installazione nuova vale 0, e la card specchiata resterebbe in `todo`
     (`task-dispatcher.ts:5470`);
   - progetto registrato per origine git, altrimenti `no_such_repo`
     (`server/routes/nodes.ts:615-616`).
2. **Il primo giro vero `createRun → bundle → plant`** non è mai stato eseguito
   fuori dai test.
3. **La base del lavoro.** Il server del nodo non fa `git fetch` prima di lanciare,
   e il land del Mac non pusha. Il nodo quindi lavora su un `origin/main` più
   vecchio del main del Mac. Va visto da che commit parte la worktree di una card
   specchiata.
4. **Il login delle CLI senza schermo.** `claude` → `/login` via SSH scrive
   `~/.claude/.credentials.json`, che leggono sia la CLI sia il runtime nativo.
   `claude setup-token` oggi non passa:
   - `server/lib/agent-env.ts:17-30` toglie ogni variabile `*TOKEN*` e `*AUTH*`;
   - il runtime nativo legge solo file (`~/.claude/.credentials.json`,
     `~/.jcode/auth.json`, `server/providers/native/auth.ts:115-116`) e, su macOS,
     il Keychain; nessuna variabile d'ambiente. Su Linux restano i due file.

   Per il pool non si sa se due nodi che rinnovano la stessa credenziale si
   invalidano a vicenda. Per Codex c'è `codex login --device-auth`, mai provato qui.
5. **Accoppiamento senza clic.** L'idea è approvare con `curl` in loopback sul nodo,
   dove loopback vuol dire proprietario (`server/lib/device-auth.ts:176`). Da
   provare:
   - che nessun controllo di Origin o CSRF blocchi un `POST` senza Origin;
   - che le richieste successive su `http://<nodo>.ts.net:3333`, con il cookie
     non `secure`, passino il cancello.
6. **Tailscale da cloud-init.** Oggi nel tailnet nessun device ha tag, non c'è
   nessun client OAuth e la policy ACL non si legge senza chiave API. Il tempo dal
   `POST` al nodo pronto non è misurato: le fonti terze danno 25-40 s fino all'SSH,
   su 2 campioni.
7. **Hetzner, cose che una GET non dice:**
   - se il token del progetto nuovo è Read & Write;
   - i limiti veri dell'account (il default è 5 server per account, e il CRM ne
     occupa già 1);
   - la dimensione dello snapshot (stimata 6-12 GB);
   - se i cx mancano a tutti o solo a questo account: lo dice solo un `POST`;
   - se un server che esiste già è al riparo dalla limitazione dell'incidente
     `0a75c7ae`: il testo non lo dice, e la scelta 2 (un fisso che «tiene il
     posto») lo presume.
8. **Cosa contano le code locali.** `heavyInFlight` (`server/services/tasks.ts:1474-1479`)
   e `dispatchedTaskCount` (`server/services/agent-census.ts:116-127`) non
   filtrano `machine_id`, e una card remota è `in_progress`/`working`
   (`task-dispatcher-remote-node.ts:426`). Se la contano, una pesante sul nodo
   ferma ogni claim del Mac, cioè il contrario di KANBAN-96.
9. **Su Linux non c'è il pavimento di memoria** (`server/services/dispatch-capacity.ts:460-475`).
   Resta solo il tetto `max_agents`. Quanti agenti e quanti shard reggono 16 GB non
   è misurato.
10. **La riga del nodo vista dal Mac.** Dopo 5 minuti risulta `offline`, perché il
    battito è solo locale (`server.ts:2965`). Per la corsia non cambia niente, ma
    nella vista è sbagliato (MACHINE-06).
11. **Quanta RAM sposta davvero un nodo.** Nei minuti di swap misurati la board era
    ferma, e il tooling al netto del tsserver delle chat ha mediana 0 GB. La quota
    delle card si misura sulle righe `[memsig]` con `inFlight>0`, quando la board
    torna a lavorare: tooling con e senza tsserver, mediana e p90. Se resta vicina a
    0, la Fase 1 non si giustifica.

## Impact

- **Server.** I punti di innesto, con file e righe, sono in design §«Dove si innesta»:
  - `server/services/task-dispatcher.ts` (il lancio remoto a :2913, l'ammissione
    a :1329);
  - `server/services/task-dispatcher-remote-node.ts` (`remoteLaunch` a :459);
  - `server/services/tasks.ts` e `server/services/agent-census.ts` (i conteggi);
  - `server/routes/machines.ts`;
  - un file nuovo `server/services/node-pool.ts`, con il suo client Hetzner;
  - i sei punti di `/usr/sbin/lsof`.
- **Dati.** Una migration che aggiunge colonne a `machines`, una tabella
  `node_lives` e la macchina del tentativo. Si fa il backup del DB prima di creare
  il file, perché il watcher applica la migration al DB vivo in pochi secondi.
- **Client.** `NodesSection`, `DispatchLoadGauge` e il picker della card
  (`TaskDetail.tsx:1440`).
- **Fuori dal repo**, da creare a mano nelle console:
  - il progetto Hetzner `topics-nodes`, con il suo token nel Keychain;
  - il firewall con selettore di label;
  - tag e client OAuth Tailscale.
- **Costi.** Fase 0 meno di 1 € una tantum. Fase 1 16,49 €/mese. Fase 2 fino al
  tetto scelto.
