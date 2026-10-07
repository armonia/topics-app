# T5 · Server: il percorso caldo

Change `cloud-quality-pass`, traccia T5. Ramo di consegna: `cloud/t5-server`.
Prima di partire leggi `openspec/changes/cloud-quality-pass/baseline.md` (T0): le latenze di
partenza sono lì. Se il file non c'è, il primo passo è `bun run check:route-latency`.

**GOAL.** Le rotte che il client chiama di continuo rispondono prima, e nessuna richiesta può
restare appesa a un processo esterno o a un file system lento.

**FUORI.** Migration e indici nuovi (vedi «Recinto»: un indice che servirebbe va scritto in
«Trovato e non fatto» con la query, l'`EXPLAIN QUERY PLAN` e il guadagno misurato su una copia
sintetica), il protocollo WebSocket, il dispatcher della board, il bridge dei terminali.

## Dove guardare

- `scripts/check-route-latency.ts`: quali rotte misura e come. Partono da lì.
- Chiamate a processi esterni senza timeout nel percorso di una richiesta (`execSync`,
  `spawnSync`, `Bun.spawn` senza `timeout`/kill, `ps`, `git`, `lsof`): il 21/09 un `ps` senza
  timeout in `fleet-usage.ts` ha fermato tutto il server per minuti. Cercali con
  `grep -rn -E "execSync|spawnSync|Bun\.spawn|child_process" server --include=*.ts`.
- `readFileSync` / `statSync` dentro un loop o in una rotta calda.
- N+1 su SQLite: una query per riga dentro un `for`, `.all()` su tabelle che crescono senza
  `LIMIT`. `EXPLAIN QUERY PLAN` sulle query delle rotte misurate.
- Cache già presenti che vengono invalidate troppo spesso.

## Misure (prima e dopo, stessa VM, due corse)

| Numero | Comando | Target |
|---|---|---|
| p50 / p95 delle rotte calde | `bun run check:route-latency` | p95 −30% su almeno due rotte |
| chiamate esterne senza timeout nel percorso di una richiesta | `grep` sopra, contate a mano | 0 |
| query per richiesta sulle rotte misurate | contatore temporaneo in un test, poi tolto | giù, con il numero |

`check:route-latency` esce 2 quando la VM è troppo rumorosa per misurare: rilancia a macchina
ferma (`uptime` sotto 1) prima di concludere qualcosa.

## Prova

- Ogni fix con un test che riproduce il caso lento o appeso (un processo finto che non risponde,
  un file system lento simulato) e va rosso senza il fix.
- Barra verde; e2e di area: le spec che chiamano le rotte toccate (`grep -l` sul path della
  rotta in `tests/e2e`), più `tests/integration` intero (è dentro `test:unit:shards`).

## Regole comuni (uguali in ogni traccia)

Nessuno risponde alle tue domande: decidi, scrivi il perché nel commit o nel REPORT, vai avanti.
Il `CLAUDE.md` del repo è in `.gitignore` e qui non c'è: valgono queste regole.

**Il progetto.** topics-app: server Bun (`server.ts`, in produzione su :3333 TLS), client React +
Vite + Tailwind v4 (`client/`, build in `public/`), guscio Tauri (`desktop-tauri/`, qui non gira),
SQLite, WebSocket. La CI vera è `.github/workflows/ci.yml` (job `unit`, `gates`, `e2e`, `tauri`).

**La VM.** Ubuntu 24.04 x86_64, 4 vCPU, 16 GB, rete «Trusted»: registri npm, GitHub,
`*.googleapis.com` sì; `cdn.playwright.dev` probabilmente no. Comandi oltre 10 minuti: in
background e leggi il log; mai un `sleep` in primo piano.

### Setup (una volta, all'inizio; annota quanto dura)

1. Node come in CI: `export PATH=/opt/node20/bin:$PATH`.
2. Bun: `bun --version`. Sotto la 1.4.0 il proxy della VM risponde 401 a `bun install`
   (credenziali del proxy codificate male, oven-sh/bun#31782): `npm i -g bun@latest`, poi
   `hash -r; bun --version`. Le release GitHub di Bun dal proxy danno 403: solo npm.
3. Dipendenze, gli stessi passi della CI:
   ```bash
   bun install --frozen-lockfile --ignore-scripts
   npm rebuild node-pty
   bun run scripts/fix-node-pty-exec-bit.ts
   (cd client && bun install --frozen-lockfile)
   git fetch --no-tags --depth=1 origin +main:refs/remotes/origin/main
   ```
4. Chromium: `npx playwright install --with-deps chromium`. Se il download fallisce, Chrome for
   Testing dalla fonte Google, che la rete ammette:
   ```bash
   B=./node_modules/playwright-core/browsers.json
   V=$(node -p "require('$B').browsers.find(b=>b.name==='chromium').browserVersion")
   R=$(node -p "require('$B').browsers.find(b=>b.name==='chromium').revision")
   U=https://storage.googleapis.com/chrome-for-testing-public/$V/linux64
   P=~/.cache/ms-playwright; mkdir -p $P/chromium-$R $P/chromium_headless_shell-$R
   curl -fsSLo /tmp/c.zip $U/chrome-linux64.zip && unzip -qo /tmp/c.zip -d $P/chromium-$R
   curl -fsSLo /tmp/h.zip $U/chrome-headless-shell-linux64.zip && unzip -qo /tmp/h.zip -d $P/chromium_headless_shell-$R
   touch $P/chromium-$R/INSTALLATION_COMPLETE $P/chromium_headless_shell-$R/INSTALLATION_COMPLETE
   npx playwright install-deps chromium
   ```
   WebKit esiste solo su `cdn.playwright.dev`: se non scende, il progetto `webkit` non gira e lo
   scrivi. Un blocco di setup che non risolvi in 20 minuti va nel REPORT come blocco, con
   l'errore esatto, e lavori su ciò che gira.

### La barra (si scrive una volta, si esegue sempre uguale)

```bash
./scripts/qa-gate.sh --veloce                     # typecheck, lint, cancelli statici della CI
bun run test:unit:shards                          # unit + integration, 4 shard
bun run build:client && bun run check:bundle      # check:bundle vuole public/ fresco
E2E_TIER=pr npx playwright test --project=chromium <le spec della tua area>
```
- All'inizio la esegui e annoti lo stato: un rosso che c'era già non è tuo, ma lo scrivi.
- Dopo ogni fix: `bun run typecheck`, `bun run lint`, i test toccati e la misura della traccia.
  Ogni 3-5 fix e prima della consegna: la barra intera. Un rosso nuovo si risolve subito o il fix
  si annulla (`git revert`).
- I banchi `check:ink`, `check:drag`, `check:scroll-fluidity`, `check:growth`,
  `check:route-latency` escono 2 quando non possono misurare: 2 non è verde, è «non misurato».
- Un timeout sotto carico non è un rosso: `uptime`, poi rilancia il file da solo.

### Recinto

- Niente feature, niente cambi di stack, nessuna dipendenza nuova senza un perché scritto nel
  commit, niente rinomine o riformattazioni in blocco. Il comportamento visibile resta quello.
- Identificatori in inglese, commenti in italiano (`check:identifier-language`,
  `check:comment-language`). Niente lineetta lunga nei testi dell'interfaccia (`check:emdash`).
- E2E solo contro il server di test isolato che `tests/e2e/global-setup.ts` avvia su :13334;
  mai codice o test che puntino a :3333.
- Nessuna migration nuova in `server/db/migrations/`: sul Mac di produzione un file lì si applica
  al database vivo appena arriva. Se un fix la richiede, va in «Trovato e non fatto».
- Non toccare `.github/workflows/` né l'elenco dei cancelli (script `check:*`,
  `scripts/qa-gate.sh`, catena `STATIC_RAILS_CHECK`), salvo T6. `package.json` solo in T4
  (dipendenze inutilizzate) e T6.
- I file toccati dai rami non ancora su main sono elencati in `tracks/T4-dead-code.md`: evitali.
  Se un fix li richiede davvero, fallo e scrivilo nel REPORT sotto «Tocca rami aperti».

### Prova

- Ogni affermazione ha una prova: comando + exit code, o numero prima → dopo misurato due volte
  con lo stesso script nella stessa VM, con `uptime` accanto. «Più veloce» senza numero non vale.
- Un test che difende un fix deve saper fallire: rompi il punto critico, vedi il rosso, rimetti
  con `git checkout -- <file>`, controlla `git status` pulito prima del commit.
- Flussi Topic e Task: video Playwright (`E2E_EVIDENCE=1 E2E_VIDEO=1`) del prima e del dopo.

### Commit e consegna

- Un fix per commit, messaggio in italiano che dice il perché, nello stile del repo
  (`fix(area): ...`, `perf(area): ...`). Committa con `git commit <percorsi> -F -`. Niente
  trailer `Co-Authored-By` e niente righe «Generated with»; il trailer `Claude-Session` va bene.
- Consegna: `git push origin HEAD:refs/heads/cloud/<ramo della traccia>`. Se l'ambiente ti
  obbliga a un ramo `claude/...`, pusha anche lì e scrivi il nome nel REPORT.
- Il REPORT va in `openspec/changes/cloud-quality-pass/reports/T<n>.md`, in tre sezioni:
  **Fatto** (con la prova accanto), **Trovato e non fatto** (dove, perché, cosa servirebbe),
  **Rifiutato** (cosa sembrava un problema e non lo era). In testa: barra prima/dopo e i numeri.
- Video e trace su un ramo a parte, `cloud/<ramo della traccia>-evidenza`, mai sul ramo dei fix.
- Ti fermi quando la barra è verde e i numeri della traccia sono al target, oppure dopo 4 ore di
  lavoro, oppure se ricevi «chiudi»: in quel caso finisci il fix in corso, barra, REPORT, push.

## Dopo T0 (misurato nella VM il 07/10): parti da qui

- `check:route-latency` nella VM si astiene («il tubo è fuori scala»: la baseline è del Mac, la VM
  è ~3x più lenta). Per il prima/dopo usa un banco tuo contro il server di test isolato, stessa VM,
  due corse, `uptime` accanto. `export SERVER_HOST=127.0.0.1` sempre (la VM non ha IPv6).
- Due rossi di `test:unit:shards` che T0 non ha spiegato con l'ambiente: guardali per primi.
  1. `scripts/reload-gate-migration.test.ts` casi A e F: il cancello di ricarica esce 0 con una
     migration rotta (`:118`, `:229`). Quel cancello è ciò che impedisce al server di produzione di
     ripartire su una modifica rotta: se il difetto è vero, è il fix più prezioso della traccia.
  2. `server/routes/processes.shell-sweep.test.ts`: `isAlive(pid)` resta vero dopo lo sweep
     (`:63`). Decidi se è la VM (nessun init che raccoglie gli zombie) o un difetto vero.
