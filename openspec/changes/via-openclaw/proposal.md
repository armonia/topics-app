# Via OpenClaw da Topics

## Perché
OpenClaw è spento dal 03/11/2026: i canali e i lavori programmati di Jarvis li fa
`jarvis-channels`, le chat il motore nativo di Topics (dal 16/08). In Topics ne
restavano 323 file e 1266 citazioni: un provider che non si avvia più (niente
`GATEWAY_URL`, niente `~/.openclaw/openclaw.json`), un `/model` che chiamava un
endpoint mai esistito, e il pannello Automazioni rotto perché chiama
`openclaw gateway call cron.list`, che `jarvis-channels` non ha. E il nome: il
servizio ora è nostro, la parola OpenClaw non deve comparire.

## Cosa cambia
- Via il provider `openclaw`, il client WebSocket del gateway, il token del
  gateway (`x-gateway-token`, `GATEWAY_URL`, `GATEWAY_TOKEN`), la rotta e gli hook
  del contesto OpenClaw, i blocchi «workspace OpenClaw» del contesto, i rami
  `/model` `/reasoning` `/new` che inoltravano al gateway.
- Automazioni: legge e lancia i job con la CLI di `jarvis-channels`
  (`cron list --json`, `cron run <id>`), chiamati «Jarvis» nell'interfaccia.
- La parola sparisce da codice, interfaccia, test, script e documenti.
  `OPENCLAW_DIR` diventa `APP_DATA_DIR` e basta.

## Barra
1. `bun run typecheck` esce 0.
2. `bun test` sui file toccati e la suite unit sul PC (`offload`) senza rossi nuovi
   rispetto a `origin/main`.
3. `tests/unit/no-openclaw-name.test.ts`: `git grep -i openclaw` restituisce solo i
   file dell'elenco chiuso qui sotto. Mutazione: rimettere la parola in un file
   qualunque fa fallire il test.
4. Dopo il riavvio: `GET /api/cron/jobs` sulla :3333 risponde con i job di
   `jarvis-channels` (stesso numero di `jarvis-channels cron list --json`), e lo
   screenshot del pannello Automazioni li mostra.

## Fuori
- Spostare i dati di Topics fuori da `~/.openclaw` (media, workspace): è una
  migrazione di dati con la sua change; quella cartella è condivisa con Jarvis.
  Resta l'unico riferimento, come percorso: la costante della vecchia radice in
  `shared/legacy-data-dir.ts` (server e client la leggono da lì).
- La storia: `CHANGELOG.md`, `openspec/changes/archive/`, `bench/results/`, le
  migrazioni SQL già applicate (`server/db/migrations/`): sono registri, non si
  riscrivono.
- `jarvis-channels` e i repo di Jarvis.

## Elenco chiuso delle eccezioni (barra 3)
`CHANGELOG.md` · `client/public/changelog.json` (generato dalla storia git) · `openspec/changes/archive/**` · `bench/results/**` ·
`server/db/migrations/**` · `shared/legacy-data-dir.ts` (la vecchia radice) ·
`tests/unit/no-openclaw-name.test.ts` · questa change.

## Non ancora specificato
Nulla.
