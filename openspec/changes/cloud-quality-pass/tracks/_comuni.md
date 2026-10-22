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
   **Bun di produzione: 1.3.8.** Il server in produzione gira sulla 1.3.8 (il Mac), gli installer
   desktop sono compilati con la latest: il codice server deve essere giusto su tutte e due.
   Una 1.3.8 accanto alla tua, solo per i test (con la 1.3.8 `bun install` non passa dal proxy):
   `npm i --prefix /tmp/bun138 bun@1.3.8` → `/tmp/bun138/node_modules/.bin/bun test <file>`.
   Un test server verde sulla latest e rosso sulla 1.3.8 è un difetto in produzione (T10, 08/10:
   21 rossi su 185 in `server/services/tasks.test.ts`, solo sulla 1.3.8).
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
5. WebKit, anche se giri solo `--project=chromium`: `npx playwright install --with-deps webkit`
   (come la CI, `ci.yml` job e2e: `install --with-deps chromium webkit`). Il server fotografa
   l'anteprima delle card con Playwright **WebKit** (`server/services/preview-browser.ts`), e
   senza il motore `board-recapture-preview` RECAPTURE-01 è rosso 3 tentativi su 3 («Executable
   doesn't exist at …/webkit-2272/pw_run.sh» nel log del test-server, poi l'anteprima non
   compare in 90 s). Misurato in T15 (08/10): senza WebKit 1/1 rosso, con WebKit 6/6 verdi
   (RECAPTURE-01 e -02, `--repeat-each=3 --retries=0`); `cdn.playwright.dev` dalla VM rispondeva
   (34 s). WebKit esiste solo su `cdn.playwright.dev`: se non scende, RECAPTURE-01 e il progetto
   `webkit` non girano e lo scrivi.

Un blocco di setup che non risolvi in 20 minuti va nel REPORT come blocco, con l'errore esatto, e
lavori su ciò che gira.

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
  lavoro, oppure se ricevi «chiudi»: in quel caso finisci il fix in corso, barra, REPORT, consegna.

### Consegna esatta

Prima prova il push: `git push origin HEAD:refs/heads/cloud/<ramo della traccia>`. Se esce 0 hai
consegnato (ultimo messaggio: ramo e sha). Se fallisce (snapshot senza remote, proxy 403), il
bundle qui sotto: una patch ricopiata nel testo arriva corrotta. Video e trace restano nella VM: nel REPORT scrivi dove sono e
cosa mostrano. Per il bundle fai SOLO questo, senza commenti fra un comando e l'altro:
1. `git bundle create /tmp/consegna.bundle $BASE..HEAD` (BASE = il commit da cui sei partita,
   i commit del REPORT inclusi).
2. `base64 -w0 /tmp/consegna.bundle | fold -w 20000 > /tmp/consegna.b64 && wc -l /tmp/consegna.b64 && sha256sum /tmp/consegna.bundle`
3. Stampa le righe UNA per chiamata Bash, in ordine: `sed -n '1p' /tmp/consegna.b64`, poi
   `sed -n '2p' /tmp/consegna.b64`, e così via fino all'ultima.
4. Ultimo messaggio: una riga «BUNDLE <righe> <sha256>» e il nome del ramo. Niente patch nel testo.

### Modelli: Opus pensa, Haiku esegue

- Tu (Opus 5.5) fai lo studio del codice, la progettazione, le diagnosi difficili, il codice dei
  fix e la revisione di ogni diff.
- Il lavoro meccanico e verificabile va a sottoagenti (strumento Agent) con `model: "haiku"`
  (Haiku 5.5), lanciati in parallelo quando sono indipendenti: girare una suite e riportare solo i
  rossi con l'errore, ripetere una misura N volte e dare mediana e p95, elencare i call site di un
  simbolo, applicare a più file una modifica che hai già deciso e scritto tu, tradurre commenti.
- Mai a Haiku: diagnosi, scelte di design, il codice di un fix, il giudizio su un risultato. Ogni suo
  output lo controlli tu (diff letto, numero ricontrollato) prima di usarlo.
- Costo: con Haiku 4.5 la CLI rifiutava l'effort e mandava 32 mila token di ragionamento anche per
  un `ls`. Al primo sottoagente Haiku guarda quanti token ha usato: se costa più di un Sonnet con
  effort `low` per lo stesso lavoro, passa a `model: "sonnet"` con effort `low`. Scrivi nel REPORT
  cosa hai delegato e a chi.
