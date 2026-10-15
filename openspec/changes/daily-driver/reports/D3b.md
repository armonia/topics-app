# D3b — fattibilità dell'addon N-API

## Barra prima

- D3b assente: nessun crate, loader, selftest o passo CI. Sidecar arm64 senza addon: **67.956.594 byte**, `bun build --compile --target=bun-darwin-arm64 ...` exit 0.
- Cancelli prima: non eseguiti; non c'è una misura precedente per test, typecheck o lint.

## Barra dopo

- `scripts/build-native-addon.sh`: **exit 0**, compilazione Cargo release in **21,33 s**; addon universale arm64+x86_64 da **4.374.160 byte**.
- `scripts/build-server-sidecar.sh macos` con `BUN_DARWIN_X64_EXECUTABLE`: **exit 0**; `lipo -info` conferma arm64+x86_64. Server arm64: **67.956.594 → 72.365.298 byte**; binario universale: **151.778.546 byte**.
- Binario universale con `native/topics_native.node` spostato fuori dal checkout, `--native-selftest`: **exit 0**, `native ok 0.1.0 24dd7e71d724640192760e481d0dd59435db4757`.
- Senza addon, `scripts/build-server-sidecar.sh smoke`: **exit 0**, `/api/topics` **200**, `/api/terminal/sessions` **503**, migrazioni embedded **186**.
- `bun test server/lib/native-addon.test.ts`: **exit 0**, **2/2**, 10 assertion; copre assenza addon, HEAD, worktree collegata e cartella non Git.
- `./scripts/qa-gate.sh --veloce`: **exit 0**, **23/23 `check:*` verdi**, typecheck e lint verdi. `bash -n` e `git diff --check`: **exit 0**.

**Decisione:** `napi-rs` regge la prova di fattibilità su macOS universale. Non si passa al sidecar Rust/socket.

## Fatto

- Crate `native/` con `napi 3.14.2`, `napi-derive 3.6.12`, `napi-build 2.6.0` (MIT) e `gix 0.89.0` (MIT OR Apache-2.0). `gix` usa solo `revision`, `sha1` e `sha256`; i feature dei client di rete e TLS restano spenti.
- Loader memorizzato una volta, addon da checkout o asset del binario compilato, `null` e una riga di log se mancante o non caricabile. `--native-selftest` stampa versione e HEAD prima di avviare il server.
- Il job CI `tauri` ora installa Bun 1.4.2 e `node-pty`, crea l'addon per l'host, compila il sidecar e lo avvia senza il `.node` sul disco; lo script `.sh` usa Bash anche su Windows. Su macOS usa `@oven/bun-darwin-x64` 1.4.2 (MIT), solo come runtime di compilazione x64, per evitare il download cross-target che è fallito localmente.
- File coinvolti: `.github/workflows/ci.yml`, `.gitignore`, `native/Cargo.toml`, `native/Cargo.lock`, `native/build.rs`, `native/src/lib.rs`, `openspec/changes/daily-driver/specs/acceptance.md`, `scripts/build-native-addon.sh`, `scripts/build-server-sidecar.sh`, `server/lib/native-addon.ts`, `server/lib/native-addon.test.ts`, `server/sidecar-entry.ts`.

## Trovato e non fatto

- La matrice CI reale Linux/Windows/macOS resta da eseguire dal verificatore. Atteso: build host dell'addon e output `native ok` in tutti e tre. I punti più esposti sono il caricamento N-API nel binario Bun su Windows e la firma macOS, che è fuori da questo passo.

## Rifiutato

- Il primo errore Cargo veniva da un `cc` nel `PATH` che non è un compilatore, non dal linker Rust: su macOS lo script usa `/usr/bin/clang` quando `CC` non è impostato.
- Il primo cross-build x64 falliva nell'estrazione del runtime Bun scaricato. Il runtime ufficiale x64 1.4.2 da npm e il nuovo input dello script hanno completato la stessa build universale; il sidecar/socket non serve.

## Revisione (15/10)

- L'addon esportava `gitHeadOid` e il caricatore teneva anche un alias `gitHeadCommitId` che nessuno
  esporta: ora il nome è uno, `gitHeadCommitId`, da Rust al TypeScript.
- Nel checkout il caricatore cercava l'addon da `process.cwd()`: ora da `import.meta.dir`, così non
  dipende dalla cartella da cui parte il server o il test.
- Il test lasciava in `/tmp` il repo e la worktree di prova a ogni giro: ora cancella tutta la
  cartella.
- Prova sul Mac, server compilato per arm64 con l'addon incorporato e il `.node` tolto dal disco:
  `--native-selftest` esce 0 con `native ok 0.1.0` e lo stesso HEAD di `git rev-parse`. Lo stesso
  binario senza addon incorporato esce 1 con «native module not found at /$bunfs/root/…»: il passo
  della CI morde.
