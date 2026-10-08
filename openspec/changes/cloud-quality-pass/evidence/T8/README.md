# T8 · evidenza (video e trace)

Ramo dei fix: `cloud/t8-task-drag`. Questo ramo porta solo i file di prova, sopra la base
`17a60e4` (`cloud/quality-pass-integrata`).

Stessa VM, stesso checkout di test, cambia solo il bundle (`TOPICS_E2E_BUNDLE_DIR`):
`before/` = client di `17a60e4`, `after/` = client della punta di `cloud/t8-task-drag`.

- `task-flow-64-card.webm` / `.trace.zip`: `tests/e2e/board-task-flow.spec.ts`, board con 64 card,
  tre schede aperte, drag Todo -> Backlog verificato sul server. `task-flow-mid-drag.png`: un frame a
  metà drag (anteprima con colonna di partenza e badge, card sorgente attenuata): uguale nei due lati.
- `drag-bench.webm` / `.trace.zip`: `tests/e2e/board-drag-frames.spec.ts` (150 done + 8 todo, 33 card
  disegnate, 4 drag todo -> In Progress -> Backlog, una mossa per frame).
- `before/chrome-trace-one-pass.json.gz`: trace Chrome (devtools.timeline) di una passata da 60 mosse
  col client di partenza: 27.583 `ForcedStyleAndLayout`, 63 `PaintArtifactCompositor::Update`.
- `chrome-trace-one-pass-after-collision-fix.json.gz`: la stessa passata dopo i fix 2-4 (prima del
  `relative` sulla card): 2.677 `ForcedStyleAndLayout`.

Rigenerarli:

```bash
export PATH=/opt/node20/bin:$PATH SERVER_HOST=127.0.0.1
TOPICS_E2E_BUNDLE_DIR=<bundle> E2E_EVIDENCE=1 E2E_VIDEO=1 \
  npx playwright test tests/e2e/board-task-flow.spec.ts tests/e2e/board-drag-frames.spec.ts \
  --project=chromium --output=<cartella>
```
