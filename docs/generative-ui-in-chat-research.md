# Generative UI in chat — ricerca competitor + proposta per Topics

> Fase 1 del task "la chat AI genera dinamicamente un tool con UI + API backend, a volo, dentro la chat".
> Data: 2026-07-21. Autore: agent Kanban.

## 1. Cosa chiediamo esattamente

Quando serve, la chat AI di Topics deve **fabbricare al volo** un mini-tool con:
- una **UI interattiva** renderizzata *inline* nella chat (form, pannello, calcolatrice, dashboard…),
- delle **API backend** che quella UI può chiamare per fare il lavoro vero,

senza che io abbia pre-registrato quel tool. Due assi indipendenti nel mercato:
- **Chi genera la UI**: pre-costruita da uno sviluppatore (MCP server) *vs* generata a runtime dall'LLM (Artifacts).
- **Come la UI viene descritta**: codice eseguibile (HTML/JS in iframe) *vs* payload dichiarativo (JSON → componenti nativi del client).

## 2. Landscape competitor (stato luglio 2026)

| Prodotto / standard | Paradigma | Come nasce la UI | Backend / azioni | Rilevanza per noi |
|---|---|---|---|---|
| **MCP Apps (SEP-1865)** — Anthropic+OpenAI, ufficiale dal 26-gen-2026 | UI dentro la chat via **iframe sandboxed** + bridge JSON-RPC/postMessage | HTML/CSS/JS dichiarato dal server come risorsa `ui://` | La UI richiama **tool MCP** attraverso l'host (canale bidirezionale) | **Il riferimento.** È esattamente il pattern "UI + API in chat". Claude, ChatGPT, VS Code, Goose già lo renderizzano. |
| **OpenAI Apps SDK** (ChatGPT) | Come sopra (ChatGPT è l'host) | Web component in iframe + `window.openai` | MCP server obbligatorio; UI opzionale | Implementazione di riferimento di MCP Apps; UI kit pronto (`apps-sdk-ui`). |
| **Claude Artifacts** | **Codice generato a runtime dall'LLM**, eseguito in sandbox | Claude scrive HTML/JS o React, l'Artifact panel lo esegue live | Limitato (fetch verso host, no backend arbitrario per-artifact) | Modello più vicino al "genera a volo": nessuna pre-registrazione. Manca il canale backend robusto. |
| **Vercel AI SDK — Generative UI (RSC)** | Framework: tool call → componente React server-rendered | Dev mappa output→componenti propri | Le action sono funzioni server dell'app | Battle-tested ma **componenti pre-scritti**, non generati a volo. |
| **Thesys C1** | API OpenAI-compatibile che ritorna **UI strutturata** invece di testo | Componenti pre-costruiti (tabelle, form, chart, Vega-Lite) | Via MCP / le tue funzioni | "Drop-in" veloce ma ti chiude nel loro catalogo/hosting. |
| **Google A2UI (v0.9)** | Payload **dichiarativo JSON** → componenti nativi del client | L'agente descrive un component-tree; il client rende coi suoi componenti | Eventi/azioni verso l'agente | Più sicuro (niente codice eseguibile cross-trust), ma serve un catalogo componenti nostro. |
| **AG-UI** (CopilotKit) | **Transport** a eventi (SSE) agent↔frontend | Non definisce la UI; trasporta messaggi/tool-call/state-patch | Streaming di tool-call e risultati | È il "tubo", complementare: supporta nativamente A2UI/MCP-UI. |
| **v0 / bolt.new / Lovable** | Genera **app intere** da prompt | Codegen di progetti completi | App autonoma | Fuori scope: generano progetti, non widget effimeri in chat. |

**Segnale forte:** lo spazio si è **standardizzato attorno a MCP Apps** (Anthropic+OpenAI insieme, gen-2026) proprio per lo scenario "UI interattiva dentro la chat che richiama tool". Chi genera la UII può essere pre-scritta (server) o a runtime (Artifacts); il **contenitore** e il **bridge** sono ormai convenzionali: **iframe sandboxed + postMessage/JSON-RPC + fallback testuale**.

## 3. Feasibility in Topics

Punti d'aggancio già presenti:
- **Chat AI** con streaming e rendering tool-call: `client/src/components/MessageParts.tsx`, `MessageContent.tsx`, `useChat.ts`, `Chat/*`.
- **Tool "di sessione" già in stile MCP**: `server/control-tools.ts` (`open_project`, `new_topic`, `open_browser_pane`, `create_task`…) — abbiamo già un registro di tool che l'AI invoca e che agisce sul server locale.
- **Server locale nostro** (`:3333`) → montare **API backend a volo** è banale (a differenza dei competitor cloud): possiamo esporre endpoint effimeri per-artifact.
- **Pane browser** che rende URL/`file://`/HTML arbitrari già in sandbox nativa (WKWebView/Chromium) — un iframe/pane è già parte del sistema.
- Manca oggi: un **renderer di artifact/iframe sandboxed inline nella chat** con **bridge postMessage↔tool**. È il pezzo nuovo.

Conclusione: Topics è nella **posizione migliore** rispetto ai competitor cloud perché il backend è locale e già estendibile — l'API "a volo" non è un ostacolo, è un vantaggio.

## 4. Proposta d'approccio (3 opzioni)

### Opzione A — Allineamento a **MCP Apps** (standard-first)
Implementare host-side lo spec MCP Apps: la UI è una risorsa `ui://` in iframe sandboxed, bridge JSON-RPC/postMessage verso i nostri tool (`control-tools`), fallback testuale.
- **Pro**: standard co-firmato Anthropic+OpenAI; interoperabile con qualunque MCP server (Figma, Slack, Canva… "gratis"); a prova di futuro.
- **Contro**: la UI la scrive un *server*, non l'LLM a volo → copre "tool con UI" ma non il "**genera a volo**" del task, se non abbinato a B.

### Opzione B — **Artifact generato a volo** (Claude-Artifacts-like) — *più aderente alla richiesta*
L'LLM, quando serve, emette un **artifact** (HTML+JS o componente) che renderizziamo inline in **iframe sandboxed**; l'artifact parla col nostro server via un **bridge di tool** (postMessage → whitelisted actions/endpoint effimeri) per le "API backend".
- **Pro**: è letteralmente "genera dinamicamente un tool con UI+API a volo"; sfrutta il server locale; nessuna pre-registrazione.
- **Contro**: superficie di sicurezza (codice generato) → serve sandbox stretta + allowlist tool; è custom (non ancora interoperabile fuori Topics).

### Opzione C — **Ibrido (consigliato)**
**Bridge/renderer condiviso conforme a MCP Apps** (iframe sandboxed + postMessage↔tool + fallback), usato da **due sorgenti**: (1) artifact **generati a volo** dall'LLM per lo scenario del task, e (2) MCP server esterni "veri" quando presenti. Un solo contenitore, due produttori di UI.
- **Pro**: soddisfa il task ("a volo") *e* eredita l'ecosistema/standard; un solo modello di sicurezza; incrementale (prima l'artifact, poi apri agli MCP server).
- **Contro**: leggermente più lavoro di design iniziale (ma un solo runtime da mantenere).

## 5. Raccomandazione

**Opzione C**, in due fasi:
1. **Fase 2a** — Runtime artifact inline: renderer iframe sandboxed nella chat + bridge postMessage verso un set **allowlisted** di tool di `control-tools` + fallback testuale. Sblocca subito il caso d'uso del task.
2. **Fase 2b** — Generalizzare il bridge allo spec **MCP Apps** così che gli stessi widget arrivino anche da MCP server esterni.

Modello di sicurezza (non negoziabile): iframe `sandbox` senza `allow-same-origin` verso il nostro origin sensibile, nessun accesso diretto a rete/FS, **solo** tool allowlisted attraverso il bridge, conferma umana per azioni con effetti (in linea con la regola "mai azioni irreversibili senza conferma").

## Fonti
- MCP Apps blog ufficiale — https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/
- MCP-UI — https://mcpui.dev/ · https://github.com/MCP-UI-Org/mcp-ui
- OpenAI Apps SDK — https://developers.openai.com/apps-sdk
- Thesys C1 — https://docs.thesys.dev/guides/what-is-thesys-c1
- Google A2UI v0.9 — https://developers.googleblog.com/a2ui-v0-9-generative-ui/
- AG-UI vs A2UI (CopilotKit) — https://www.copilotkit.ai/ag-ui-and-a2ui
- Claude generative UI vs Artifacts — https://www.mindstudio.ai/blog/claude-on-demand-generative-ui-vs-canvas-artifacts
