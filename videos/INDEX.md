# Topics — Video UAT Index

Generato da Playwright (config `video: "on"`) + `bun run uat`.

## Video disponibili

### master-topic
- `master-01-m-c664f-deo-proof-of-uat-toolchain.webm` — **MASTER-01 · POST /api/topics/master smoke test**: prova che il pipeline UAT funziona end-to-end (server live + browser + API + UAT html generato).

## Test E2E con video (al run completo)

I 22 scenari rimanenti per `add-master-topic-mode` sono scaffolded come `test.fixme`:
- `tests/e2e/master-topic.spec.ts` (12 scenari fixme + 2 attivi)
- `tests/e2e/notifications-non-invasive.spec.ts` (9 fixme)

Per flipparli a `test` + generare video servono:
- Phase D UI (jump-to-tab pane focus) — endpoint server pronto, manca rendering badge sulla task card
- Phase E UI (reasoning trail timeline)
- Phase F UI (tray badge + Focus mode + click-route)

## Rigenerazione

```bash
# Test suite completa (richiede dev server up — global-setup di Playwright lo gestisce)
npx playwright test --reporter=list

# Organizza video da artifacts → videos/
bash scripts/organize-test-videos.sh
cp -r test-results/videos/* videos/

# Genera uat.html con video embedded
bun run uat
```

## Riferimenti

- Spec: `openspec/changes/add-master-topic-mode/specs/master-topic/spec.md`
- Progress: `openspec/changes/add-master-topic-mode/PROGRESS.md`
