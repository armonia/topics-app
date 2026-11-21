# Browser degli agenti nella loro sezione

## Perché
Attilio, 10/11: dopo la #721 le chat degli agenti non aprono più tab, ma il browser che quegli agenti aprono entra ancora nel suo spazio di lavoro (pane nel layout o finestra forzata). Deve vivere nella sezione dell'agente.

## Cosa cambia
- `shared/agent-owned.ts`: `isAgentOwnedTopic` (subagentOf, parentId, mcpPolicy bridge-only) condivisa fra client e server.
- `open-pane` sul topic di un agente: la pagina si carica sul suo contesto, nessun `browser:navigate`, nessun `browser:force-open` (`visible:false`). Si raggiunge dal marcatore nella sua chat.
- Auto-open prima di una page op: mai per un topic di un agente.
- Migrazione una tantum (`topics-agent-browsers-parked-v1:`): i pane browser degli agenti già nel layout escono dalla barra; il contesto resta vivo.
- Le chat aperte da Attilio: invariate.

Stato dell'arte: VS Code (Simple Browser) e Cursor tengono il browser dell'agente in un pannello suo, separato dalle tab dell'editor dell'utente; qui la sezione dell'agente fa lo stesso.

## Barra
- `bun test server/routes/browser-bridge.test.ts server/routes/browser-auto-open.test.ts client/src/lib/agentTabs.test.ts` (rosso senza: 10 fallimenti; verde con).
- `pw-remote -- npx playwright test tests/e2e/agent-browser-own-section.spec.ts --project=chromium`: zero pane e zero force-open per la chat agente; pane come prima per la chat di Attilio.

## Fuori
Finestre native minimizzate: per gli agenti non nasce più nessuna finestra, quindi desktop-tauri non si tocca.

## Deciso da me
GENUI-05 (sottoagente mostrato nella finestra del genitore) aggiornato: un sottoagente è un agente, il suo browser resta nella sua sezione.
