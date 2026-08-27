/**
 * @covers MCPSRV-02
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

    const stato = mcpFleetStatus();
    const finto = stato.servers.find((s) => s.name === "finto")!;
    expect(finto.state).toBe("ready");
    expect(finto.transport).toBe("http");
    expect(finto.tools).toEqual(["mcp__finto__eco"]);
    expect(finto.skills).toEqual(["riassumi"]);
  });

  test("un server che non risponde resta nell'elenco con il suo motivo", async () => {
    writeConfig({
      finto: { type: "http", url: server.url.href },
      // Closed port: the connection fails, and only its own must fail.
      rotto: { type: "http", url: "http://127.0.0.1:1/mcp" },
    });
    await remountMcpFleet();

    const stato = mcpFleetStatus();
    expect(stato.servers.find((s) => s.name === "rotto")!.state).toBe("failed");
    expect(stato.servers.find((s) => s.name === "rotto")!.reason).toBeTruthy();
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

    const stato = mcpFleetStatus();
    const chrome = stato.servers.find((s) => s.name === "chrome-devtools")!;
    expect(chrome.state).toBe("excluded");
    expect(chrome.reason).toContain("exclusion list");
    const pesante = stato.servers.find((s) => s.name === "pesante")!;
    expect(pesante.state).toBe("excluded");
    expect(pesante.reason).toContain("prompt cache");
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
