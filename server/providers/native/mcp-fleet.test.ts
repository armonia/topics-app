/**
 * @covers MCPSRV-02
 * @covers MCPSRV-03
 *
 * The native runtime mounts the globally configured MCP servers.
 *
 * THE TEST THAT WAS RED. Before `mcp-fleet.ts` this file's first assertion was
 * the whole bug: a config with a working server, a native runtime asking for
 * its tool registry, and nothing with an `mcp__` prefix in it. The servers were
 * resolved and then read by nobody, because the mounting lived on the CLI
 * branch only.
 *
 * The fake server here speaks real JSON-RPC over both transports the fleet
 * supports, so what is proved is the handshake and the call, not a stub.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyPromptCache, countCacheBreakpoints, MAX_CACHE_BREAKPOINTS } from "../prompt-cache";
import {
  remountMcpFleet,
  closeMcpFleet,
  mcpToolSpecs,
  executeMcpTool,
  mcpFleetStatus,
  mcpToolName,
  isMcpTool,
} from "./mcp-fleet";
import { decide } from "./permissions";

const PROTOCOL = "2024-11-05";

/** A minimal MCP server over Streamable HTTP: initialize, tools/list, tools/call. */
function startFakeHttpServer() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const msg = (await req.json()) as { id?: number; method: string; params?: { arguments?: { text?: string } } };
      if (msg.id === undefined) return new Response(null, { status: 202 }); // notification
      const reply = (result: unknown) =>
        Response.json({ jsonrpc: "2.0", id: msg.id, result });
      switch (msg.method) {
        case "initialize":
          return reply({
            protocolVersion: PROTOCOL,
            capabilities: { tools: {}, prompts: {} },
            serverInfo: { name: "finto", version: "0.0.1" },
          });
        case "tools/list":
          return reply({
            tools: [
              {
                name: "eco",
                description: "Ripete quello che gli si dice.",
                inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
              },
            ],
          });
        case "prompts/list":
          return reply({ prompts: [{ name: "riassumi", description: "una skill del server" }] });
        case "tools/call":
          return reply({ content: [{ type: "text", text: `eco: ${msg.params?.arguments?.text ?? ""}` }] });
        default:
          return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
      }
    },
  });
}

let server: ReturnType<typeof startFakeHttpServer>;
let dir: string;
const envBackup: Record<string, string | undefined> = {};

function writeConfig(servers: Record<string, unknown>): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ mcpServers: servers }));
}

beforeAll(() => {
  for (const k of ["TOPICS_MCP_CONFIG_FILE", "TOPICS_NATIVE_MCP", "TOPICS_SESSION_MCP_ALLOW", "TOPICS_SESSION_MCP_DENY", "TOPICS_SESSION_MCP_INHERIT_ALL"]) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
  server = startFakeHttpServer();
  dir = mkdtempSync(join(tmpdir(), "mcp-fleet-"));
  process.env.TOPICS_MCP_CONFIG_FILE = join(dir, "config.json");
});

afterAll(() => {
  closeMcpFleet();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("la flotta MCP del runtime nativo", () => {
  test("monta un server http e appende i suoi tool con il prefisso mcp__", async () => {
    writeConfig({ finto: { type: "http", url: server.url.href } });
    await remountMcpFleet();

    const names = mcpToolSpecs().map((t) => t.name);
    expect(names).toContain("mcp__finto__eco");
    const spec = mcpToolSpecs().find((t) => t.name === "mcp__finto__eco")!;
    expect(spec.input_schema.properties).toHaveProperty("text");
    expect(spec.input_schema.required).toEqual(["text"]);
  });

  test("esegue il tool montato passando per il server vero", async () => {
    writeConfig({ finto: { type: "http", url: server.url.href } });
    await remountMcpFleet();

    const out = await executeMcpTool("mcp__finto__eco", { text: "ciao" });
    expect(out.isError).toBeFalsy();
    expect(out.content).toBe("eco: ciao");
  });

  test("lo stato dice cosa è montato, con tool e skill", async () => {
    writeConfig({ finto: { type: "http", url: server.url.href } });
    await remountMcpFleet();

    const status = mcpFleetStatus();
    const fakeServer = status.servers.find((s) => s.name === "finto")!;
    expect(fakeServer.state).toBe("ready");
    expect(fakeServer.transport).toBe("http");
    expect(fakeServer.tools).toEqual(["mcp__finto__eco"]);
    expect(fakeServer.skills).toEqual(["riassumi"]);
  });

  test("un server che non risponde resta nell'elenco con il suo motivo", async () => {
    writeConfig({
      finto: { type: "http", url: server.url.href },
      // Closed port: the connection fails, and only its own must fail.
      rotto: { type: "http", url: "http://127.0.0.1:1/mcp" },
    });
    await remountMcpFleet();

    const status = mcpFleetStatus();
    expect(status.servers.find((s) => s.name === "rotto")!.state).toBe("failed");
    expect(status.servers.find((s) => s.name === "rotto")!.reason).toBeTruthy();
    // The other server is mounted all the same: one failure does not cost the fleet.
    expect(mcpToolSpecs().map((t) => t.name)).toContain("mcp__finto__eco");
  });

  test("un server escluso dalla regola compare con il perché, non sparisce", async () => {
    writeConfig({
      finto: { type: "http", url: server.url.href },
      "chrome-devtools": { type: "stdio", command: "node", args: ["x.js"] },
      pesante: { type: "stdio", command: "npx", args: ["-y", "qualcosa"] },
    });
    await remountMcpFleet();

    const status = mcpFleetStatus();
    const chrome = status.servers.find((s) => s.name === "chrome-devtools")!;
    expect(chrome.state).toBe("excluded");
    expect(chrome.reason).toContain("exclusion list");
    const heavy = status.servers.find((s) => s.name === "pesante")!;
    expect(heavy.state).toBe("excluded");
    expect(heavy.reason).toContain("prompt cache");
  });

  test("monta anche un server stdio, con il suo processo figlio vero", async () => {
    // A seven line MCP server on stdin/stdout: what matters is that the
    // transport is the real one, not an in-process fake.
    const script = join(dir, "stdio-server.mjs");
    writeFileSync(
      script,
      [
        "let buf = '';",
        "process.stdin.setEncoding('utf-8');",
        "process.stdin.on('data', (c) => {",
        "  buf += c; let nl;",
        "  while ((nl = buf.indexOf('\\n')) !== -1) {",
        "    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);",
        "    if (!line.trim()) continue;",
        "    const m = JSON.parse(line);",
        "    if (m.id === undefined) continue;",
        "    const r = m.method === 'initialize'",
        `      ? { protocolVersion: '${PROTOCOL}', capabilities: { tools: {} }, serverInfo: { name: 'tubo' } }`,
        "      : m.method === 'tools/list'",
        "        ? { tools: [{ name: 'somma', description: 'a + b', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }] }",
        "        : { content: [{ type: 'text', text: String((m.params.arguments.a ?? 0) + (m.params.arguments.b ?? 0)) }] };",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: r }) + '\\n');",
        "  }",
        "});",
      ].join("\n"),
    );
    writeConfig({ tubo: { type: "stdio", command: process.execPath, args: ["run", script] } });
    await remountMcpFleet();

    expect(mcpToolSpecs().map((t) => t.name)).toContain("mcp__tubo__somma");
    const out = await executeMcpTool("mcp__tubo__somma", { a: 2, b: 3 });
    expect(out.content).toBe("5");
    expect(out.isError).toBeFalsy();
  });

  test("il nome è sanificato: un server con caratteri strani resta chiamabile", () => {
    expect(mcpToolName("my server.io", "get/thing")).toBe("mcp__my_server_io__get_thing");
    expect(isMcpTool("mcp__my_server_io__get_thing")).toBe(true);
    expect(isMcpTool("read_file")).toBe(false);
  });
});

describe("i tool MCP passano dal cancello dei permessi", () => {
  test("in «chiedi prima» un tool MCP non esegue, e l'agente legge perché", () => {
    const verdict = decide("mcp__finto__eco", { text: "ciao" }, "ask");
    expect(verdict.allow).toBe(false);
  });

  test("in auto-apply passa come gli altri", () => {
    expect(decide("mcp__finto__eco", { text: "ciao" }, "auto-apply").allow).toBe(true);
  });

  test("un nome che imita un tool di sola lettura non salta il livello", () => {
    // `read_file` is always allowed; `mcp__x__read_file` is not: it comes from outside.
    expect(decide("read_file", {}, "ask").allow).toBe(true);
    expect(decide("mcp__x__read_file", {}, "ask").allow).toBe(false);
  });
});


/**
 * A server whose tool list GROWS: this is the gateway in miniature.
 *
 * Calling `mount` makes `search` appear in the next `tools/list`, exactly the
 * way a gateway child does. `listHits` counts the list calls, so a test can
 * prove the re-list happened once and only on the server that asked for it.
 */
function startGrowingServer(declaresListChanged: boolean) {
  let grown = false;
  let listHits = 0;
  const listener = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const msg = (await req.json()) as { id?: number; method: string; params?: { name?: string } };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
      switch (msg.method) {
        case "initialize":
          return reply({
            protocolVersion: PROTOCOL,
            capabilities: {
              tools: declaresListChanged ? { listChanged: true } : {},
              prompts: {},
            },
            serverInfo: { name: "growing", version: "0.0.1" },
          });
        case "tools/list": {
          listHits += 1;
          const tools: unknown[] = [
            { name: "mount", description: "Mounts a child.", inputSchema: { type: "object", properties: {} } },
          ];
          if (grown) {
            tools.push({
              name: "search",
              description: "Exists only after mount.",
              inputSchema: { type: "object", properties: {} },
            });
          }
          return reply({ tools });
        }
        case "prompts/list":
          return reply({ prompts: [] });
        case "tools/call":
          if (msg.params?.name === "mount") grown = true;
          return reply({ content: [{ type: "text", text: "ok" }] });
        default:
          return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
      }
    },
  });
  return {
    url: listener.url.href,
    hits: () => listHits,
    stop: () => listener.stop(true),
    reset: () => { grown = false; listHits = 0; },
  };
}

describe("la lista degli strumenti di un server e viva", () => {
  let growing: ReturnType<typeof startGrowingServer>;
  let quiet: ReturnType<typeof startGrowingServer>;

  beforeAll(() => {
    growing = startGrowingServer(true);
    quiet = startGrowingServer(false);
  });

  afterAll(() => {
    growing.stop();
    quiet.stop();
  });

  test("uno strumento che monta un figlio lo rende chiamabile subito", async () => {
    growing.reset();
    writeConfig({ growing: { type: "http", url: growing.url } });
    await remountMcpFleet();

    // The state the agent starts from: the child does not exist yet.
    expect(mcpToolSpecs().map((t) => t.name)).toEqual(["mcp__growing__mount"]);

    const mounted = await executeMcpTool("mcp__growing__mount", {});
    expect(mounted.isError).toBeFalsy();

    // THE BUG, in one line: on HEAD this says only `mcp__growing__mount`, and
    // the call below answers `unknown MCP tool: mcp__growing__search`.
    expect(mcpToolSpecs().map((t) => t.name)).toContain("mcp__growing__search");

    const used = await executeMcpTool("mcp__growing__search", {});
    expect(used.isError).toBeFalsy();
  });

  test("il ri-elenco costa una chiamata sola, e solo a chi lo dichiara", async () => {
    growing.reset();
    quiet.reset();
    writeConfig({
      growing: { type: "http", url: growing.url },
      quiet: { type: "http", url: quiet.url },
    });
    await remountMcpFleet();
    expect(growing.hits()).toBe(1);
    expect(quiet.hits()).toBe(1);

    await executeMcpTool("mcp__growing__mount", {});
    await executeMcpTool("mcp__quiet__mount", {});

    // One extra list for the server that declared it, none for the other.
    expect(growing.hits()).toBe(2);
    expect(quiet.hits()).toBe(1);
  });

  test("un ri-elenco non sposta i tool degli altri server", async () => {
    growing.reset();
    quiet.reset();
    writeConfig({
      alpha: { type: "http", url: server.url.href },
      growing: { type: "http", url: growing.url },
      quiet: { type: "http", url: quiet.url },
    });
    await remountMcpFleet();
    const before = mcpToolSpecs().map((t) => t.name);

    await executeMcpTool("mcp__growing__mount", {});
    const after = mcpToolSpecs().map((t) => t.name);

    expect(after).toEqual([...after].sort());
    expect(after.filter((n) => !n.startsWith("mcp__growing__"))).toEqual(
      before.filter((n) => !n.startsWith("mcp__growing__")),
    );
    const grownStatus = mcpFleetStatus().servers.find((s) => s.name === "growing")!;
    expect(grownStatus.tools).toContain("mcp__growing__search");
  });

  test("gli schemi consegnati al modello non tornano marchiati", async () => {
    growing.reset();
    writeConfig({ growing: { type: "http", url: growing.url } });
    await remountMcpFleet();

    // `applyPromptCache` marks the LAST tool in place. If the registry hands
    // out its stored objects, that marker sticks to the fleet itself and every
    // later read carries it, so the breakpoints pile up until the API refuses
    // the whole turn for having more than MAX_CACHE_BREAKPOINTS of them.
    const round = () => {
      const params = {
        model: "m",
        max_tokens: 1,
        system: "s",
        messages: [{ role: "user" as const, content: "hi" }],
        tools: mcpToolSpecs() as never,
      };
      applyPromptCache(params);
      return countCacheBreakpoints(params);
    };

    const first = round();
    await executeMcpTool("mcp__growing__mount", {});
    const second = round();
    const third = round();

    expect(mcpToolSpecs().some((t) => "cache_control" in t)).toBe(false);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(third).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
  });
});
