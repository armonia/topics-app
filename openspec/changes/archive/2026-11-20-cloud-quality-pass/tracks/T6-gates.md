# T6 · I 44 cancelli: restano quelli che mordono

Change `cloud-quality-pass`, traccia T6. Ramo di consegna: `cloud/t6-gates`.
Prima di partire leggi `openspec/changes/cloud-quality-pass/baseline.md` (T0): la durata della
barra di partenza è lì.

**GOAL.** Ogni script `check:*` del `package.json` ha dimostrato di saper dire no; quelli che non
ci riescono vengono riparati o tolti; la barra dura meno senza perdere un difetto che oggi ferma.

**FUORI.** Abbassare soglie o budget per far passare qualcosa, togliere un cancello solo perché è
lento, cambiare cosa la board legge come esito (`checks_json`, nomi dei passi della CI).

## I 44

`check:contrast check:field check:scroll-fluidity check:painted check:landing check:copy
check:demo check:any check:any-budget check:ref-callbacks check:nul check:api-door check:emdash
check:repo-pulito check:sidecars check:typography check:ui-language check:comment-language
check:identifier-language check:eslint-disable check:test-skips check:test-globals
check:module-mock-restore check:sleeps check:tmp-canonical check:e2e-no-verdict
check:e2e-touched check:bloat check:route-shadowing check:security check:spec-coverage
check:untraced-tests check:migrations check:deadcode check:deadcode-blindspots check:previews
check:route-latency check:occlusion check:bundle check:ink check:drag check:growth
check:lockfile check:history-clean`

30 sono nella CI (`grep -oE 'bun run check:[a-z0-9:-]+' .github/workflows/ci.yml | sort -u`),
gli altri no: quelli fuori dalla CI vanno classificati per primi (usato a mano / da un'altra
pipeline / orfano).

## Metodo, per ogni cancello

1. Esegui: exit code e durata.
2. Mordi: introduci in una copia il difetto che dichiara di fermare (un `any` in più, una
   lineetta lunga in una stringa UI, un `sleep` in una e2e, un identificatore italiano nuovo...)
   e rilancia: deve uscire non-zero. Poi `git checkout -- <file>` e `git status` pulito.
3. Classifica in una tabella del REPORT: **morde** · **non morde** (con la mutazione provata) ·
   **non misurabile qui** (motivo) · **duplicato di** (quale).
4. Un cancello che non morde si ripara (un test che lo dimostra rosso) o si toglie. Togliere
   significa, nello stesso commit: lo script in `package.json`, la riga in `ci.yml`, quella in
   `scripts/qa-gate.sh`, l'anello in `STATIC_RAILS_CHECK` (`server/services/review-checks.ts`),
   e `server/services/review-checks-rails.test.ts` verde (è il test che tiene allineate CI e
   board).
5. Velocità: passi indipendenti di `scripts/qa-gate.sh` in parallelo solo se non condividono
   file temporanei o porte (`check:tmp-canonical` esiste per questo); misura prima e dopo.

## Misure

| Numero | Comando | Target |
|---|---|---|
| cancelli che mordono / totale | tabella del REPORT | 44/44 classificati, 0 «non morde» rimasti |
| durata di `./scripts/qa-gate.sh --veloce` | `time`, mediana di 3 | −30% |
| durata della barra intera | come in T0 | −20% |

## Prova

- Per ogni cancello riparato: il commit contiene la mutazione come test, rosso prima.
- `review-checks-rails.test.ts` verde se tocchi `ci.yml` o `qa-gate.sh`.
- Barra verde; e2e del PR tier intero alla fine, stesso numero di passati di T0.

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

## Dopo T0 (misurato nella VM il 07/10): parti da qui

- `qa-gate.sh --veloce` = 292 s, e `typecheck` (121 s) più `lint` (134 s) sono l'87%: il tempo si
  guadagna lì (incrementale, cache, parallelo), non sui cancelli da un secondo.
- In un container come root e senza IPv6 la barra ha rossi che non sono difetti: `check:security`
  e `no-home-paths-tracked` (HOME=/root), `worktree-manager` e `file-tree` (root ignora chmod),
  `loopback-probe` e i test che spawnano server (IPv6). Un test che dipende dall'ambiente deve dirlo
  (skip motivato e visibile) o adattarsi, senza smettere di verificare ciò che verifica oggi.
