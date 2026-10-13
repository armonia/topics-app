# T3 · Avvio e bundle

Change `cloud-quality-pass`, traccia T3. Ramo di consegna: `cloud/t3-startup-bundle`.
Prima di partire leggi `openspec/changes/cloud-quality-pass/baseline.md` (T0): i numeri di
partenza sono lì. Se il file non c'è, il primo passo è rimisurare tu le righe che ti servono.

**GOAL.** L'app è utilizzabile prima: meno JavaScript eager nel primo caricamento, meno lavoro
prima del primo frame utile, server che risponde prima dopo il boot.

**FUORI.** Cambi di bundler o di framework, dipendenze nuove, il guscio Tauri, la landing
(`landing/`), il service worker se c'è un ramo aperto che lo tocca.

## Dove guardare

- `scripts/check-bundle-size.ts` e la sua baseline: cosa conta come chunk eager.
- Import statici di moduli pesanti che servono solo dopo un gesto (editor, terminale, diff,
  grafici, markdown pesante): candidati a `import()` dinamico. Attento a
  `check:deadcode-blindspots`: un `(await import(...)).x` può accecare knip, e il cancello lo
  segnala.
- Il boot del server (`server.ts`): query `.all()` grandi nei primi secondi, lavoro sincrono
  prima di `listen`. Il picco di memoria del boot si misura solo su macOS (`probe:boot-memory`):
  qui misura il tempo dall'avvio alla prima risposta `200` su `/`, con il server avviato come lo
  avvia l'e2e (`scripts/start-test-server.sh`, porta 13334, dati in una cartella temporanea):
  `date +%s%N` prima e dopo, cinque avvii, mediana.

## Misure (prima e dopo, stessa VM, due corse)

| Numero | Comando | Target |
|---|---|---|
| chunk eager, KB gzip | `bun run build:client && bun run check:bundle` | −20% |
| tempo al primo frame utile della home | spec Playwright con `performance.now()` al primo contenuto | −20% |
| server: avvio → prima risposta 200 | misura sopra, mediana di 5 | −20% |

Quando la riduzione del chunk eager è vera, abbassa `scripts/bundle-baseline.json` nello stesso
commit e scrivi il numero vecchio e quello nuovo nel messaggio.

## Prova

- Il ratchet del bundle deve restare capace di dire no: dopo aver abbassato la baseline, un import
  statico rimesso a mano deve farlo uscire non-zero (poi `git checkout -- <file>`).
- Video prima/dopo del primo caricamento a cache vuota.
- Barra verde; e2e di area: `tests/e2e/reload-flash.spec.ts tests/e2e/topics-archive-boot.spec.ts`
  più le spec che toccano i moduli resi lazy (cercale con `grep -l` sul nome del componente).

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
- Identificatori e commenti in inglese (regola del repo dal 21/08) (`check:identifier-language`,
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
