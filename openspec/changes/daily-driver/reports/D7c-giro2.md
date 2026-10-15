# D7c · Giro 2: riconnessione dopo lo sleep

**Barra prima:** `bun run typecheck:e2e` exit 0; `bun run typecheck` exit 0. La spec fermava server e bridge per 60.000 ms; mancava la prova che il server riaprisse davvero una `/ws` dopo il risveglio.

**Barra dopo:** `bun run typecheck:e2e` exit 0; `bun run typecheck` exit 0; `git diff --check` exit 0. Server fermo 100.000 ms con frame `connected` su una nuova `/ws`; bridge fermo 60.000 ms. Le clip non sono state eseguite sul Mac.

## Fatto

- `tests/e2e/sleep-wake-recovery.spec.ts`: lo scenario server supera le soglie del battito (75 s client, 90 s server), aspetta il nuovo handshake `/ws` dopo SIGCONT e porta il timeout della spec a 300 s. Lo scenario bridge resta a 60 s.
- `openspec/specs/runtime-hygiene/spec.md` RUNTIME-20: separati gli scenari server 100 s e bridge 60 s.
- `bun run typecheck:e2e` — exit 0 prima e dopo le modifiche.
- `bun run typecheck` — exit 0 prima e dopo le modifiche; server: 0 errori, baseline 0.
- Punto critico dello scenario server: `streamCatchupFrames` nell'`open` WebSocket di `server.ts` (circa riga 4303), che invia al socket nuovo la storia dello stream. La clip precedente era verde sia normale (run `38662908333`) sia col mutante `loadHistory` rimosso (run `38662867825`); quel mutante non colpiva il punto esercitato. Il mutante su `streamCatchupFrames` resta da preparare e lanciare dal proprietario.
- Punto critico dello scenario bridge: `MESSAGE_TIMEOUT_MS` in `server/providers/claude-code.ts` (30 minuti di silenzio prima che il watchdog del turno rigetti). Su una copia, mutazione: `perl -0pi -e 's/const MESSAGE_TIMEOUT_MS = 30 \* 60 \* 1000;/const MESSAGE_TIMEOUT_MS = 60_000;/' server/providers/claude-code.ts`. Il watchdog del socket bridge ricicla inoltre la connessione dopo 45 s senza byte o pong (`PONG_TIMEOUT_MS`), poi il client si riaggancia.

## Trovato e non fatto

- Esecuzione delle clip normali e mutate, esclusa dal Mac nello scope. La barra locale richiesta è verde; la prova e2e con video resta al workflow «Clip di consegna».
- Mutazione del punto critico server non eseguita: lo scope la riserva al proprietario.

## Rifiutato

- I 60 s del primo scenario non provavano una riconnessione del server: sono sotto entrambe le soglie, 75 s del client e 90 s del server. Il difetto era nella prova, non nelle soglie di produzione.
