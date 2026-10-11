# Proposal: generative-views

Nessun «Da decidere»: niente spesa, niente dati di persone, niente di irreversibile. Le scelte tecniche sono in fondo, «Deciso da me».

## Perché

Attilio, 08/10: «una intelligent ui da integrare in topics direttamente come quella nuova [gli Artifacts di Claude] … sia interna a topics sia che la apre su browser, già pronta al top per qualsiasi cosa e non ai slop». Oggi un agente che confronta tre alloggi (topic:64095902) scrive un `index.html` a mano, lo serve su una porta sua (`127.0.0.1:8790`) e lo apre nel browser: ogni volta uno stile diverso, una pagina che muore col processo, niente in chat.

Stesso tema, seconda richiesta: nella stessa chat le tab Topics si moltiplicavano. Causa misurata nel DB: non il `name` di `open_browser_pane` (le aperture di una chat hanno sempre lo stesso contesto, `resolveContextIdForTopic` ignora il nome fuori dai task), ma i **figli di `spawn_agent`**: «Terza opzione alloggio» (`00dbd71f`) e «Treni Huesca» (`1b40143d`) sono topic a sé, non stanno in nessuna tab, quindi nessuno rivendicava il loro `browser:navigate` e il ripiego `browser:force-open` apriva una tab di layout per figlio.

## Studio (una pagina)

| | Chi disegna | Pro | Contro |
|---|---|---|---|
| Claude Artifacts / «imagine» | il modello scrive HTML/React, sandbox, link pubblico | libertà totale | lo stile lo reinventa ogni volta: è la fonte dello slop; token |
| Vercel AI SDK, generative UI | tool call → componente React del client | tipato, coerente | legato al framework, non è uno standard |
| MCP Apps (SEP-1865, da mcp-ui) | il server MCP dichiara `_meta.ui.resourceUri` → HTML `ui://` in iframe, bridge postMessage | standard aperto, adottato da Claude, ChatGPT, VS Code | l'HTML lo scrive il server; del tema dell'host arrivano solo variabili |
| OpenAI Apps SDK | widget HTML su MCP + `window.openai` | ecosistema ChatGPT | converge su MCP Apps |
| A2UI (Google) | JSON dichiarativo da un catalogo fidato, rendering nativo | sicuro, streamabile, nessun codice dal modello | catalogo da costruire |
| json-render | catalogo di componenti tipati con zod, il modello emette JSON vincolato | stesso principio, piccolo | idem |
| Topics oggi | browser della chat, `{{BROWSER:url}}`, card `ask_user_question`, `shared/tool-detail.ts` | il ponte dati→card esiste già | nessuna vista per dati strutturati |

**Raccomandazione.** Catalogo tipato con rendering nativo (modello A2UI/json-render): il modello manda **dati**, Topics disegna con il suo design system. È l'unico modo in cui «non slop» è garantito per costruzione invece che sperato. La stessa vista vive in chat e come pagina `/v/<id>`. Per lo standard aperto le stesse viste sono anche risorse MCP Apps (`ui://topics/view/<id>`): un host esterno le mostra senza riscriverle.

## Cosa cambia

- Tool `show_view` sul ponte MCP (anche nel runtime nativo), tre tipi: `compare` (2-4 opzioni con prezzo, foto, metriche confrontabili, pro/contro, link, una consigliata), `table` (righe e colonne, colonne numeriche classificate, ignoto scritto come ignoto) e `timeline` (piano porta a porta per giorni, con alternative per tratta e scadenze).
- `POST /api/sessions/:key/views` normalizza e salva in `data/views/<id>.json`; `GET /api/views/:id` la rilegge.
- In chat: blocco `ViewBlock` sollevato fuori dalla piega del turno, come le pagine aperte. Pagina standalone `/v/<id>` sul server (13333 in Tauri), tema chiaro/scuro, telefono.
- Interop MCP Apps: il ponte dichiara `resources` ed espone `ui://topics/view` (app generica, riceve la vista dal tool result) e `ui://topics/view/<id>` (una vista salvata), documenti autosufficienti col protocollo postMessage dello standard. OpenClaw, Claude e ChatGPT le mostrano senza il client di Topics.
- Browser dei figli: `open-pane` di un figlio annuncia `hostTopicId` = la chat in cima alla catena (`rootSessionKeyOf`); il client mette la pagina nella finestra browser di quella chat, col contesto del figlio (i suoi `browser_*` restano suoi).

## Barra

`specs/acceptance.md`: unit + e2e WebKit che escono non-zero, video spec-flow, due mutazioni viste rosse.

## Fuori

Altri tipi (mappa, grafico: tracce successive); HTML libero del modello; condivisione pubblica fuori dal Mac; i popup `target=_blank` delle pagine (già tab nella stessa striscia, scelta esistente).

## Deciso da me

1. Nome del tool `show_view`, non `render_ui`: descrive cosa vede la persona.
2. Dati e non HTML: il modello non scrive markup, quindi niente sandbox né CSP da gestire.
3. Viste su file JSON in `data/views/`, non una tabella: sono immutabili, una migrazione non serve.
4. Pagina servita dal server stesso (`/v/<id>` carica la SPA con un mount dedicato), niente porte nuove.
5. Per MCP Apps un secondo disegno, in HTML semplice lato server, e non il client React impacchettato: nell'iframe di un altro host il client non si carica, e i dati, le regole (classifica, gruppi, formati) e le parole restano gli stessi moduli `shared/`.
6. La vista disegnata viaggia nel `_meta` del tool result, non nel testo: il modello non paga in token il markup.
7. Il figlio tiene il suo contesto browser e cambia solo dove viene mostrato: spostare il contesto sul padre avrebbe fatto litigare due agenti sulla stessa pagina.
