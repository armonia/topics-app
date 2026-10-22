# Tasks: giornata-condivisa

Ogni traccia ha il suo file in `tracks/` e un ramo `prog/<id>`. Lo stato non sta
in una casella: lo dicono il ramo sul remoto (`git ls-remote origin 'prog/*'`),
il report in `reports/<id>.md` e la barra eseguita.

| Traccia | File | Dipende da | Barra propria |
|---|---|---|---|
| T0 trunk | `tracks/T0-trunk.md` | niente | `main...origin/main` da `0 0`; nessun `land-drags-foreign-commits` |
| T1 origine | `tracks/T1-origine.md` | niente | i due `curl` tornano 403; il test della porta e' verde |
| T2 backup | `tracks/T2-backup.md` | niente | `backup-restore-check.ts` esce 0; una copia fuori disco |
| T3 orologio | `tracks/T3-orologio.md` | T0 | 0 `SELECT MAX(server_seq)`; `measure-cross-device.ts` ripetibile entro il 10% |
| T4 convergenza | `tracks/T4-convergenza.md` | T3 | 200 seed x 3 client: 0 divergenze; i 96 call site a 0 |
| T5 isolamento | `tracks/T5-isolamento.md` | niente | 20 giri a ordine casuale: 0 rossi; 4 shard p50 <= 300 s |
| T6 guscio | `tracks/T6-guscio.md` | niente | tauri >= 2.12.3; `assert-sig` morde; test del channel con `throw` |
| T7 persone | `tracks/T7-persone.md` | T1, T3 | scenario 2 con video; `level` sul link; FK su `activity_log` |
| T8 runner | `tracks/T8-runner.md` | T0 | swap sotto 1 GB con 5 card per 30 min; `runner-parity.ts` |
| T9 istantaneo | `tracks/T9-istantaneo.md` | niente | `check:ink` O(1) per chunk; `check:inp-shell` dal guscio vero |
| T10 tentativi | `tracks/T10-tentativi.md` | T8 | scenario 4 con video; nessun residuo di worktree |
| T11 giudice | `tracks/T11-giudice.md` | T0 | `delivery-score.ts` rifiuta sha non pushato e rail ereditato |
| T12 pulizia | `tracks/T12-pulizia.md` | T2 | nessuna worktree nel repo; nessun segreto non tracciato in radice |

## Ordine

1. **T0, T1, T2 per prime e in questo ordine.** Senza un solo trunk ogni
   consegna nasce da una base stantia; senza il cancello d'origine chiuso ogni
   superficie nuova e' una superficie in piu' esposta; senza un backup provato
   nessuna migration che segue e' reversibile.
2. **Poi in parallelo, perche' non toccano gli stessi file:** T5, T6, T9, T12.
3. **T3, poi T4.** Il banco di convergenza senza un orologio unico misurerebbe
   la convergenza di un solo dominio.
4. **T8 prima di T10.** Tre tentativi su questa macchina senza budget sono tre
   volte il problema di T8.
5. **T7 dopo T1 e T3.** Esporre persone prima di aver chiuso l'origine e' il
   reperto trasversale dell'audit: piu' superficie prima di aver chiuso quella
   che c'e'.
6. **T11 dopo T0**, perche' due dei suoi controlli parlano del trunk.

Dopo ogni consegna: revisione da chi non ha scritto, fusione in una worktree,
`qa-gate.sh --veloce`, PR, CI verde, merge.

## Change aperte che questo piano porta a termine

Non le riscrive: ne esegue le barre dentro la traccia indicata. Stato letto su
`origin/main` il 22/10.

| Change | Traccia | Stato |
|---|---|---|
| `pane-store-server-authoritative` | T4 | 16 su 36 |
| `relay` | T7 | 18 su 24 |
| `device-auth` | T7 | 19 su 20 |
| `sharing-orgs` | T7 | 29 su 30 |
| `amici-e-account` | T7 | 0 su 20 |
| `cloud-nodes` | T8 | 0 su 29 |
| `primo-avvio` | T9 | decisioni chiuse, niente nel client |
| `mac-usabile-sotto-carico` | T8 | vedi la traccia |

## Da archiviare

`daily-driver` ha chiuso il suo arco: 45 report su `origin/main`, D8 dichiara i
sei problemi del browser chiusi in produzione dalla 2.2.507 e dalla 2.3.2, e
nessun ramo `daily/*` e' aperto sul remoto. Va archiviato con `/opsx:archive`
prima che questo piano parta, cosi' `openspec/changes/` dice il vero.
