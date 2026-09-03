/**
 * `todo_write` and `web_fetch`: the two things the native runtime could not do
 * that the CLI could.
 *
 * WHAT IS WORTH TESTING HERE is not that a fetch fetches. It is the handful of
 * answers that decide whether the agent wastes a round: a refusal that says
 * WHICH schemes are allowed, a non-text resource named instead of dumped as
 * mojibake, an HTML page that carries no readable text saying so out loud, and
 * a plan whose tally the model can check itself against.
 *
 * The server is a real one on the loopback interface, at a port the OS picks:
 * a stubbed `fetch` would test the stub, and this code exists precisely to deal
 * with what comes back over the wire (headers, redirects, content types).
 *
 * @covers CHAT-NTOOL-01, CHAT-NTOOL-02, CHAT-NTOOL-03
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { CODING_TOOLS, WORKSPACE_FREE_TOOLS, executeTool, type ToolContext } from "./tools";
import { deriveToolDetail } from "../claude/tool-detail";

const ctx: ToolContext = { workspace: process.cwd() };

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      switch (pathname) {
        case "/page":
          return new Response(
            `<!doctype html><html><head><title>Guida</title><script>var x=1</script></head>
             <body><h1>Titolo</h1><p>Prima riga.</p><ul><li>alfa</li><li>beta</li></ul>
             <a href="/altro">continua</a></body></html>`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        case "/spa":
          return new Response(
            `<!doctype html><html><body><div id="root"></div><script>render()</script></body></html>`,
            { headers: { "content-type": "text/html" } },
          );
        case "/json":
          return new Response(`{"nome":"topics","versione":2}`, { headers: { "content-type": "application/json" } });
        case "/testo":
          return new Response("riga uno\nriga due", { headers: { "content-type": "text/plain" } });
        case "/png":
          return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } });
        case "/grosso":
          return new Response("x".repeat(500_000), { headers: { "content-type": "text/plain" } });
        case "/vecchio":
          return Response.redirect(`http://127.0.0.1:${server.port}/testo`, 302);
        case "/rotto":
          return new Response("<html><body><p>nessuna chiave</p></body></html>", {
            status: 401, headers: { "content-type": "text/html" },
          });
        default:
          return new Response("no", { status: 404, headers: { "content-type": "text/plain" } });
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => { server.stop(true); });

describe("tool todo_write", () => {
  it("è dichiarato con `todos` obbligatorio", () => {
    const spec = CODING_TOOLS.find((t) => t.name === "todo_write");
    expect(spec).toBeDefined();
    expect(spec!.input_schema.required).toEqual(["todos"]);
  });

  it("risponde con il conteggio per stato, che è ciò su cui il modello si ricontrolla", async () => {
    const r = await executeTool("todo_write", {
      todos: [
        { content: "leggere il file", status: "completed" },
        { content: "scrivere il tool", status: "in_progress", activeForm: "scrivendo il tool" },
        { content: "provarlo", status: "pending" },
      ],
    }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("1 done");
    expect(r.content).toContain("1 in progress");
    expect(r.content).toContain("1 pending");
  });

  it("uno stato inventato è un errore che nomina lo stato e i valori buoni", async () => {
    const r = await executeTool("todo_write", { todos: [{ content: "x", status: "quasi" }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("quasi");
    expect(r.content).toContain("in_progress");
  });

  it("una lista vuota non passa: renderebbe una card vuota", async () => {
    expect((await executeTool("todo_write", { todos: [] }, ctx)).isError).toBe(true);
    expect((await executeTool("todo_write", {}, ctx)).isError).toBe(true);
  });

  it("due passi in corso si segnalano, non si rifiutano", async () => {
    const r = await executeTool("todo_write", {
      todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }],
    }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("keep one");
  });
});

/**
 * THE LINK THAT MAKES THE CHANGE WORTH ANYTHING, and the only one no other test
 * watches. The tool is useful because the client DRAWS it, and between the two
 * there is one translation: `routes/chat.ts` runs every provider's tool call
 * through `deriveToolDetail` before it reaches the browser. That function keys
 * on the NAME and reads the FIELDS - so renaming the tool, or calling the array
 * anything other than `todos`, leaves both sides green and quietly puts raw JSON
 * back on screen where the todo card was. The two `expect`s below are what turns
 * that silent regression into a red line.
 */
describe("la forma dichiarata sopravvive al confine dello stream", () => {
  it("`todo_write` diventa una todo, non un tool generico", () => {
    const d = deriveToolDetail("todo_write", {
      todos: [{ content: "scrivere il tool", status: "in_progress", activeForm: "scrivendo il tool" }],
    });
    expect(d.type).toBe("todo");
    // The strip above the composer reads exactly these three fields.
    expect(d).toMatchObject({
      items: [{ content: "scrivere il tool", status: "in_progress", activeForm: "scrivendo il tool" }],
    });
  });

  it("`web_fetch` diventa una fetch, con l'indirizzo che la card mostra", () => {
    const d = deriveToolDetail("web_fetch", { url: "https://esempio.dev/guida" });
    expect(d.type).toBe("fetch");
    expect(d).toMatchObject({ url: "https://esempio.dev/guida" });
  });

  it("i nomi sono quelli, e restano quelli", () => {
    // The NAME is the contract with `deriveToolDetail`: break it loudly here.
    expect(CODING_TOOLS.map((t) => t.name)).toContain("todo_write");
    expect(CODING_TOOLS.map((t) => t.name)).toContain("web_fetch");
  });
});

describe("a tool that would fail at runtime is not declared", () => {
  it("no web_search without a search credential, no task without a safe nested turn", () => {
    // A declared tool is an invitation: one that answers "no credential" costs
    // two rounds before the model gives up. Search reaches the model through
    // the MCP fleet instead, and a sub-agent needs depth, budget, a UI channel
    // and cancellation before it can exist (CHAT-NTOOL-03).
    const declared = [...CODING_TOOLS, ...WORKSPACE_FREE_TOOLS].map((t) => t.name);
    expect(declared).not.toContain("web_search");
    expect(declared).not.toContain("task");
  });
});

describe("una chat senza progetto", () => {
  it("tiene i due tool che non risolvono nessun percorso, e nient'altro", () => {
    expect(WORKSPACE_FREE_TOOLS.map((t) => t.name).sort()).toEqual(["todo_write", "web_fetch"]);
  });

  it("e li esegue davvero con una workspace vuota", async () => {
    const noWorkspace: ToolContext = { workspace: "" };
    expect((await executeTool("todo_write", { todos: [{ content: "a", status: "pending" }] }, noWorkspace)).isError)
      .toBeUndefined();
    expect((await executeTool("web_fetch", { url: `${base}/testo` }, noWorkspace)).content).toContain("riga uno");
  });
});

describe("tool web_fetch", () => {
  it("una pagina HTML torna come markdown: titolo, struttura, link assoluti", async () => {
    const r = await executeTool("web_fetch", { url: `${base}/page` }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("# Guida");
    expect(r.content).toContain("# Titolo");
    expect(r.content).toContain("- alfa");
    expect(r.content).toContain(`[continua](${base}/altro)`);
    expect(r.content).not.toContain("var x=1");
  });

  it("il JSON torna indentato, non su una riga sola", async () => {
    const r = await executeTool("web_fetch", { url: `${base}/json` }, ctx);
    expect(r.content).toContain(`"nome": "topics"`);
  });

  it("il testo semplice passa così com'è", async () => {
    const r = await executeTool("web_fetch", { url: `${base}/testo` }, ctx);
    expect(r.content).toContain("riga uno\nriga due");
  });

  it("un redirect si segue e si dichiara dove si è finiti", async () => {
    const r = await executeTool("web_fetch", { url: `${base}/vecchio` }, ctx);
    expect(r.content).toContain("riga due");
    expect(r.content).toContain("redirected to");
  });

  it("uno schema che uscirebbe dal perimetro è rifiutato PRIMA della rete", async () => {
    const r = await executeTool("web_fetch", { url: "file:///etc/passwd" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("http");
    expect(r.content).toContain("read_file");
  });

  it("un URL che non è un URL lo dice, non esplode", async () => {
    const r = await executeTool("web_fetch", { url: "non un url" }, ctx);
    expect(r.isError).toBe(true);
  });

  it("un'immagine è nominata, non riversata addosso al modello", async () => {
    const r = await executeTool("web_fetch", { url: `${base}/png` }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("image/png");
  });

  it("un errore HTTP porta lo stato E la spiegazione del server", async () => {
    const r = await executeTool("web_fetch", { url: `${base}/rotto` }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("401");
    expect(r.content).toContain("nessuna chiave");
  });

  it("una pagina senza testo leggibile lo dichiara invece di tornare vuota", async () => {
    const r = await executeTool("web_fetch", { url: `${base}/spa` }, ctx);
    expect(r.content).toContain("JavaScript");
  });

  it("il tetto vale: mezzo mega non entra in un contesto", async () => {
    const r = await executeTool("web_fetch", { url: `${base}/grosso`, max_chars: 5_000 }, ctx);
    expect(r.content.length).toBeLessThan(6_000);
    expect(r.content).toContain("troncato");
  });

  it("un turno già annullato non apre la connessione e lo dice", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await executeTool("web_fetch", { url: `${base}/page` }, { ...ctx, signal: ac.signal });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("annullato");
  });
});
