# T4 · Codice morto e duplicati

Change `cloud-quality-pass`, traccia T4. Ramo di consegna: `cloud/t4-dead-code`.
Prima di partire leggi `openspec/changes/cloud-quality-pass/baseline.md` (T0): i conteggi di
knip di partenza sono lì. Se il file non c'è, il primo passo è `bun run check:deadcode`.

**GOAL.** Meno codice da leggere e da mantenere, a comportamento identico: via file, export e
dipendenze che nessuno usa, e la logica duplicata che costringe a correggere due volte.

**FUORI.** I file dell'elenco qui sotto (li stanno cambiando rami non ancora su main), il codice
raggiunto solo da `desktop-tauri/` o da script lanciati a mano (cercali prima di dire «morto»),
le API che il client mobile o la CLI (`cli/`) chiamano, `openspec/`.

## Metodo

1. `bun run check:deadcode` e `bun run check:deadcode-blindspots`: parti dai conteggi.
2. Un candidato è morto solo se knip lo dice **e** `grep -rn` sul nome (anche come stringa: rotte,
   chiavi di registro, `import()` dinamici, nomi in `package.json`, test) non trova un uso vero.
3. Si toglie per area, un commit per area (`chore(deadcode): ...`), con il conteggio prima e dopo
   nel messaggio. Dopo ogni area: `bun run typecheck`, `bun run lint`, `bun run test:unit:shards`.
4. Dipendenze inutilizzate: via da `package.json` (root o `client/`) e `bun install` per
   riallineare `bun.lock`; poi `bun install --frozen-lockfile` deve uscire 0.
5. Duplicati: solo quelli dove una copia è già divergente o lo diventerà (stesso calcolo in due
   posti, due versioni dello stesso helper). Si unifica dove vive la versione più usata.

## Misure

| Numero | Comando | Target |
|---|---|---|
| file / export / tipi / dipendenze inutilizzati | `bun run check:deadcode` | −50% sui file e sugli export |
| righe di codice in `client/src`, `server`, `shared` | `git ls-files <dir> \| xargs wc -l` | giù, mai su |
| cancello cieco | `bun run check:deadcode-blindspots` | resta verde |

## Prova

- Barra verde dopo ogni area, e2e del PR tier intero (`E2E_TIER=pr npx playwright test
  --project=chromium`, in background) alla fine: stesso numero di passati di T0.
- Il cancello deve ancora mordere: un export nuovo mai usato, aggiunto in una copia, deve far
  uscire `check:deadcode` non-zero (poi `git checkout -- <file>`).

## File da non toccare (rami non ancora su main, 07/10/2026)

Rami: `gatesfix-238`, `topics/mobile-chrome-libera`, `topics/mobile-kanban`,
`topics/model-picker-compact`, `topics/model-picker-list`, `topics/notifiche-chiusura`,
`topics/omnibox-stile-arc`, `topics/server-da-bash-in-background`, `topics/subagent-nativi`.
Elenco calcolato con `git diff --name-only origin/main...<ramo>` sul Mac (molti rami sono solo
locali, quindi da qui non si ricalcola). Più tutto `openspec/`.

```text
client/src/App.tsx
client/src/components/Board/atoms.tsx
client/src/components/Board/BoardSkeleton.tsx
client/src/components/Board/Card.tsx
client/src/components/Board/CardLive.tsx
client/src/components/Board/columnClearance.test.ts
client/src/components/Board/columnClearance.ts
client/src/components/Board/constants.ts
client/src/components/Board/FilterTokenField.tsx
client/src/components/Board/KanbanBoardPane.tsx
client/src/components/Board/kanbanTopbar.test.ts
client/src/components/Chat/chatFileDrop.test.ts
client/src/components/Chat/chatFileDrop.ts
client/src/components/Chat/ChatPane.tsx
client/src/components/Layout/hooks/terminalReconcile.test.ts
client/src/components/Layout/hooks/terminalReconcile.ts
client/src/components/Layout/hooks/useProjectChatSync.test.tsx
client/src/components/Layout/hooks/useProjectChatSync.ts
client/src/components/Layout/hooks/useProjectLayout.ts
client/src/components/Layout/hooks/useProjectTerminalSync.ts
client/src/components/Layout/PanelGrid.tsx
client/src/components/Layout/ProjectWindow.tsx
client/src/components/MessageContent.tsx
client/src/components/Project/ProcessLogPane.tsx
client/src/components/Shared/ModelSelector/ModelList.test.tsx
client/src/components/Shared/ModelSelector/ModelList.tsx
client/src/components/Shared/ModelSelector/ModelSelector.tsx
client/src/components/Shared/ModelSelector/TaskModelSelector.test.tsx
client/src/components/Sidebar/globalOrchestratorLifecycle.test.ts
client/src/components/Sidebar/TopicTree.tsx
client/src/demo/landing-boot.js
client/src/hooks/useChat.ts
client/src/hooks/useNotificationHistory.ts
client/src/hooks/useWebSocket.focus-behind.test.ts
client/src/hooks/useWebSocket.ts
client/src/lib/api.ts
client/src/lib/buildSidebarItems.test.ts
client/src/lib/buildSidebarItems.ts
client/src/lib/i18n-en.ts
client/src/lib/i18n-it.ts
client/src/lib/notify/history.ts
client/src/lib/notify/seenFrame.test.ts
client/src/lib/notify/seenFrame.ts
client/src/lib/stripAnsi.test.ts
client/src/lib/stripAnsi.ts
client/src/lib/subagentAccordion.test.ts
client/src/lib/subagentAccordion.ts
client/src/lib/subagentStopGuard.test.ts
client/src/lib/subagentStopGuard.ts
client/src/state/attention.test.ts
client/src/state/signals.ts
client/src/state/unread.test.ts
client/src/state/unread.ts
client/src/types/index.ts
playwright.config.ts
scripts/bloat-baseline.json
server.ts
server/ai-bridge.mjs
server/ai-bridge.test.ts
server/attention/born-seen.test.ts
server/attention/compose.ts
server/attention/recompose.test.ts
server/attention/seen-door.test.ts
server/attention/server-tasks.test.ts
server/attention/store.test.ts
server/attention/store.ts
server/attention/system-notices.test.ts
server/attention/system-notices.ts
server/context/adapt-dedup.test.ts
server/context/adapt.ts
server/context/assemble.ts
server/db/migrations-embedded.ts
server/db/migrations/20261004180000-subagents-native-runtime.sql
server/db/migrations/20261005060000-subagents-runtime-reason-engaged.sql
server/db/migrations/20261005140000-subagent-reported-turns.sql
server/db/migrations/20261005200000-subagent-started-turns.sql
server/db/notification-log.test.ts
server/db/notification-log.ts
server/lib/abort-cause.ts
server/lib/agent-profiles.ts
server/lib/ai-bridge-client.ts
server/lib/grants.test.ts
server/lib/grants.ts
server/lib/native-parity.test.ts
server/lib/native-parity.ts
server/lib/native-subagents.test.ts
server/lib/native-subagents.ts
server/lib/process-exit-wake.test.ts
server/lib/process-exit-wake.ts
server/lib/ripresa-boot.ts
server/lib/subagent-migration.test.ts
server/lib/subagent-migration.ts
server/lib/subagent-runtime.ts
server/lib/subagent-store.test.ts
server/lib/subagent-store.ts
server/lib/subagent-tool-policy.ts
server/lib/subagent-watch.ts
server/lib/topics-agent-prompt.ts
server/lib/unread-count.test.ts
server/lib/unread-count.ts
server/lib/wake-adoption.test.ts
server/lib/wake-adoption.ts
server/lib/ws-compression.test.ts
server/lib/ws-send.test.ts
server/mcp/topics-mcp-server.ts
server/notification-registry.ts
server/providers/native/agent-loop.ts
server/providers/native/provider-language.test.ts
server/providers/native/provider.ts
server/providers/native/request-shape.test.ts
server/providers/stop-reason.ts
server/providers/turn-end-registry.ts
server/providers/types.ts
server/pty-bridge-orphan.test.ts
server/pty-bridge-platform.mjs
server/pty-bridge-platform.test.ts
server/pty-bridge.mjs
server/routes/attention.ts
server/routes/chat.ts
server/routes/edit.ts
server/routes/media.test.ts
server/routes/media.ts
server/routes/notifications.test.ts
server/routes/notifications.ts
server/routes/processes.ts
server/routes/providers.ts
server/routes/terminal.ts
server/routes/topics.ts
server/schemas/chat-ws-inbound.ts
server/services/archive-topic.attention.test.ts
server/services/archive-topic.test.ts
server/services/archive-topic.ts
server/services/goal-continuation.ts
server/services/subagent-wake.ts
server/services/tasks.parked-requeue.test.ts
server/services/tasks.ts
server/subject-seen.test.ts
server/subject-seen.ts
server/types.ts
server/utils-unread-rows.test.ts
server/utils.ts
shared/attention.ts
shared/types.ts
shared/ws-outbound.ts
tests/e2e/attention-project-mark-read.spec.ts
tests/e2e/board-mobile-phone.spec.ts
tests/e2e/chat-bash-server.spec.ts
tests/e2e/effort-single-surface.spec.ts
tests/e2e/helpers.ts
tests/e2e/helpers/attention.ts
tests/e2e/helpers/fake-claude-bash-server.ts
tests/e2e/helpers/model-selector.ts
tests/e2e/model-panels-providers.spec.ts
tests/e2e/model-selector-revision.spec.ts
tests/e2e/model-selector.spec.ts
tests/e2e/muse-provider-picker.spec.ts
tests/e2e/mute-and-badge.spec.ts
tests/e2e/notification-history.spec.ts
tests/e2e/subagent-strip-survives.spec.ts
tests/e2e/tab-system-reliability.spec.ts
tests/e2e/topic-management-org.spec.ts
tests/e2e/usability-audit.spec.ts
tests/integration/background-shell-service.test.ts
tests/integration/goal-continuation.test.ts
tests/integration/process-run-command.test.ts
tests/integration/subagent-native-engine.test.ts
tests/integration/subagent-native-lifecycle.test.ts
tests/integration/subagent-native-review6.test.ts
tests/integration/subagent-native-review7.test.ts
tests/integration/subagent-native-tree.test.ts
tests/integration/subagent-native-turns.test.ts
tests/integration/subagent-native.test.ts
tests/integration/topic-read-seen-propagation.test.ts
tests/unit/ws-inbound-client-schema.test.ts
tests/unit/ws-outbound-schema.test.ts
```

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
