# D7c · Giro 2: riconnessione dopo lo sleep

**Barra prima:** `bun run typecheck:e2e` exit 0; `bun run typecheck` exit 0. La spec fermava server e bridge per 60.000 ms; mancava la prova che il server riaprisse davvero una `/ws` dopo il risveglio.

**Barra dopo:** `bun run typecheck:e2e` exit 0; `bun run typecheck` exit 0; `git diff --check` exit 0. Server fermo 100.000 ms con frame `connected` su una nuova `/ws`; bridge fermo 60.000 ms. Clip normale verde in CI (run `38665042840`).

## Fatto

- `tests/e2e/sleep-wake-recovery.spec.ts`: lo scenario server supera le soglie del battito (75 s client, 90 s server), aspetta il nuovo handshake `/ws` dopo SIGCONT e porta il timeout della spec a 300 s. Lo scenario bridge resta a 60 s.
- `openspec/specs/runtime-hygiene/spec.md` RUNTIME-20: separati gli scenari server 100 s e bridge 60 s.
- `bun run typecheck:e2e` — exit 0 prima e dopo le modifiche.
- `bun run typecheck` — exit 0 prima e dopo le modifiche; server: 0 errori, baseline 0.
- Punto critico dello scenario server: `streamCatchupFrames` nell'`open` WebSocket di `server.ts` (circa riga 4303), che invia al socket nuovo la storia dello stream. La clip precedente era verde sia normale (run `38662908333`) sia col mutante `loadHistory` rimosso (run `38662867825`); quel mutante non colpiva il punto esercitato. Gli esiti dei mutanti sono sotto, in «Prove in CI».
- Punto critico dello scenario bridge: `MESSAGE_TIMEOUT_MS` in `server/providers/claude-code.ts` (30 minuti di silenzio prima che il watchdog del turno rigetti). Su una copia, mutazione: `perl -0pi -e 's/const MESSAGE_TIMEOUT_MS = 30 \* 60 \* 1000;/const MESSAGE_TIMEOUT_MS = 60_000;/' server/providers/claude-code.ts`. Il watchdog del socket bridge ricicla inoltre la connessione dopo 45 s senza byte o pong (`PONG_TIMEOUT_MS`), poi il client si riaggancia.

## Prove in CI (15/10)

- Clip normale verde: run `38665042840`.
- Mutante su `streamCatchupFrames` (tolto dall'`open` del WebSocket): **verde**, run `38665048194`. Il punto non è quello che la e2e protegge: la pagina non si ricarica, quindi il client tiene i pezzi arrivati prima dello stop, e quelli accumulati durante lo stop gli arrivano dal vivo sul socket nuovo. Il recupero serve a un client che arriva da zero, ed è coperto altrove (CCLI-04).
- Mutante sulla riconnessione del client (`connectRef.current()` diventa `void connectRef` in `client/src/hooks/useWebSocket.ts`): **rosso**, run `38666828730`, su «the app WebSocket completed a new handshake after the server resumed» (atteso più di 0, ricevuto 0). È questo il punto che la e2e morde.

## Rifiutato

- I 60 s del primo scenario non provavano una riconnessione del server: sono sotto entrambe le soglie, 75 s del client e 90 s del server. Il difetto era nella prova, non nelle soglie di produzione.
