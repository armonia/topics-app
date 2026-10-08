# Tracks — generative-views

Lo stato lo danno git e i test, non le caselle.

1. **Contratto `compare`** (GENUI-03) — `shared/views.ts`, `shared/tool-detail.ts`, union in `shared/types.ts` e `shared/tool-call-detail.ts`. Barra: `bun test shared/views.test.ts tests/unit/tool-call-detail-schema.test.ts`.
2. **Tool e archivio** (GENUI-02, dipende da 1) — `server/mcp/view-tools.ts`, `server/routes/views.ts`, route table. Barra: `bun test server/routes/views.test.ts server/mcp/topics-mcp-server.test.ts server/route-table.test.ts`.
3. **Chat e pagina** (GENUI-01, GENUI-04, dipende da 1-2) — `client/src/components/Views/*`, `MessageContent`, `turnFold`, `main.tsx` (`/v/<id>`). Barra: `bunx playwright test tests/e2e/chat-generative-view.spec.ts --project=webkit`.
4. **Browser dei figli nella finestra del padre** (GENUI-05, indipendente) — `rootSessionKeyOf`, `browserHostTopicOf` in `browser-bridge.ts`, `hostTopicId` in `usePaneOrdering` e `useProjectBrowserPanes`. Barra: `bun test server/routes/browser-bridge.test.ts server/lib/subagent-store.test.ts` + `bunx playwright test tests/e2e/browser-child-in-parent-window.spec.ts --project=webkit`.
5. **Prossime** (non iniziate): tipi `table` e `timeline`; aggiornare una vista già mostrata (`viewId` in ingresso); interop MCP Apps (`ui://topics/view/<id>` con `_meta.ui.resourceUri`), barra: un host MCP Apps di riferimento mostra la vista.
