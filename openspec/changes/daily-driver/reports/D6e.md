# D6e — esito

## Barra prima

`git status --short` → 0 file modificati. Test baseline non eseguiti prima delle modifiche.

## Barra dopo

- `./scripts/qa-gate.sh --veloce` → exit 0: 21 cancelli statici, `check:deadcode-blindspots`, typecheck e lint tutti verdi.
- Test mirati finali (`grants`, `principals`, `identity`, socket, `recipients` e setaccio) → 64 pass, 0 fail.
- `server/guest-media-sizes.test.ts` + `server/security-boundaries.test.ts` → 12 pass, 0 fail.
- Test WS isolato in `project-broadcast-visibility` → 1 pass, 0 fail. Il file intero → 6 pass, 2 fail: i due `iconChange` non ricevono l'evento entro 20 s.
- `bun test server/lib/` → 3010 pass, 2 skip, 3 fail, exit 1. Dettagli sotto.

## Fatto

- **5.2** `isGuestSocketData` legge `principal.confined`; il dato WS non contiene più `deviceRole`. I casi provano che `deviceRole=owner` non prevale su un principale confinato e viceversa. Prova: `bun test server/lib/grants.test.ts` → exit 0.
- **5.3** Ogni socket conserva principali e revisione. Al cambio di `principals_rev`, il filtro li risolve di nuovo prima di decidere sul frame; il test revoca la proprietà a una socket aperta e il frame privato viene respinto senza riconnessione. Prova: `bun test server/lib/socket-principals.test.ts` → exit 0.
- **5.4** L'identità HTTP e la rubrica dispositivi derivano il confinamento dai principali. Query esplicite escludono `role`; le scritture legacy restano compatibili. Il setaccio copre le sorgenti runtime sotto `server/` e `server.ts`, riconosce `SELECT role`, `SELECT d.role` e `SELECT *`. Prova: `bun test tests/unit/no-device-role-read.test.ts` → exit 0.
- **Mutazioni in copia scratch:** ripristinare la decisione su `deviceRole` → 2 test rossi; saltare la ri-risoluzione → 1 test rosso; iniettare `SELECT role FROM devices` → setaccio rosso. Tutti e tre i comandi mutanti sono usciti 1; la copia è stata rimossa.
- 5.2–5.4 spuntati in `sharing-orgs/tasks.md`; `git diff --check` → exit 0.

## Trovato e non fatto

- `bun test server/lib/` ha tre rossi non legati alla traccia: `trash.test.ts` riceve `moveToTrash(...).ok === false`; `dev-bundle-reload.test.ts` riceve 0 eventi invece di 1; `claude-transcript-path.test.ts` fallisce con `EPERM` creando una directory sintetica sotto `~/.claude/projects`. Per renderli verdi serve un ambiente con Trash, watcher e scrittura home funzionanti.
- Il file completo `tests/integration/project-broadcast-visibility.test.ts` ha due rossi in `iconChange` (`gotIt=false` dopo 20 s); il caso WS pertinente passa isolato. Per i due test serve il watcher filesystem operativo.

## Rifiutato

- Rimuovere `devices.role` o `task_shares` non è 5.4: è il passo 8.1, fuori scope, e `role` serve ancora al rollback. Nessuna migration modificata.
