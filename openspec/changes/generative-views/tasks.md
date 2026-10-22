# Tracks — generative-views

Lo stato lo danno git e i test, non le caselle.

1. **Contratto `compare`** (GENUI-03) — `shared/views.ts`, `shared/tool-detail.ts`, union in `shared/types.ts` e `shared/tool-call-detail.ts`. Barra: `bun test shared/views.test.ts tests/unit/tool-call-detail-schema.test.ts`.
2. **Tool e archivio** (GENUI-02, dipende da 1) — `server/mcp/view-tools.ts`, `server/routes/views.ts`, route table. Barra: `bun test server/routes/views.test.ts server/mcp/topics-mcp-server.test.ts server/route-table.test.ts`.
3. **Chat e pagina** (GENUI-01, GENUI-04, dipende da 1-2) — `client/src/components/Views/*`, `MessageContent`, `turnFold`, `main.tsx` (`/v/<id>`). Barra: `bunx playwright test tests/e2e/chat-generative-view.spec.ts --project=webkit`.
4. **Browser dei figli nella finestra del padre** (GENUI-05, indipendente) — `rootSessionKeyOf`, `browserHostTopicOf` in `browser-bridge.ts`, `hostTopicId` in `usePaneOrdering` e `useProjectBrowserPanes`. Barra: `bun test server/routes/browser-bridge.test.ts server/lib/subagent-store.test.ts` + `bunx playwright test tests/e2e/browser-child-in-parent-window.spec.ts --project=webkit`.
5. **Tabella e piano** (GENUI-06, GENUI-07, dipende da 1-3) — `shared/views-table.ts`, `shared/views-timeline.ts`, `shared/views-format.ts`, `client/src/components/Views/{TableView,TimelineView,ViewBody,ViewChrome}.tsx`, parole in `shared/i18n-views-{it,en}.ts`. Dati veri del viaggio in `tests/e2e/fixtures/trip-views.ts`. Barra: `bun test shared/views-kinds.test.ts` + `bunx playwright test tests/e2e/chat-generative-view-kinds.spec.ts --project=webkit`.
6. **Interop MCP Apps** (GENUI-08, dipende da 2 e 5) — `server/views/view-html.ts` (documento autosufficiente + ponte postMessage), `resources/*` e `_meta` di `show_view` in `server/mcp/view-tools.ts`, `GET /api/views` e `/api/views/:id/app`. Barra: `bun test server/views/view-html.test.ts` + il test «MCP Apps host» della spec kinds.
7. **Prossime** (non iniziate): aggiornare una vista già mostrata (`viewId` in ingresso); foto https anche nell'app generica (oggi il CSP le dichiara solo sulla risorsa per id); prova dal vivo in OpenClaw dopo il merge.
