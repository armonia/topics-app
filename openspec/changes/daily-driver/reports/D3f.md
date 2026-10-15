# D3f — visita nativa dell’albero file

## Misura

**Prima, walker JS, 20 giri:** profondità 3 mediana **175,82 ms**, p95 **353,49 ms**; profondità 6 mediana **367,46 ms**, p95 **487,84 ms**.

**Dopo, addon release, 20 giri:** profondità 3 mediana **37,88 ms**, p95 **57,75 ms**; profondità 6 mediana **82,43 ms**, p95 **115,37 ms**. Il confronto JS/Rust usa lo stesso script e lo stesso checkout. `uptime` ha letto load average **95,83 / 72,55 / 67,98**: il carico era alto durante la misura.

**Rifatta in revisione** con `bun run scripts/measure-file-tree.ts`, dopo il giro 2, load average
45-50, 20 giri: profondità 3 JS **62,79 ms** → nativo **19,21 ms** (p95 72,64 → 21,47); profondità
6 JS **161,47 ms** → nativo **51,75 ms** (p95 197,42 → 53,63). Circa tre volte, con meno carico i
numeri assoluti scendono per entrambi.

## Fatto

- `CARGO_BUILD_JOBS=2 scripts/build-native-addon.sh` → **exit 0**, addon universale arm64/x86_64.
- `bun test native/parity.test.ts server/lib/file-tree.test.ts server/lib/native-addon.test.ts` → **exit 0**, **40 pass, 0 fail, 78 assert**. Include parità su 10 alberi fixture e sul checkout, ordinamento, campi `FileNode`, HOME protetta, link simbolici, esclusioni, profondità e test del log con orologio finto.
- Mutazione in una copia temporanea del crate: `.git_ignore(true)` → `.git_ignore(false)`. La fixture «root ignore globs and negations» è diventata rossa: **exit 1 atteso**.
- `bun run scripts/measure-file-tree.ts` → **exit 0**, mediane e p95 su 20 giri JS e Rust a profondità 3 e 6.
- `bun run typecheck` → **exit 0**; `bun run typecheck:e2e` → **exit 0**; `bun run lint` → **exit 0**.
- `./scripts/qa-gate.sh --veloce` → **exit 0**, **0 gate rossi**.
- Il server usa `AsyncTask` quando l’addon espone `walkFileTree`, ordina con `localeCompare` e ricade sul walker JS con contatore. Sopra 200 ms stampa `[FILE-TREE] <ms>`, al massimo una volta al minuto.
- Dipendenze: `ignore` 0.4.33 (Unlicense OR MIT), per `.gitignore` e visita parallela; `time` 0.3.55 (MIT OR Apache-2.0), per i timestamp ISO; `unicode-normalization` 0.1.25 (MIT OR Apache-2.0), per replicare il confronto dei path protetti su macOS.
- Aggiornamento D3d arrivato su `origin/main` durante il lavoro: riportato `lastCommit.time` nei tre file condivisi, per restare compatibili con la parità git appena integrata.

## Trovato e non fatto

- Il job `tauri` su macOS, Windows e Linux non è stato eseguito in CI: il brief locale vieta commit e push; serve la consegna del proprietario per attivarlo.
- Il branch è **2 commit dietro `origin/main`** (`D3d` e `D4j`). Le modifiche D4j sono fuori area; le righe D3d condivise sono state riportate senza spostare il branch.

## Rifiutato

- `lint` segnala **4 warning, 0 errori**, in `App.tsx`, `useProjectBrowserPanes.ts`, `useRemoteBrowser.ts` e `useSpeech.ts`; nessuno di questi file è stato modificato da D3f.

## Giro 2

- `nativeFileTreeEnabled` è server-sincronizzato e acceso di default; `/api/system/status` espone `nativeFileTree` con caricamento, interruttore, chiamate, fallback e ultimo errore. Performance mostra l'interruttore con cataloghi italiano e inglese.
- L'addon assente non genera avvisi. Gli errori nativi reali aggiornano `lastError`, aumentano i fallback e loggano al massimo una volta al minuto.
- Il walker Rust salta gli errori sulle voci e prosegue; la radice illeggibile resta un errore. La parità con JavaScript è verificata anche su una cartella `chmod 000`.
- Il solo caso `chmod 000` è saltato su Windows, dove non limita l'accesso; le altre fixture restano attive.

**Barra prima.** Il giro 1 aveva **3 difetti**: nessun interruttore/stato; l'addon assente generava un avviso ogni 60 s; `result?` interrompeva il walker al primo errore di una voce. La regressione è riprodotta dalla mutazione Rust in copia, exit 1 atteso su `locked`.

**Barra dopo.** 46 test, 0 fail, 90 assert; addon universale arm64/x86_64 ricostruito, exit 0; typecheck, typecheck:e2e, lint e QA veloce verdi, 25 cancelli, 0 rossi.

### Fatto

- Impostazione `nativeFileTreeEnabled` server-sincronizzata, accesa di default; `walkFileTree` usa JavaScript quando è spenta. Test: `bun test server/lib/native-file-tree.test.ts`, incluso nella riga dei 46 test, exit 0.
- `/api/system/status` espone `nativeFileTree` (`loaded`, `enabled`, `calls`, `fallbacks`, `lastError`); test endpoint: `server/routes/status.health.test.ts`, incluso, exit 0.
- Performance mostra l'interruttore accanto a Git, con lo stile condiviso e testi italiani e inglesi. `bun run typecheck` exit 0; i controlli lingua del gate exit 0.
- Addon assente: lo stato registra il fallback senza avviso; il test cattura `console.warn` e verifica zero righe. Errore nativo reale: `lastError` e fallback, con log limitato a una riga al minuto.
- Walker Rust: la cartella `chmod 000` resta nell'albero senza figli e la visita continua. Parità Rust/JS su 10 fixture, checkout e cartella chiusa: `bun test native/parity.test.ts`, incluso nei 46 test, exit 0. Radice mancante: test diretto conferma il rifiuto.
- Mutazione in copia: ripristinato `result?`; il test su `locked` è rosso per `Permission denied`, exit 1 atteso.
- `CARGO_BUILD_JOBS=2 ./scripts/build-native-addon.sh` exit 0; `lipo -info native/topics_native.node` conferma arm64 e x86_64.
- `bun run typecheck` exit 0; `bun run typecheck:e2e` exit 0; `bun run lint` exit 0. `./scripts/qa-gate.sh --veloce` exit 0, 25 cancelli verdi, 0 rossi.

### Trovato e non fatto

- Il caso `chmod 000` è saltato esplicitamente su Windows, dove i permessi POSIX non revocano l'accesso; il resto della parità resta attivo. La verifica del caso chiuso è passata su macOS.
- Il job CI `tauri` sui tre sistemi, eseguito alla consegna: Linux e Windows verdi, macOS rosso per 1 ms sul checkout (sezione sotto).
- Revisione indipendente read-only completata: nessun finding residuo. Non ha eseguito test o browser; la matrice Windows/Linux resta al job CI.
- `cargo fmt --check` non è disponibile: il toolchain Rust locale non ha il componente `rustfmt` (exit 1). La build release compila correttamente.

### Rifiutato

- L'addon assente non è un guasto: ora aggiorna `loaded` e `fallbacks` senza avvisi. Il contatore `calls` resta a zero quando l'interruttore è spento.

## In revisione, dopo la CI

- La parità sul checkout era rossa in CI su macOS per **1 ms** su un file: `.744` dal JS, `.743` dal
  nativo. Bun costruisce `mtimeMs` come `secondi * 1000 + nanosecondi / 1e6` in un double (verificato
  su 3000 file, 3000 su 3000) e `Date` lo tronca. Alle date di oggi quel double ha un passo di circa
  244 ns, quindi un mtime a meno di ~122 ns dal millisecondo successivo sale a quello. Il nativo
  troncava i nanosecondi esatti: ora fa la stessa aritmetica del JS.
- Albero nuovo nella parità, tre file a 999 958 ns dentro il millisecondo: rosso con l'addon di prima
  (3 date diverse), verde dopo. 3000 mtime casuali, circa 860 vicini al bordo: 0 differenze.
