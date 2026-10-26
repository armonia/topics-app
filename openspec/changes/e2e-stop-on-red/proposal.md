# e2e-stop-on-red: su una PR gli shard e2e si fermano quando unit o gates sono rossi

## Da decidere

1. **Merge su main a barra verde (consigliata):** su main il comportamento non
   cambia (lo script è la shell normale) e la barra qui sotto è misurata su run veri.
2. Lasciarla aperta.

## Perché

Misure dal 22 al 25/10/2026 su 199 run di CI delle PR (30.720 minuti): in 82 run
unit o gates erano rossi dopo una mediana di 6,6-8,1 minuti, e gli 8 shard e2e
hanno girato fino in fondo per altri 7.749 minuti, il 25% dei minuti delle PR.
Il rosso veniva dalla e2e in 13 run soltanto. I minuti sono gratis (repo
pubblico), i posti no: l'org ha il piano Free, 20 job insieme, una CI ne apre
circa 15, e i job ubuntu delle altre CI aspettano con p90 di 16,7 minuti.

## Cosa cambia

- `scripts/e2e-stop-on-red.sh` è la `shell:` dei tre step lunghi del job `e2e`
  (build + browser, Playwright, file toccati). Esegue lo stesso `bash -e
  <script>`; su una PR legge ogni 45 s i job del run (`actions: read`) e, se
  `unit` o `gates` di questo tentativo sono `failure`, ferma lo step: lo shard
  chiude `failure` con «fermato: unit rosso, la e2e non è il guasto» e il link
  del job rosso. Il run resta `failure`, mai `cancelled`.
- Su main lo script è la shell normale. Ogni dubbio (API illeggibile, meno di
  250 richieste rimaste sul token) fa girare lo step fino in fondo. Con unit e
  gates verdi smette di chiedere: circa 40 richieste a run sulle 5.000 l'ora
  del GITHUB_TOKEN (misurato dall'intestazione sul run 40245465850).
- «Re-run job» su un solo shard: GitHub elenca unit e gates non rilanciati come
  copie nel nuovo tentativo (stesso `run_attempt`, `started_at` vecchio). Lo
  script le scarta, quindi lo shard rilanciato non si ferma su un rosso che
  qualcuno ha scelto di scavalcare. «Re-run failed jobs» rifà unit, e se è di
  nuovo rosso ferma gli shard.
- La board (`server/services/ci-evidence.ts`): uno shard fermato da unit o gates
  rossi aspetta il job `check` e poi nomina il job rosso (come KANBAN-86),
  invece di dire «e2e rossi» e lasciare la riga unit «non misurata».
- `scripts/e2e-stop-on-red.test.sh` (29 controlli, `curl` finto) gira nel job `gates`.

## Barra

Comandi: `python3 openspec/changes/e2e-stop-on-red/bar.py stop|green <run>`.

| | cosa | atteso | run |
|---|---|---|---|
| a | commit che rompe un test unit, poi revert | `stop` exit 0 | [40251091028](https://github.com/armonia/topics-app/actions/runs/40251091028): 9 shard `failure` entro 57 s, «fermato» |
| b | PR verde, durate come prima | `green` exit 0 | [40249331514](https://github.com/armonia/topics-app/actions/runs/40249331514): shard mediano 16,7 min contro 17,0 |
| c | mutante senza fermata + test rotto | `stop` exit 1 | [40252373214](https://github.com/armonia/topics-app/actions/runs/40252373214): shard fino in fondo, 443-825 s dopo il rosso |

In locale: `bash scripts/e2e-stop-on-red.test.sh` exit 0, e 11 mutanti dello
script tutti rossi. Sul run rosso 40238524332 di prima (25/10) `stop` esce 1:
shard finiti 520-792 s dopo il rosso.

## Fuori

- Saltare la e2e sulle PR in bozza (13% dei minuti): un'altra PR.
- Il piano Team: no, per ora (Attilio, 25/10).

## Conseguenze da sapere

- «Re-run failed jobs» dopo un unit flaky rifà anche gli shard fermati: circa
  17 minuti invece di 7.
- Su una PR rossa per unit o gates la riga e2e della board resta rossa
  (`failure`, come richiesto) ma punta al job vero.

## Deciso da me

- 25/10, alla domanda «Fermo la e2e quando unit o gates sono già rossi su una
  PR di topics-app?»: «Sì, con PR (Consigliata)». No al piano Team, per ora.
