# D3e · Numstat nativo

## Barra prima e dopo

- **Prima:** `bun test native/parity.test.ts`, exit 0, 30 pass. Il log diceva `SKIP native git status parity: build-native-addon.sh has not run`; la parità nativa non era stata misurata.
- **Dopo:** `bun test native/parity.test.ts server/lib/git-status.native.test.ts`, exit 0, 40 pass, 0 fail, 149 asserzioni. I 36 scenari confrontano entrambi i lati del numstat con git; i quattro test server verificano anche zero spawn e ripiego per-path.
- `bun run typecheck`, `bun run typecheck:e2e`, `bun run lint`, `./scripts/qa-gate.sh --veloce`: exit 0. Il gate ha 25 verdi e 0 rossi. Lint: 0 errori, 4 warning in file non toccati.

## Fatto

- `gitNumstat(path)` asincrono nel crate, wrapper opzionale nell’addon; un addon precedente senza la funzione resta caricabile. `scripts/build-native-addon.sh`, release macOS arm64 + x64, exit 0.
- `computeGitStatus` usa i due risultati nativi, salta il calcolo oltre 400 voci e ripiega su git solo per i path non gestiti; `serverSpawnCounts` misura 0 spawn nelle tre fixture d’integrazione con addon reale.
- Copertura dei 36 scenari: binario, rename modificato, file senza newline finale, CRLF, cambio solo modo, cancellazione, aggiunta staged poi modificata, submodule e i 30 scenari originari. `bun test native/parity.test.ts server/lib/git-status.native.test.ts`, exit 0.
- Mutazione in copia del crate, aggiunte e tolte invertite: il test fallisce come deve, exit 1, risultato 1/2 contro atteso 2/1.
- `git diff --check`, exit 0.

## Misura

Release, `scripts/build-native-addon.sh` con `CARGO_BUILD_JOBS=2` e linker clang dello script. Dieci ricalcoli alternati per ramo, con 300 file modificati e risultati verificati uguali:

- Worktree collegata: git mediana **72,74 ms**, nativo **32,10 ms**.
- Checkout: git mediana **73,24 ms**, nativo **34,82 ms**.

## Trovato e non fatto

- Il p95 con 8 processi CPU saturi è fuori da D3e e resta da misurare nella verifica separata di freschezza.
- La matrice CI macOS/Linux/Windows non è stata lanciata: richiede il push, escluso dal brief locale. Il gate CI resta da confermare dopo la consegna del ramo.
- CRLF normalizzato che produce zero righe usa il ripiego per-path di git, perché gix e git non concordano sul record vuoto in questo fixture.

## Rifiutato

- I quattro warning lint già presenti in `App.tsx`, `useProjectBrowserPanes.ts`, `useRemoteBrowser.ts` e `useSpeech.ts` non sono errori e nessuno dei file è stato toccato.

## Giro 2

### Fatto

- `gitNumstat(repoPath, entries)` riusa lo status del server. HEAD e indice sono interrogati per percorso; non vengono più ricostruiti l’indice da HEAD né mappe complete.
- `CARGO_BUILD_JOBS=2 ./scripts/build-native-addon.sh` → exit 0; `bun test native/parity.test.ts server/lib/git-status.native.test.ts` → exit 0, 40 pass, 149 asserzioni.
- Mutazione in copia: cercare HEAD col percorso nuovo rende rossa la rinomina modificata; 35 scenari verdi su 36, test mutato exit 1 atteso.

### Misura

Build release, fixture isolata con 400 file tracciati e 244 voci modificate, 10 campioni alternati per funzione; tempo misurato solo nella chiamata della funzione. Mediane: `gitStatus` **8,25 → 5,47 ms**; `gitNumstat` **48,67 → 28,57 ms**.

### Trovato e non fatto

- p95 con 8 processi CPU e matrice CI macOS/Linux/Windows restano da verificare fuori dal giro locale. `cargo clippy` non è presente nel workflow CI.
