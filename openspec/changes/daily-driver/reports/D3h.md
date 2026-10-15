# Report D3h · freschezza dello stato Git

## Barra

**Prima:** nessun banco D3h; freschezza p95 non misurata.

**Dopo:** `bun run check:git-freshness -- --samples 2`, **exit 2**: 258 file tracked, 0 burner, addon nativo assente; dopo 10 s non è arrivato il `git:status` atteso. Mediana, p95 e massimo non calcolabili. Il target ≤150 ms resta non misurato.

## Misura

- Il banco isolato ha avviato il server sulla porta derivata `15372`; `POST /api/projects`, `GET /api/files`, `GET /api/git/status` e `GET /api/system/status` hanno risposto 201/200/200/200. Il server ha confermato `native/topics_native.node` assente.
- Diagnostica `fs.watch` ricorsivo su una cartella temporanea, scrittura annidata e timeout 2 s: **exit 2**, nessun evento. Il banco finale ha atteso 10 s senza ricevere lo status col percorso scritto. Nessun percentile è stato inventato.
- La misura richiesta con 8 burner è predisposta in un workflow manuale Ubuntu, con build dell'addon e righe nel riepilogo GitHub; non è stata eseguita da questa worktree locale.

**Sul Mac, in revisione** (fuori dal sandbox, dove `fs.watch` consegna gli eventi), addon release
caricato, 0 burner, load average 50: `bun run check:git-freshness -- --samples 6` → **exit 1**.
Nativo acceso: mediana **352,4 ms**, p95 **366,8 ms**; spento: mediana 374,3, p95 388,4. La barra
di 150 ms è rossa già senza carico.

Dove va il tempo: `server/file-watcher.ts` ricalcola solo dopo **300 ms di silenzio**
(`DEBOUNCE_MS`): un salvataggio non può arrivare al client prima di ~300 ms, nativo o no. Il resto
(evento del file system, status, invio) sta intorno ai 50 ms. Lo status nativo da solo costa pochi
ms su questo repo di prova. Il watcher di `.git` (`server/git-watcher.ts`) aspetta 500 ms, ma
riguarda add, commit e checkout, non il salvataggio di un file.

## Fatto

- `scripts/check-git-freshness.ts` crea un repo fixture da 258 file, lo apre via API, si collega a `/ws`, alterna file modificati e nuovi, e misura separatamente l'impostazione nativa attiva/spenta. Il listener accetta solo il primo `git:status` dello stesso progetto che include il file scritto; il p95 nativo oltre 150 ms esce 1. I burner sono processi separati e la pulizia chiude i loro gruppi e quello del server anche su errore o SIGINT.
- `bun test scripts/check-git-freshness.test.ts`: **3 pass, 0 fail, exit 0**. Mutazione in copia che accetta qualunque status: **1 fail, exit 1**.
- `bun run typecheck`: **exit 0**; `bun run typecheck:e2e`: **exit 0**; `bun run lint`: **exit 0**; `./scripts/qa-gate.sh --veloce`: **25 verdi, 0 rossi, exit 0**. `git diff --check`: **exit 0**.

## Trovato e non fatto

- Non si può chiudere il numero della barra senza un watcher che consegni gli eventi e l'addon caricato. La prova sotto carico richiede di eseguire `check-git-freshness.yml` su GitHub, dove il workflow costruisce l'addon e avvia 8 burner.
- `actionlint` non è installato in questa worktree, quindi il controllo specifico del workflow non è stato eseguito.

## Rifiutato

- L'addon assente sul Mac è il fallback previsto da D3d; non è un guasto del prodotto. Il suo effetto qui è che il ramo nativo non si può misurare.
- Il timeout di 10 s non è un p95 sopra budget: manca il frame necessario a calcolarlo, quindi la misura resta non valida.

## D3i · Correzione della freschezza

**Prima:** mediana **352 ms**, p95 **367 ms** sul Mac senza carico (valori D3i); obiettivo D3 ≤150 ms con 8 processi non raggiunto. **Dopo:** test deterministici, primo refresh a **50 ms**, refresh finale a **300 ms** dall'ultimo evento; percentile reale non misurato.

### Fatto

- `bun test server/file-change-debouncer.test.ts`: **4 pass, exit 0**; senza il ramo del primo refresh, la mutazione in copia fa fallire il test singolo (**exit 1**).
- `bun run typecheck`, `bun run typecheck:e2e`, `bun run lint`: **exit 0**. `./scripts/qa-gate.sh --veloce`: **25 verdi, 0 rossi, exit 0**. `git diff --check`: **exit 0**.

### Trovato e non fatto

- `bun test server/file-watcher*.test.ts`: **3 pass, 1 fail, exit 1**, timeout a 120,09 s perché `fs.watch` non consegna eventi in questo sandbox. La misura end-to-end sotto carico resta da eseguire su un host che riceve gli eventi.

### Rifiutato

- Il watcher `.git` da 500 ms riguarda add, commit e checkout, quindi non è coinvolto nella freschezza dei salvataggi; è rimasto invariato.

### In revisione (D3i)

- Il ricalcolo finale partiva anche per un salvataggio atomico (scrittura e rinomina a pochi ms):
  la regola era «più di un evento nella raffica». Ora parte solo se è arrivato un evento **dopo**
  il ricalcolo iniziale; unit nuova «salvataggio atomico, un solo ricalcolo», e la mutazione che fa
  partire sempre il ricalcolo finale rende rosse 3 unit su 5.
- Il banco scriveva i campioni uno dopo l'altro: ogni salvataggio cadeva nella finestra di 300 ms
  del precedente e misurava la strada della raffica. Ora fra un campione e l'altro aspetta più della
  finestra, così misura un salvataggio vero. Una scrittura entro 300 ms da un'altra resta una
  raffica e arriva col ricalcolo finale, per scelta: limita i ricalcoli di un `git checkout` o di
  un agente che scrive molti file.
- Misura sul Mac, addon release, 0 burner, load average 6-15, 10 campioni:
  `bun run check:git-freshness -- --samples 10` → **exit 0**, nativo acceso mediana **105,2 ms**,
  p95 **126,0 ms**; spento mediana 119,3, p95 125,2.
- La stessa misura in una copia col vecchio debounce (solo il ricalcolo finale), con le stesse
  pause: **exit 1**, mediana 344,9 ms, p95 352,5. Il verde viene dalla correzione, non dal banco.
- Il workflow della misura con 8 burner gira anche sulle PR che toccano questo percorso.
- Trovato e non fatto: `WORKTREE-05 … fetching without ref changes does not publish a git status`
  (`server/git-watcher.test.ts`) fallisce 2 volte su 3 quando gira insieme ai test del file
  watcher, **anche su `origin/main`** senza questo ramo; da solo passa. È un'instabilità di tempi
  che c'era già, non viene dal debounce nuovo.

- **Barra di D3 sotto carico, in CI** (run 38789970988, `ubuntu-latest`, addon costruito, 8 burner,
  20 campioni): **exit 0**, nativo acceso mediana **74,1 ms**, p95 **89,1 ms**, massimo 124,3;
  spento mediana 79,1, p95 83,0. Il p95 sta sotto i 150 ms: la barra di freschezza di D3 è verde.
- Lo script si chiamava `measure:git-freshness`, e il prefisso `measure:` dichiara un referto, che
  non può entrare in un workflow (`tests/unit/check-scripts-are-wired.test.ts`, rosso in CI). Crea
  il suo repo e il suo server ed esce non-zero sopra il budget, come `check:route-latency`: è un
  cancello del codice. Ora si chiama `check:git-freshness`; script, test e workflow rinominati.
