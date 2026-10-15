# Report D3h · freschezza dello stato Git

## Barra

**Prima:** nessun banco D3h; freschezza p95 non misurata.

**Dopo:** `bun run measure:git-freshness -- --samples 2`, **exit 2**: 258 file tracked, 0 burner, addon nativo assente; dopo 10 s non è arrivato il `git:status` atteso. Mediana, p95 e massimo non calcolabili. Il target ≤150 ms resta non misurato.

## Misura

- Il banco isolato ha avviato il server sulla porta derivata `15372`; `POST /api/projects`, `GET /api/files`, `GET /api/git/status` e `GET /api/system/status` hanno risposto 201/200/200/200. Il server ha confermato `native/topics_native.node` assente.
- Diagnostica `fs.watch` ricorsivo su una cartella temporanea, scrittura annidata e timeout 2 s: **exit 2**, nessun evento. Il banco finale ha atteso 10 s senza ricevere lo status col percorso scritto. Nessun percentile è stato inventato.
- La misura richiesta con 8 burner è predisposta in un workflow manuale Ubuntu, con build dell'addon e righe nel riepilogo GitHub; non è stata eseguita da questa worktree locale.

**Sul Mac, in revisione** (fuori dal sandbox, dove `fs.watch` consegna gli eventi), addon release
caricato, 0 burner, load average 50: `bun run measure:git-freshness -- --samples 6` → **exit 1**.
Nativo acceso: mediana **352,4 ms**, p95 **366,8 ms**; spento: mediana 374,3, p95 388,4. La barra
di 150 ms è rossa già senza carico.

Dove va il tempo: `server/file-watcher.ts` ricalcola solo dopo **300 ms di silenzio**
(`DEBOUNCE_MS`): un salvataggio non può arrivare al client prima di ~300 ms, nativo o no. Il resto
(evento del file system, status, invio) sta intorno ai 50 ms. Lo status nativo da solo costa pochi
ms su questo repo di prova. Il watcher di `.git` (`server/git-watcher.ts`) aspetta 500 ms, ma
riguarda add, commit e checkout, non il salvataggio di un file.

## Fatto

- `scripts/measure-git-freshness.ts` crea un repo fixture da 258 file, lo apre via API, si collega a `/ws`, alterna file modificati e nuovi, e misura separatamente l'impostazione nativa attiva/spenta. Il listener accetta solo il primo `git:status` dello stesso progetto che include il file scritto; il p95 nativo oltre 150 ms esce 1. I burner sono processi separati e la pulizia chiude i loro gruppi e quello del server anche su errore o SIGINT.
- `bun test scripts/measure-git-freshness.test.ts`: **3 pass, 0 fail, exit 0**. Mutazione in copia che accetta qualunque status: **1 fail, exit 1**.
- `bun run typecheck`: **exit 0**; `bun run typecheck:e2e`: **exit 0**; `bun run lint`: **exit 0**; `./scripts/qa-gate.sh --veloce`: **25 verdi, 0 rossi, exit 0**. `git diff --check`: **exit 0**.

## Trovato e non fatto

- Non si può chiudere il numero della barra senza un watcher che consegni gli eventi e l'addon caricato. La prova sotto carico richiede di eseguire `measure-git-freshness.yml` su GitHub, dove il workflow costruisce l'addon e avvia 8 burner.
- `actionlint` non è installato in questa worktree, quindi il controllo specifico del workflow non è stato eseguito.

## Rifiutato

- L'addon assente sul Mac è il fallback previsto da D3d; non è un guasto del prodotto. Il suo effetto qui è che il ramo nativo non si può misurare.
- Il timeout di 10 s non è un p95 sopra budget: manca il frame necessario a calcolarlo, quindi la misura resta non valida.
