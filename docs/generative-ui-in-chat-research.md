# Generative UI in chat — ricerca competitor + proposta per Topics

> Fase 1 del task "la chat AI genera dinamicamente un tool con UI + API backend, a volo, dentro la chat".
> Data: 2026-07-21 · **Rev. 2026-08-10** (refresh landscape Ago-2026 + verifica architettura in-code). Autore: agent Kanban.

## 1. Cosa chiediamo esattamente

Quando serve, la chat AI di Topics deve **fabbricare al volo** un mini-tool con:
- una **UI interattiva** renderizzata *inline* nella chat (form, pannello, calcolatrice, dashboard…),
- delle **API backend** che quella UI può chiamare per fare il lavoro vero,

senza che io abbia pre-registrato quel tool.

**Due assi indipendenti** (è da qui che cade tutta la decisione):
- **Asse 1 — PROVENIENZA / chi scrive la UI**: template pre-dichiarato lato server che il modello si limita a scegliere/attivare (MCP Apps `ui://`, Vercel tool→component, A2UI catalog) **vs** codice UI che il modello **genera a runtime** senza pre-registrazione (Claude Artifacts, Thesys C1).
- **Asse 2 — CONSEGNA + FIDUCIA**: codice eseguibile in **iframe sandboxed** governato da un bridge JSON-RPC/postMessage auditato + consenso per-azione (MCP Apps, Artifacts, mcp-ui) **vs** dato **dichiarativo** reso da un catalogo di componenti fidati del client (Google A2UI, AG-UI).

I due casi d'uso di Topics — (1) artifact generati a runtime dall'LLM e (2) veri MCP server esterni — differiscono **solo sull'Asse 1**; stanno nello **stesso punto** dell'Asse 2 (iframe sandboxed + JSON-RPC + consenso). Questo è il fatto portante: **un solo renderer, due produttori di UI**.

## 2. Landscape competitor (stato Agosto 2026)

| Prodotto / standard | Asse 1 (chi) | Asse 2 (come) | Backend / azioni | Stato Ago-2026 & rilevanza |
|---|---|---|---|---|
| **MCP Apps** (ex SEP-1865, id `io.modelcontextprotocol/ui`) | Pre-dichiarato (server) | Iframe sandboxed, HTML `ui://` | Tool MCP via bridge JSON-RPC/postMessage (`app.callServerTool` / `ontoolresult`), stesso path di audit+consenso di una tool-call | **FINAL.** Primo ext ufficiale MCP (26-gen-2026); nello spec 2026-07-28 inglobato nel framework estensioni (SEP-2133, id reverse-DNS, `@modelcontextprotocol/ext-apps`). **Il riferimento e il contratto cross-host.** |
| **Anthropic Claude — "interactive connectors"** | Pre-dichiarato (connector) | Iframe sandboxed inline in chat | Tool MCP, consenso esplicito per azione | **GA** (mobile/web/desktop + Cowork). Host di riferimento dello standard. |
| **OpenAI Apps SDK** (ChatGPT + App Directory) | Pre-dichiarato (dev) | Iframe sandboxed, widget | MCP server + bridge `window.openai` | **Beta**, ma **ribasato SULLO standard**: `window.openai` è ora un layer di compatibilità, `openai/*` meta = alias di `_meta.ui.*`. Precedente chiave: "namespaci le tue affordance sopra lo standard, non forkarlo". |
| **Claude Artifacts** | **Runtime (LLM)** | Codice eseguito in sandbox | Egress allargato a MCP + storage 20 MB, ma `fetch()` arbitrario **bloccato** | Il modello più vicino al "genera a volo". Il suo tetto d'egress (solo LLM+MCP) è il riferimento per la postura di sicurezza dell'Opzione C. |
| **OpenAI Canvas** | Runtime | Pannello laterale dedicato | — | **RITIRATO** (30-mag-2026), rifuso nel testo/codice inline della chat. Segnale: un pannello gen-UI a sé **collassa nel thread** → rendi inline, non come side-panel permanente. |
| **Vercel AI SDK — Generative UI** | Pre-scritto (dev) | RSC / componenti | Funzioni server dell'app | RSC/`streamUI` (codice server-streamed) **in pausa** (repo esempio archiviato giu-2026) → si spinge a client-component su eventi tipizzati. Valida il nostro rendering tool→`ToolCallRow`. |
| **Thesys C1** | Runtime (API ritorna UI) | Componenti pre-costruiti | Via MCP / tue funzioni | Veloce ma ti chiude nel catalogo; monito: layout composto dal modello **non** è regressabile a pixel/geometria. |
| **Google A2UI (v0.9.1)** | Pre-dichiarato (catalogo) | **JSON dichiarativo** → componenti nativi | Eventi verso l'agente | Più sicuro (niente codice cross-trust) ma serve un catalogo nostro; giovane, non allineato a Claude. |
| **AG-UI** (CopilotKit) | — (transport) | Eventi SSE agent↔frontend | Streaming tool-call/state | Il "tubo", complementare; supporta A2UI/MCP-UI. |
| **v0 / bolt.new / Lovable** | Runtime | App intere | App autonoma | Fuori scope: generano progetti, non widget effimeri in chat. |

**Segnale forte (Gen→Ago 2026):** lo spazio ha smesso di essere una guerra di bridge e ha **convergiuto su UN contratto vendor-neutral: MCP Apps** — primitiva uniforme ovunque: *iframe sandboxed che rende HTML + JSON-RPC-over-postMessage sul protocollo base MCP + consenso per-azione*. Host conformi: Claude (GA), ChatGPT, VS Code/Copilot (Stable), Cursor 2.6, M365 Copilot, Postman, MCPJam, Archestra.AI, Goose (sperimentale). Per un host Claude-Code-centrico come Topics la domanda non è più "quale bridge" ma **"targetta MCP Apps e namespaccia le tue affordance"**.

## 3. Feasibility in Topics (anchor verificati in-code, Ago-2026)

Punti d'aggancio confermati (con correzioni rispetto alla rev. precedente):
- **Chat AI streaming (SSE) + rendering tool-call**: `client/src/hooks/useChat.ts` (SSE), `client/src/components/MessageContent.tsx:899,922` → renderizza `client/src/components/Chat/ToolCallRow.tsx`. *(Correzione: NON `MessageParts.tsx`, che oggi è solo l'indicatore di attività live.)*
- **Registro tool in stile MCP** (JSON-RPC): `server/mcp/topics-mcp-server.ts` — ~30 tool (`open_browser_pane`, `run_script`, `create_task`, `update_task`, `ask_user_question`, `spawn_agent`…), con `tools/call` (:1797), filtro `isToolAllowedForProfile` e annotazioni `readOnlyHint`/`destructiveHint`. *(Correzione: `server/control-tools.ts` è solo un sottoinsieme di 5 tool SDK-passthrough.)*
- **Server locale :3333** con infra di route dinamiche e **preview-manager per-task** (`server.ts:1051-1125`) che serve HTML per-branch → montare **API/endpoint effimeri a volo** è già possibile.
- **Pane browser** in sandbox nativa (WKWebView/Chromium) + fallback iframe sandboxed (`client/src/components/Browser/RemoteBrowserPanel.tsx:674-689`). *(Correzione: il pane **blocca `file://`** — solo http/https/about/data; HTML arbitrario passa via `data:` o `/preview`.)*
- **Integrazione MCP host già presente**: `--mcp-config`/`--strict-mcp-config` (`server/providers/claude/args.ts`), bridge sessione (`server/providers/claude-code.ts`).

**Pezzo mancante (confermato assente ovunque):** un **renderer di artifact/iframe sandboxed inline NELLA chat** con **bridge postMessage↔tool**. `grep` di `postMessage`/`iframe`/`ui://`/`resources/read` nei componenti chat = vuoto (gli iframe esistono solo in browser/editor/PDF, mai nel renderer dei messaggi). **È il pezzo nuovo da costruire.**

Conclusione: Topics è nella **posizione migliore** vs i competitor cloud — il backend è locale e già estendibile, e ogni non-negoziabile di sicurezza mappa su una primitiva **già presente**.

## 4. Proposta d'approccio (3 opzioni)

### Opzione A — MCP Apps puro (standard-first)
UI fornita da **server MCP esterni**, resa in iframe sandboxed + bridge verso i nostri tool.
- **Pro**: standard co-firmato Anthropic+OpenAI, interop "gratis"; a prova di futuro.
- **Contro**: la UI la scrive un *server*, non l'LLM a volo → copre "tool con UI" ma **non** il "genera a volo" del task.

### Opzione B — Artifact generato a volo (Artifacts-like)
L'LLM emette un artifact (HTML+JS) reso inline in iframe sandboxed, con bridge verso i nostri tool.
- **Pro**: è letteralmente la richiesta; nessuna pre-registrazione; sfrutta il server locale.
- **Contro**: bridge privato → buttato via appena serve un vero MCP server esterno; non interoperabile; perde la conformità con l'host GA di Anthropic.

### Opzione C — Ibrido (**consigliato**)
**Un solo renderer conforme a MCP Apps** (iframe sandboxed + bridge JSON-RPC/postMessage + fallback), alimentato da **due produttori**: (1) artifact **generati a volo** dall'LLM e (2) veri MCP server esterni. I due casi differiscono solo sull'Asse 1; l'Asse 2 è condiviso e ora è **standard FINALE**.
- **Pro**: soddisfa il task ("a volo") *e* eredita ecosistema/standard; **un solo** modello di sicurezza; incrementale.
- **Contro**: un filo di design in più all'inizio (ma un solo runtime da mantenere).

## 5. Raccomandazione

**Opzione C**, con **una raffinatezza chiave**: costruire il renderer+bridge della **Fase 2a sul wire MCP Apps FIN DAL PRIMO GIORNO** (`@modelcontextprotocol/ext-apps`, semantica risorsa `ui://`, forma `_meta.ui.*`, JSON-RPC-over-postMessage), alimentato da un **producer locale** che avvolge l'HTML generato dall'LLM come risorsa `ui://` servita dall'origine sandbox. Così la Fase 2b è **additiva**, non una riscrittura. *Non* inventare un protocollo artifact-specifico in 2a per poi retrofittare lo standard in 2b.

- **Fase 0 (spec + scheletro, gate pre-codice)**: fissa il wire su `@modelcontextprotocol/ext-apps`; alza l'**origine sandbox dedicata** estendendo il preview-manager (`server.ts:1056`) a servire `text/html;profile=mcp-app` su porta separata; aggiungi un block-type `artifact` al modello messaggi. *Barra: i tipi compilano, una risorsa `ui://` hello-world è servita, `origin != app origin` asserito.*
- **Fase 2a (runtime artifact — la richiesta del task)**: renderer inline `<McpAppFrame>` (nuova superficie, accanto a `ToolCallRow` in `MessageContent.tsx:899,922`); HTML LLM avvolto server-side come `ui://`; listener postMessage JSON-RPC nuovo (valida `event.origin` + forma); `app.callServerTool` → `tools/call` di `topics-mcp-server.ts` (:1797), default al sottoinsieme `readOnlyHint:true`; ogni azione con effetti passa da `mcp__topics__approval_prompt` (:384). *Barra = **video** (Playwright): render artifact, tool read-only che ritorna via `ontoolresult`, azione effettuale che fa scattare l'approvazione, artifact-sonda che prova `window.__TAURI__`/`top` e **fallisce** (cross-origin).*
- **Fase 2b (generalizza agli MCP server esterni)**: registra server esterni come producer `ui://`; `resources/read` + prefetch/cache/security-review; allowlist per-server dopo review; **stesso renderer** della 2a. *Barra: interop test contro un server ext-apps di riferimento che round-trippa una tool-call nello stesso renderer.*
- **Fase 3 (opzionale)**: affordance host-specifiche (piazzamento pane, apri-artifact-come-pane, tema/safe-area) come **estensione namespaced reverse-DNS** (SEP-2133, es. `app.topics/*`), sopra — mai forkando — lo standard, come `window.openai`.

### Modello di sicurezza (non negoziabile) — mappato sulle primitive già presenti
1. **Origine sandbox, mai la nostra**: HTML servito da un'**origine usa-e-getta** (estendendo il preview-manager) → il frame non raggiunge mai l'IPC `window.__TAURI__`; per l'MVP preferisci `srcdoc`/null-origin senza `allow-same-origin`.
2. **No frame-bust**: riusa la disciplina di `RemoteBrowserPanel.tsx:679-689` — `sandbox='allow-scripts …'` **omettendo** `allow-top-navigation*` (una top-nav ucciderebbe l'intera WKWebView Tauri).
3. **No rete/FS diretti**: CSP `default-src 'none'` + `connect-src 'none'` → l'unico egress è il bridge.
4. **Solo tool allowlisted**: `app.callServerTool` → `tools/call` gated da `isToolAllowedForProfile` + annotazioni `readOnlyHint`/`destructiveHint`. Artifact runtime (non fidati) = default sola-lettura; server esterni registrati = allowlist per-server dopo review.
5. **Conferma umana per azioni con effetti**: ogni call non-`readOnlyHint` passa da `mcp__topics__approval_prompt` (già il nostro `--permission-prompt-tool`).
6. **Listener postMessage nuovo e stretto**: valida `event.origin === origine sandbox` e forma JSON-RPC 2.0, scarta il resto.

## 6. Rischi aperti
- **Pressione ad allargare l'egress** (Artifacts l'ha già fatto): tenere la linea "unico egress = bridge"; ogni endpoint effimero per-artifact deve stare dietro allowlist+consenso, non diventare un `fetch` aperto.
- **MCP Apps MVP è solo-HTML** (Remote DOM / iframe URL esterni differiti): se un giorno serve rendering host-nativo/geometria-controllabile, lo standard oggi non lo dà (A2UI sì, ma è giovane e non Claude-allineato). Non scommetterci la Fase 1.
- **Consent fatigue vs sicurezza**: instradare ogni azione effettuale nell'approvazione è corretto ma pesa → serve un'escalation di fiducia per-artifact/sessione senza allargare in silenzio il path effettuale.
- **Standard giovane nella coda lunga**: pinna `@modelcontextprotocol/ext-apps` e `MCP_PROTOCOL_VERSION`; aspettati churn sull'interop 2b.
- **Trappola origine iframe in Tauri**: sbagliare l'origine sandbox (o aggiungere `allow-same-origin` verso la nostra origine) = compromissione dell'intera app → va imposta da un **test** (Fase 2a barra "d"), non da un commento.
- **Asimmetria di verifica**: gli artifact runtime sono non-deterministici → tienili dentro il confine iframe (fiducia **e** geometria); la barra assicura bridge/consenso/isolamento, **mai** il layout dell'artifact (altrimenti la suite diventa flaky).

## Fonti
- MCP Apps — SEP-1865 (storico) https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp · blog 26-gen-2026 https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/ · overview https://modelcontextprotocol.io/extensions/apps/overview
- Spec 2026-07-28 (extensions framework / SEP-2133) — https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/ · https://github.com/modelcontextprotocol/ext-apps
- OpenAI Apps SDK — https://developers.openai.com/apps-sdk/reference · https://openai.com/index/introducing-apps-in-chatgpt/
- Thesys C1 — https://docs.thesys.dev/guides/what-is-thesys-c1
- Google A2UI v0.9 — https://developers.googleblog.com/a2ui-v0-9-generative-ui/
- AG-UI vs A2UI (CopilotKit) — https://www.copilotkit.ai/ag-ui-and-a2ui
- Claude generative UI vs Artifacts — https://www.mindstudio.ai/blog/claude-on-demand-generative-ui-vs-canvas-artifacts
