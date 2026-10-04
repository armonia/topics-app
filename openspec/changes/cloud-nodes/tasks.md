# Tasks: cloud-nodes

Change parcheggiata. Prima di qualunque passo, anche della Fase 0:
`grep -qx 'status: approved' openspec/changes/cloud-nodes/.openspec.yaml`.
Se esce non-zero, ci si ferma qui.

Barra di tutta la change (si esegue sempre uguale):
- `bunx --bun @fission-ai/openspec validate cloud-nodes` exit 0;
- `bun run typecheck` exit 0;
- i test elencati sotto verdi;
- la prova di uscita della fase (design §Fasi);
- ciò che è verde oggi resta verde.

Ogni spesa Hetzner è un passo con il suo costo scritto accanto. Nessun passo crea
risorse che restano accese oltre la sua fase.

## 0. Fase 0: prove a mano, nessuna spesa ricorrente (chiude proposal §«Prima del codice»)

- [ ] 0.1 (Attilio, console Hetzner) Progetto `topics-nodes` con token Read & Write nel Keychain (`security add-generic-password -s hcloud -a topics-nodes -w … -U`); firewall `topics-node-fw` con `apply_to` per label `topics-node`, nessuna porta in ingresso tranne UDP 41641; allarme di spesa in console.hetzner.com/usage alla cifra del tetto. Verifica: `GET /v1/servers` col token nuovo → 200 con `servers: []`, `GET /v1/firewalls` → 1 con il selettore.
- [ ] 0.2 (Attilio, admin console Tailscale) `tag:topics-node` in `tagOwners`; ACL membri → `tag:topics-node` su `:3333` e `ssh`, `tag:topics-node` → nessuno; client OAuth con scope `auth_keys` e tag `tag:topics-node`, secret nel Keychain `tailscale/topics-node-oauth`. Verifica: dal Mac una chiave monouso, effimera, preautorizzata con `expirySeconds: 900` coniata via API → 200; l'anteprima ACL dice che il tag non raggiunge il Mac.
- [ ] 0.3 Un server a ore (cx43 se ordinabile, se no cpx32 a 0,0569 €/h) da `ubuntu-24.04`, label `topics-node=1` ed `expires`, `user_data` con la sola chiave di 0.2 e `tailscale up --hostname=topics-node-1 --ssh`. Annotare il tempo dal `POST` a `tailscale status` che lo vede e lo stato della chiave rilette dai metadati dopo l'avvio (POOL-04). Verifica: `nc -z -G 3 <ipv4> 3333` fallisce, `tailscale ping topics-node-1` risponde.
- [ ] 0.4 Ricetta di design §D1 sul nodo, a mano, annotata riga per riga. Verifica: `curl -s http://topics-node-1.<tailnet>.ts.net:3333/` risponde dal Mac; la unit systemd riparte con SIGTERM senza perdere la porta; `lsof` trovato (o il symlink annotato come pezza della sola Fase 0).
- [ ] 0.5 Login delle CLI: `claude` → `/login` via SSH, `codex login --device-auth`. Poi, fuori da Topics, `CLAUDE_CODE_OAUTH_TOKEN=<setup-token> claude -p "ok"` e una chiamata del runtime nativo con quel token come bearer, per sapere se il `setup-token` regge un nodo senza `.credentials.json`. Annotare durata e rinnovo del login. Verifica: una card banale sul nodo risponde con entrambi i provider.
- [ ] 0.6 Accoppiamento: `POST /api/machines/pair` dal Mac verso il `base_url` del nodo; approvazione via `tailscale ssh` + `curl` su `127.0.0.1:3333/api/auth/pair/approve` senza `Origin`. Verifica: la riga `machines` nasce con `base_url`, il gettone è in `<stateDir>/nodes/<id>.token` a `0600`, e un `readRun` successivo su `http://…ts.net` passa il cancello.
- [ ] 0.7 Primo giro vero: progetto topics-app registrato sul nodo, auto-dispatch acceso, una card banale con `machine_id` del nodo. Verifica: la card arriva in `review` sul Mac con `refs/heads/<branch>` piantato; annotare il commit da cui è partita la worktree sul nodo (design §D9).
- [ ] 0.8 Misure sul nodo: RAM di una card con i suoi controlli e di uno shard e2e (`/proc/meminfo` `MemAvailable`, `ps`), due card insieme, eventuale intervento dell'OOM killer (`journalctl -k | grep -i oom`). Sul Mac, in sola lettura: la card remota in `working` conta in `dispatchedTaskCount` e in `heavyInFlight`? Verifica: numeri scritti in design §D1 e §D2 con il `run_cap` scelto.
- [ ] 0.9 Snapshot: `tailscale logout`, credenziali tolte (`find / -name .credentials.json -o -name auth.json` vuoto), `create_image` di tipo snapshot; annotare `image_size`. Server cancellato, nodo ricreato dallo snapshot: tempo dal `POST` all'accoppiamento automatico di 0.6. Poi `DELETE` del server; lo snapshot si cancella anche lui se la Fase 1 non è approvata. Verifica: `GET /v1/servers?label_selector=topics-node` vuoto; spesa della fase < 1 € in console.
- [ ] 0.10 Quota spostabile, sul Mac e senza spesa: quando la board torna a lavorare, sulle righe `[memsig]` di `~/.claude/jarvis/logs/topics-server.log` con `swap=sustained` e `inFlight>0`, mediana e p90 del tooling (tsserver, next-server, start-server, vite, Playwright, bun, Python, tsc, `claude_`) con e senza tsserver, e la quota di minuti in cui c'è. Verifica: i numeri scritti in proposal §Why al posto di «circa 0 GB»; se la mediana senza tsserver resta vicina a 0, la Fase 1 si ferma qui.
- [ ] 0.11 Esiti in design (§D1, §D2, §D5, §D6, §D7, §D9) e in proposal §«Prima del codice» (ogni punto: chiuso con la misura, o il blocco specifico). Verifica: `bunx --bun @fission-ai/openspec validate cloud-nodes` exit 0.

## 1. Fase 1: un nodo fisso

- [ ] 1.1 (Attilio approva la spesa) Nodo fisso `topics-node-1` su cx43, appena `GET /v1/server_types` lo dice `available:true`, creato con la ricetta della Fase 0, `pool_role = fixed`. Verifica: la riga nella vista con 8 vCPU, 16 GB, 0,0256 €/h, 15,99 €/mese.
- [ ] 1.2 Test rossi sul tree di oggi: `server/services/task-dispatcher-remote-node.test.ts` (o un file accanto) per KANBAN-95 (pesante → nodo, leggera ferma per memoria → nodo, leggera con Mac libero → Mac, nessun nodo → coda del Mac con una nota, repository sconosciuto → Mac, `machine_id` locale → mai al nodo, sepoltura → scelta da capo, `machine_id` della card mai scritto) e KANBAN-96 (una pesante sul nodo non ferma i claim locali). Verifica: `bun test` sui file nuovi → rossi per la ragione attesa.
- [ ] 1.3 Backup di `data/topics.db` e `-wal`, poi la migration di design §D8 (colonne di `machines`, `node_lives`, `task_attempts.machine_id`) con `tests/integration/migration-<n>-cloud-nodes.test.ts` contro un DB sintetico; manifest rigenerato. Verifica: `bun run check:migrations` exit 0 e il test verde; `machines.status` col CHECK di prima.
- [ ] 1.4 Instradamento: la macchina del tentativo passata a `remoteLaunch` (`task-dispatcher-remote-node.ts:459`), scelta nel giro del dispatcher accanto al peso (`task-dispatcher.ts:4917-4970`) e all'ammissione (`:1329`); nota del ripiego una per motivo. Verifica: i test di 1.2 su KANBAN-95 verdi, `task-dispatcher-remote-node.test.ts` di oggi ancora verde.
- [ ] 1.5 Conteggi (solo se 0.8 li ha visti contare la card remota): `heavyInFlight` e `dispatchedTaskCount` escludono le corse su un nodo. Verifica: test KANBAN-96 verde.
- [ ] 1.6 Stato del nodo dai poll (MACHINE-06): la spazzata delle macchine ferme salta i nodi con l'ultimo poll riuscito. Verifica: `bun test tests/integration/machines.test.ts` con il caso nuovo.
- [ ] 1.7 `GET /api/machines` con capacità, fonte, uso su `run_cap`, €/h, tetto mensile, spesa del mese (ore arrotondate per eccesso, ferme al tetto), account e quota o «non letta» (MACHINE-05). Verifica: test di integrazione con i due casi «20 minuti = 1 ora» e «61 minuti = 2 ore».
- [ ] 1.8 Vista: righe in `NodesSection`, una riga per macchina nel popover di `DispatchLoadGauge`, voce «Solo su questo Mac» nel picker di `TaskDetail.tsx`, interruttore «Usa i nodi per il lavoro pesante». Testi italiano e inglese, icone lucide. Verifica: `tests/e2e/cloud-nodes.spec.ts` su `:13334`, WebKit, `page.route` su `/api/machines`.
- [ ] 1.9 Linux: i sei `/usr/sbin/lsof` passano dal binario trovato come `listening-ports.ts:61`. Verifica: `grep -rn '"/usr/sbin/lsof"' server` → solo il ripiego dentro l'helper; test dei moduli toccati verdi.
- [ ] 1.10 `deploy/cloud-node/` (cloud-init, unit systemd, ricetta) e `docs/cloud-node.md`. Verifica: la ricetta rifatta da zero su `topics-node-1` ricostruito arriva all'accoppiamento senza passi a mano oltre ai login.
- [ ] 1.11 Prova di fase: una card pesante vera va al nodo da sola e torna in review (video `.webm`); screenshot della riga del nodo e del popover, chiaro e scuro. Verifica: gli artefatti allegati alla card.

## 2. Fase 2: pool on demand

- [ ] 2.1 Test rossi: `server/services/node-pool.test.ts` con un fornitore finto e l'orologio finto. Casi: crea quando la coda chiede (POOL-01); non cancella a 15 minuti, cancella a 52 se fermo da 10; il fisso mai; tetto e massimo (POOL-02); solo label `topics-node`, ritrovo al riavvio, `expires` scaduto cancellato anche se sconosciuto (POOL-03); `412`/`403`/`422`/`429` con il nome e il tipo successivo, attesa prima di ritentare, nodo che non arriva in 10 minuti cancellato (POOL-07); stesso posto, stessa riga (POOL-06). Verifica: rossi per la ragione attesa.
- [ ] 2.2 `server/services/node-pool.ts` e il client Hetzner (`create`, `list(label)`, `delete`, `prices`), token letto dal Keychain, mai nei log. Verifica: i test di 2.1 verdi.
- [ ] 2.3 Chiave Tailscale per nodo via client OAuth, solo in `user_data` (POOL-04). Verifica: test che il `user_data` generato contiene solo la chiave, l'hostname del posto e il commit del Mac.
- [ ] 2.4 Accoppiamento automatico (design §D7) e spinta delle credenziali dopo l'ingresso (design §D6, nella forma uscita da 0.5). Verifica: test di integrazione con un nodo finto che chiede l'approvazione; nessuna credenziale nei log del pool.
- [ ] 2.5 Snapshot: ricetta per rifarlo, tenuto solo l'ultimo, label `topics-node`. Verifica: `GET /v1/images?type=snapshot&label_selector=topics-node` → 1.
- [ ] 2.6 Impostazioni del pool: acceso/spento, tipi ammessi in ordine, massimo nodi (3), tetto €/mese (10), spesa del mese in vista. Verifica: e2e su `:13334` con `page.route`.
- [ ] 2.7 Prova di fase (spesa: poche ore di nodo): tre card pesanti in coda fanno nascere `topics-node-2` dallo snapshot, lavorano, il nodo muore a fine ora (video `.webm`); spesa del mese nella vista confrontata con console.hetzner.com/usage. Verifica: differenza entro l'arrotondamento all'ora, `GET /v1/servers?label_selector=topics-node` col solo fisso.
