# D3g · Il server dal checkout usa il bridge PTY Rust

## Barra prima

- Worktree pulita su `daily/d3g-rust-pty-bridge`, 0 file modificati. La barra completa non è stata misurata prima del primo intervento.

## Barra dopo

- `bun test tests/integration/pty-bridge-mjs.test.ts server/routes/terminal.standalone.test.ts`: 13 pass, 0 fail, exit 0; protocollo Node: 6/6 e Rust: 6/6, entrambi exit 0.
- `bun run typecheck`: exit 0, 5 sotto-comandi verdi; errori server 0.
- `bun run typecheck:e2e`: exit 0.
- `bun run lint`: exit 0, 0 errori e 4 warning in file non toccati.
- `./scripts/qa-gate.sh --veloce`: exit 0, 23 `check:*` verdi, 0 rossi; typecheck e lint verdi.
- `cargo test --offline --manifest-path desktop-tauri/pty-bridge/Cargo.toml`: exit 0, 7 test Rust verdi; cache e target in `/private/tmp`.
- `cargo build --offline --manifest-path desktop-tauri/pty-bridge/Cargo.toml`: exit 0; protocol Rust contro il binario costruito: 6 pass, 0 fail, exit 0.
- E2E terminali non eseguiti sul Mac, come vietato dal brief locale; restano alle CI.

## Fatto

- Selezione bridge: override `TOPICS_PTY_BRIDGE_BIN`, poi binario Rust prodotto da `scripts/build-pty-bridge.sh`, infine bridge Node. `/api/system/status` e Prestazioni mostrano motore, connessione e motivo della selezione.
- I bridge Node e Rust dichiarano il motore nel `pong`; il server identifica anche un bridge vivo riusato senza chiuderlo.
- Riuso bridge vivo: test verde sopra. Mutazione temporanea che forzava il ramo di spawn: test rosso, 6 pass e 1 fail, exit 1; file ripristinato e suite di nuovo verde.
- La prima suite Rust ha trovato il socket ancora presente dopo `SIGKILL` durante la grazia. Il bridge ora lo rimuove all'inizio dello shutdown; nuova `cargo test` 7/7 e protocol suite Rust 6/6 verdi.
- La suite di protocollo è la stessa per entrambi i binari. La CI Unix compila il binario e avvia questa suite con `TOPICS_PTY_BRIDGE_TEST_BIN`.

## Trovato e non fatto

- E2E `terminal-session-resume.spec.ts` e `terminal-tab-reload.spec.ts`: da eseguire nella CI di consegna; il Mac non può provarli.
- Il job CI modificato non è stato lanciato da questa worktree.

## Rifiutato

- Nessuna sessione viene terminata o migrata a caldo. Il Rust entra al primo avvio senza bridge vivo.
