# Acceptance — generative-views

La barra si esegue sempre uguale. Ciò che è verde resta verde.

## 1. Comandi (exit 0 = passa)

```bash
bun test shared/views.test.ts server/routes/views.test.ts client/src/components/Chat/viewOpens.test.ts \
  server/routes/browser-bridge.test.ts server/lib/subagent-store.test.ts \
  server/mcp/topics-mcp-server.test.ts server/route-table.test.ts tests/unit/tool-call-detail-schema.test.ts
bunx playwright test tests/e2e/chat-generative-view.spec.ts tests/e2e/browser-child-in-parent-window.spec.ts \
  --project=webkit --retries=0
bun run typecheck:client && bun run typecheck:server && bun run typecheck:tests:client && bun run typecheck:e2e
bun run check:comment-language && bun run check:spec-coverage
```

## 2. Scenari spec-flow con video

`E2E_EVIDENCE=1 E2E_VIDEO=1` sulla riga Playwright sopra (aggiungere `--trace=off` su Node 26: il merge delle trace
si appende nel teardown). Prove prodotte:

| Requisito | Prova |
|---|---|
| GENUI-01 | `genui-chat.webm`, `genui-chat-desktop.png` |
| GENUI-04 | `genui-page-light.webm`, `genui-page-desktop-{light,dark}.png`, `genui-page-mobile-{light,dark}.png` |
| GENUI-05 | `child-browser-in-parent-window.webm` |

Misure nel test, non a occhio: geometria DOM (blocco dentro la bolla, card senza sovrapposizioni, stessa
larghezza, prima metrica allineata, niente pan orizzontale, link ≥36 px) e axe-core su blocco e pagina.

## 3. Mutazioni sul punto critico (devono andare rosse)

Sempre su una copia (`$SCRATCH/mut/repo`, bundle in `$SCRATCH/mut/public`, test con
`TOPICS_E2E_BUNDLE_DIR=$SCRATCH/mut/public`), mai sul file vero.

| Mutazione | Dove | Rosso atteso (visto 08/10) |
|---|---|---|
| `viewOf` restituisce `null` | `client/src/components/Chat/viewOpens.ts` | chat-generative-view: fold `data-actions` atteso "3", ricevuto "4" |
| `navTopicId = msg.topicId` (ignora `hostTopicId`) | `client/src/components/Layout/hooks/usePaneOrdering.ts` | browser-child-in-parent-window: scheda del figlio attesa 1, ricevuta 0 |
| broadcast senza `hostField` | `server/routes/browser-bridge.ts` | browser-bridge.test: «a spawned child…» `toEqual` rosso |
