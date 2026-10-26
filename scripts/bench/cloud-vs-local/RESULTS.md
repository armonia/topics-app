# Card cloud contro card locali: carico sul Mac (26/10/2026)

In ogni giro 4 card partono insieme con lo stesso compito: `bun install`, `bun test shared/`,
lettura di un file e, nei giri 2 e 3, il typecheck. Usano Sonnet 5.5 con effort low.

- **In cloud:** girano sull'adattatore `claude-cloud`, account vdm auto-3.
- **In locale:** girano con `claude -p --output-format stream-json`, ciascuna nel suo worktree,
  com'è la CLI che lancia il provider claude-code.

Cosa si misura: il `phys_footprint` sommato su tutto l'albero dei processi della fase, con un
campione ogni secondo (giri 2 e 3) o ogni 3 s (giro 1). In più la pressione di memoria e lo swap.
Prima di ogni fase c'è un riposo di 60 s.
Il freno: se la pressione arriva a 2, la fase locale si ferma (il Mac lo sta usando Attilio).

| giro | compito | cloud: footprint max | cloud: pressione | locale: footprint max | locale: pressione |
|---|---|---|---|---|---|
| 1 | install + test | 25 MB | 1 | 735 MB | 1 |
| 2 | + tsc con tsconfig sbagliato (non è partito) | 24 MB | 1 | 2.205 MB | 1 |
| 3 | + `tsc -p tsconfig.server.json` | 25 MB | 1 | **4.511 MB in 20 s** | **2: fermato** |

- **Cloud:** 4 card su 4 finite in tutti e tre i giri, durata media 35 / 43 / 75 s. Nel giro 3 il
  typecheck è partito davvero (13 errori, gli stessi che trova una card locale). Il carico sul Mac
  è solo il processo che legge gli eventi: 24-25 MB per tutte e 4 le card insieme, senza
  differenza fra compito leggero e pesante.
- **Locale:** circa 180 MB per card col compito leggero. Col typecheck vero le 4 card hanno
  superato 4,5 GB in 20 s e la pressione è salita a 2. La fase si è fermata da sola, quindi il
  picco reale è più alto.
- **Limite:** lo swap non si è mosso in nessun giro (le fasi sono brevi). Il segnale che conta è
  la pressione.

Sessioni cloud dei giri: in `bench{1,2,3}/cloud-results.json` (scratchpad della sessione del 26/10).
Si rifà con `CLOUD_ACCOUNT=auto-3 OFFLOAD=local BENCH_TASK=heavy STEP=1 sh run.sh <cartella>`.

## Stop su una sessione vera (26/10, `stop-probe.ts`)

Sessione Haiku su `armonia/topics-app` con `sleep 240`, stop a 17 s: l'`interrupt`
(`control_request`, `cancel_queued`) chiude il turno con `result/error_during_execution` in meno di
un secondo, e `POST /v1/sessions/<id>/archive` la porta a `session_status: "archived"`. Nel flusso
compaiono due `control_request` che non sono permessi (`interrupt`, `end_session`): ora si
filtrano (`isPermissionAsk`).
