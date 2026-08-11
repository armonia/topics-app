/**
 * Il server MCP del banco: un solo tool, `web_fetch`, che restituisce una delle
 * 10 pagine scaricate.
 *
 * È un server VERO (stdio, JSON-RPC 2.0, `initialize`/`tools/list`/`tools/call`)
 * perché il tetto che sto misurando — `MAX_MCP_OUTPUT_TOKENS` — la CLI lo
 * applica sul confine MCP: con un tool finto simulato altrove non misurerei
 * niente. È deterministico perché le due misure devono vedere byte identici:
 * se la differenza fra "prima" e "dopo" potesse essere la rete, non sarebbe una
 * misura.
 */
import { readFileSync } from "node:fs";
import { PAGES, pageFile } from "./pages";

const TOOL = {
  name: "web_fetch",
  description:
    "Scarica una pagina web e restituisce il testo. Argomento: url (uno dei 10 del banco).",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "URL da scaricare" } },
    required: ["url"],
  },
};

/**
 * Il canale di permesso. `buildClaudeArgs` passa SEMPRE
 * `--permission-prompt-tool` (è un'invariante del prodotto: senza, ogni
 * modalità che non sia `bypassPermissions` diventa un no muto) e la CLI
 * verifica che quel tool ESISTA, anche quando non lo chiamerà mai. Se manca,
 * la sessione muore dopo la prima chiamata — che è esattamente come si è visto
 * fallire il primo giro del banco.
 */
const NOOP = {
  name: "noop",
  description: "Canale di permesso del banco: concede sempre, non viene mai chiamato.",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" } },
  },
};

function pageFor(url: string): string {
  const i = PAGES.indexOf(url.trim());
  if (i < 0) {
    // Anche l'errore deve essere deterministico: un URL fuori elenco non deve
    // mandare il banco in rete di nascosto.
    return `Errore: ${url} non fa parte del banco. URL ammessi:\n${PAGES.join("\n")}`;
  }
  try {
    return readFileSync(pageFile(i + 1), "utf8");
  } catch (err) {
    // Un'eccezione qui dentro ucciderebbe il server, e il guasto arriverebbe
    // alla CLI travestito da problema di trasporto («Connection closed»).
    return `Errore nel banco: ${(err as Error).message}`;
  }
}

function reply(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

/**
 * Si legge iterando `Bun.stdin.stream()` e NON con `process.stdin.on("data")`:
 * quel listener non trattiene il processo, che finiva l'handshake e usciva
 * subito dopo — dal lato CLI si vedeva «MCP error -32000: Connection closed» a
 * ogni chiamata, e nel log del server «STDIO connection closed after 0s
 * (cleanly)». Un server MCP che esce non è un server MCP.
 */
let buf = "";
const decoder = new TextDecoder();
// `for await` sullo stream non tipa: `ReadableStream` non dichiara
// `[Symbol.asyncIterator]` nei lib DOM, e `bun run typecheck` lo rifiuta. Il
// reader esplicito fa la stessa cosa ed è tipato.
const reader = Bun.stdin.stream().getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  const chunk = value as Uint8Array;
  buf += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: { id?: unknown; method?: string; params?: { name?: string; arguments?: { url?: string } } };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    // Le notifiche (senza id) non vogliono risposta: rispondere farebbe
    // chiudere la connessione alla CLI.
    if (msg.id === undefined) continue;
    switch (msg.method) {
      case "initialize":
        reply(msg.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mcp-cap-bench", version: "1.0.0" },
        });
        break;
      case "tools/list":
        reply(msg.id, { tools: [TOOL, NOOP] });
        break;
      case "tools/call":
        if (msg.params?.name === "noop") {
          reply(msg.id, {
            content: [{ type: "text", text: JSON.stringify({ behavior: "allow", updatedInput: {} }) }],
          });
          break;
        }
        reply(msg.id, {
          content: [{ type: "text", text: pageFor(String(msg.params?.arguments?.url ?? "")) }],
        });
        break;
      default:
        reply(msg.id, {});
    }
  }
}
