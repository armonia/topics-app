# Dead-code sweep — report (Fase 1)

> Obiettivo: file mai importati, export mai usati, dipendenze npm non referenziate — **senza rompere nulla**.
> Complementare a env-audit (env var). Report PRIMA, rimozione DOPO e solo del verificato-sicuro.
> Generato con `knip` (config: [`knip.json`](../knip.json)). Ogni voce verificata a mano con grep di import statici **e** dinamici.

## Come rigenerare

```bash
bun install && (cd client && bun install)   # deps servono al grafo di knip
npx knip@5 --no-progress                     # 3 liste: file / export / deps
```

`knip.json` note di config (per non ri-inciampare):
- Plugin **bun** e **playwright** disattivati (`"bun": false`, `"playwright": false`): il parser degli script `bun test <file>` di knip fa `scandir` su un file → `ENOTDIR` (il crash citato nel task). Disattivarli evita il crash senza perdere copertura (entry dichiarati a mano).
- Sidecar `.mjs` spawnati per path (`server/ai-bridge.mjs`, `server/pty-bridge.mjs`) marcati **entry** (`!`) → non falsi-morti.
- `cli/topics.ts`, `scripts/*.ts` marcati entry (compilati / `bun run`).
- Escluse dall'analisi (fuori scope task): `openspec/`, `landing/`, `desktop-tauri/`, `public/`, `videos/`, `performance/`, `tests/e2e/`.
- knip copre già i tre assi di ts-prune (export) + depcheck (deps); non servono tool aggiuntivi.

Legenda colonna **Sicuro?**: **sì** = zero riferimenti (statici+dinamici+test+path), rimovibile · **verifica** = probabile WIP / dev-tool, decisione umana · **no** = finto-morto (entry esterno, ambient, intenzionale).

---

## 1. File non importati (12)

| File | Sicuro? | Motivazione |
|------|:------:|-------------|
| `server/converters.ts` | **sì** | `rowToTask`/`rowToComment`/`safeParseJSON` reimplementati **localmente** in `server/services/tasks.ts`; zero import (statici o dinamici) in server/client/test. Superato. |
| `client/src/components/Chat/toolIcon.ts` | **sì** | Duplicato superato da `toolIcons.ts` (plurale, `iconForDetail` è quello usato da `ToolCallRow.tsx`). L'unico riferimento residuo è l'allowlist in `scripts/check-any.ts` (va rimossa la riga insieme al file). Zero import. |
| `client/src/lib/shell/perf.ts` | **verifica** | Codice feature coerente (`getPerfMetrics` per footprint nativo Tauri, PORTING-PLAN §5b) ma zero importatori: la status-bar usa `fpsMonitor.ts`. Probabile WIP porting — non un residuo evidente. |
| `client/src/components/Modals/VoiceTaskDialog.tsx` | **verifica** | Isola voice: dialog+statusbar+store si referenziano solo tra loro, mai montati nell'albero App. WIP feature voice (progetto topics-voice). |
| `client/src/components/Shared/VoiceTaskStatusBar.tsx` | **verifica** | Stessa isola voice. |
| `client/src/state/voiceTaskDialog.ts` | **verifica** | Store zustand dell'isola voice; usato solo dai due componenti sopra (anch'essi morti). |
| `server/db/seed.ts` | **verifica** | Dev-tool a esecuzione manuale (`Usage: bun run server/db/seed.ts`); non wired in script/CI ma utilità di seeding intenzionale. |
| `server/middleware/agent-auth.ts` | **verifica** | Auth token agenti (PBKDF2) — `terminal.ts` usa un `agentAuthOk` inline, non questo modulo. Parte del change openspec `kanban-agent-authoring` (in corso) + security-sensitive → decisione umana, non toccare in auto. |
| ~~`scripts/hooks/claude-stop.ts`~~ | — | **CANCELLATO** (9e5516d1, 2026-07-30). Era classificato "entry esterno, non morto" sulla fiducia: l'installer degli hook non l'ha mai registrato (registra `post-hook.sh`, che POSTa su `/api/claude-hooks/:event`), e `~/.claude/settings.json` non lo nomina — verificato. La pipeline verso `claude-events-watcher.ts` non è mai esistita. |
| ~~`scripts/hooks/claude-pretooluse.ts`~~ | — | **CANCELLATO** (9e5516d1, 2026-07-30). Stessa storia: nessuna config Claude lo invoca. |
| `client/src/hooks/usePushNotifications.ts` | **no** | **Intenzionale**: `GlobalSettings.tsx:904` documenta "infrastructure (usePushNotifications, /api/push/*) is left in place". Tenere. |
| `server/db/sql-modules.d.ts` | **no** | **Ambient .d.ts**: dichiara `import x from "./foo.sql"` usato da `migrations-embedded.ts`. knip falsa-positivo sui .d.ts. Tenere. |

## 2. Export non usati (138 valori + 231 tipi)

**Nessuno rimosso in Fase 2** — categoria ad alto tasso di falsi positivi, richiede review manuale mirata (fuori dal batch conservativo). Pattern ricorrenti che spiegano perché **non** sono morti:

- **Helper test-only** (`__resetXForTests`, `__getPendingAcks`, `__flushAll…`): usati solo dai test ma su moduli di prodotto → **tenere** (regola esplicita del task).
- **API pubblica / dispatch dinamico**: `ToolCards.tsx` (ShellCard/ReadCard/…), `browser-tool-spec.ts` (`toolNameToEndpoint`) — superficie usata per nome/registry, non per import diretto.
- **Costanti di design** (`DROP_*`, `Z_*`, `*_SURFACE`): barrel di stile, spesso ri-esportate.
- Alcuni **realmente potabili** (es. `LazySpinner`, `GridLoader`, `UtilityPanel` se il pannello è stato rimosso) ma vanno confermati uno per uno.

→ Elenco completo in `npx knip@5` sezioni *Unused exports* / *Unused exported types*. Consiglio: bonifica separata, export per export, non in questo sweep.

## 3. Dipendenze (2)

| Dep | Tipo | Sicuro? | Motivazione |
|-----|------|:------:|-------------|
| `postcss` (client devDep) | inutilizzata | **verifica** | Nessun `postcss.config.*` nel repo e Tailwind v4 gira via `@tailwindcss/vite`. Probabile rimovibile, ma verificare che nessun tool della pipeline vite la richieda a runtime prima di togliere. |
| `unified` (client) | **non listata** (usata in `ChatMarkdown.tsx`) | **no (aggiungere)** | Import reale non dichiarato in `package.json` (arriva transitivamente da react-markdown/remark). È un problema **opposto** al dead-code: andrebbe *aggiunta* alle deps, non rimossa. Fuori scope rimozione. |

Le dipendenze root (`@anthropic-ai/sdk`, `node-pty`, `playwright-core`, `web-push`, `zod`) risultano tutte referenziate.

---

## Fase 2 — piano rimozione conservativa

Rimuovo **solo** i due `sì`, in un unico batch piccolo, con `bun test:unit` + `tsc` verdi:

1. `server/converters.ts` (trash)
2. `client/src/components/Chat/toolIcon.ts` (trash) + rimozione della sua riga in `scripts/check-any.ts`

Tutto il resto (`verifica`/`no`) resta in piedi: WIP (voice, perf, agent-auth), dev-tool (seed), entry esterni (hook), ambient (.d.ts), intenzionale (push), export ambigui, deps da verificare/aggiungere.

### Esito Fase 2 (eseguita)

- **Rimossi** (trash): `server/converters.ts`, `client/src/components/Chat/toolIcon.ts` + relativa riga in `scripts/check-any.ts`.
- **Verifica**: `bun run test:unit` e `tsc` (server + client) **prima e dopo**, risultato identico → nessuna regressione.
  - `test:unit`: **2319 pass / 3 fail** invariato. I 3 fail sono **pre-esistenti** (`board settings route`, `task-dispatcher · concurrency cap`, `priority queue`) — flakes noti da bleed DB tra test, **non** causati da questo sweep (falliscono identici sul baseline).
  - `typecheck-server`: **0 errori (baseline 0)**. `client tsc -b`: **0 errori**.
- Batch volutamente minimo: solo i 2 file a rischio zero. Le voci `verifica`/`no` sono lasciate per decisione umana.
