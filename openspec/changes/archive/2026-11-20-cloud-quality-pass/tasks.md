# Tasks: cloud-quality-pass

Ogni traccia è una sessione cloud lanciata da questo ramo (`cloud/quality-pass`) con il suo file
in `tracks/`. Lo stato non sta in una casella: lo dicono il ramo sul remoto
(`git ls-remote origin 'cloud/*'`), il REPORT in `reports/` e la barra eseguita sul ramo.

| Traccia | File | Ramo | Dipende da | Barra (oltre a `specs/acceptance.md` §1) |
|---|---|---|---|---|
| T0 pilota | `tracks/T0-baseline.md` | `cloud/t0-baseline` | niente | `baseline.md` con un numero o un motivo per ogni riga |
| T1 Topic | `tracks/T1-topic.md` | `cloud/t1-topic` | T0 | `check:ink` tab −30%, `check:scroll-fluidity` −50%, primo frame idratato, video |
| T2 Task | `tracks/T2-task.md` | `cloud/t2-task` | T0 | `check:ink` card −30%, `check:drag` p95 < 16,7 ms, video |
| T3 avvio e bundle | `tracks/T3-startup-bundle.md` | `cloud/t3-startup-bundle` | T0 | chunk eager gzip −20%, avvio server −20% |
| T4 codice morto | `tracks/T4-dead-code.md` | non lanciata | T0 | **Rifiutata dopo T0**: `check:deadcode` = 0 file, 0 export, 0 tipi, 0 dipendenze inutilizzati; le 482 righe duplicate di `check:bloat` non valgono una sessione |
| T5 server | `tracks/T5-server.md` | `cloud/t5-server` | T0 | `check:route-latency` p95 −30% su 2 rotte, 0 chiamate esterne senza timeout |
| T6 cancelli | `tracks/T6-gates.md` | `cloud/t6-gates` | T0 | 44/44 classificati, `qa-gate.sh --veloce` −30% |

Ordine di lancio dopo T0: T1 e T2 per primi (sono la richiesta), poi T3, T5, T6 insieme; T4 no. T4 e T6
toccano molti file: si fondono per ultime, dopo T1-T3 e T5, per non riaprire i loro conflitti.

Dopo ogni consegna, sul Mac: revisione indipendente (un giro), fusione in una worktree,
`qa-gate.sh --veloce` sulla fusione, PR, CI verde, merge. Mai nel checkout di produzione.
