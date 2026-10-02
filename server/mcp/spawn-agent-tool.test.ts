/**
 * `spawn_agent` at the standard of Claude Code's `Agent` tool, on the MCP
 * side: the schema it publishes, what it forwards to the route, and the
 * foreground wait in legs with a progress beat for each.
 * @covers SUBAGENT-08, SUBAGENT-09, SUBAGENT-13
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { callSpawnAgent, toolsForProfile } from "./topics-mcp-server";

const stubFetch = (impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => impl as typeof fetch;

describe("spawn_agent at the standard of the Agent tool (SUBAGENT-08, 09, 13)", () => {
  const profilesRoot = mkdtempSync(join(tmpdir(), "spawn-profiles-"));
  afterAll(() => rmSync(profilesRoot, { recursive: true, force: true }));

  test("the schema takes a model, a profile, an effort and run_in_background, and warns off haiku", () => {
    const spawn = toolsForProfile(undefined, "darwin", { home: profilesRoot, cwd: null }).find((t) => t.name === "spawn_agent")!;
    const props = (spawn.inputSchema as { properties: Record<string, { enum?: string[]; type?: string }> }).properties;
    expect(props.model?.enum).toEqual(["inherit", "sonnet", "opus", "fable", "haiku"]);
    expect(props.effort?.enum).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(props.run_in_background?.type).toBe("boolean");
    expect(props.agent_type?.type).toBe("string");
    expect(spawn.description).toContain("Never choose haiku on your own initiative");
  });

  test("agent_type lists the profiles visible when the tool list is served", () => {
    const dir = join(profilesRoot, ".claude", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "scout.md"), "---\nname: scout\ndescription: Cheap read-only sweep. More words.\n---\n");
    const spawn = toolsForProfile(undefined, "darwin", { home: profilesRoot, cwd: null }).find((t) => t.name === "spawn_agent")!;
    const agentTypeText = (spawn.inputSchema as { properties: Record<string, { description: string }> }).properties.agent_type!.description;
    expect(agentTypeText).toContain("- scout: Cheap read-only sweep.");
  });

  test("model, agent_type, effort and run_in_background reach the route, and the answer names what started", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = stubFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ agentId: "kid1", name: "scout", cwd: "/p", model: "sonnet", agentType: "scout", effort: "low", notify: "chat" }), { status: 200 });
    });
    const text = await callSpawnAgent(
      { baseUrl: "http://x", sessionKey: "topic:abc" },
      { prompt: "go", model: "sonnet", agent_type: "scout", effort: "low" },
      fetchImpl,
    );
    expect(bodies[0]).toEqual({ prompt: "go", model: "sonnet", agent_type: "scout", effort: "low" });
    expect(text).toContain("model=sonnet · agent_type=scout · effort=low");
    expect(text).toContain("its result will wake this chat");
  });

  test("a foreground spawn beats on every empty leg and returns the result when it comes", async () => {
    const urls: string[] = [];
    let waits = 0;
    const fetchImpl = stubFetch(async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/spawn")) return new Response(JSON.stringify({ agentId: "kid1", name: "scout", cwd: "/p", notify: "chat" }), { status: 200 });
      waits++;
      return new Response(JSON.stringify(waits < 3
        ? { status: "running", agentId: "kid1" }
        : { status: "done", agentId: "kid1", result: { agentId: "kid1", name: "scout", turn: 1, status: "completed", partial: false, text: "Report: 3 files", model: null, agentType: null, durationMs: null, cwd: "/p", branch: null } }), { status: 200 });
    });
    const beats: number[] = [];
    const text = await callSpawnAgent(
      { baseUrl: "http://x", sessionKey: "topic:abc" },
      { prompt: "go", run_in_background: false },
      fetchImpl,
      { onProgress: (leg) => beats.push(leg), legMs: 100 },
    );
    expect(beats).toEqual([1, 2]);
    expect(urls.filter((u) => u.includes("/wait?legMs=100")).length).toBe(3);
    expect(text).toContain('<subagent-result agent="scout" agent_id="kid1" turn="1" status="completed">');
    expect(text).toContain("Report: 3 files");
  });

  test("a foreground spawn still running at its deadline releases the hold and says the result will follow", async () => {
    const urls: string[] = [];
    let clock = 0;
    const fetchImpl = stubFetch(async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/spawn")) return new Response(JSON.stringify({ agentId: "kid1", name: "scout", notify: "chat" }), { status: 200 });
      clock += 1_000;
      return new Response(JSON.stringify({ status: "running", agentId: "kid1" }), { status: 200 });
    });
    const text = await callSpawnAgent(
      { baseUrl: "http://x", sessionKey: "topic:abc" },
      { prompt: "go", run_in_background: false },
      fetchImpl,
      { legMs: 1_000, foregroundMs: 2_500, now: () => clock },
    );
    expect(urls.at(-1)).toContain("/wait?release=1");
    expect(text).toContain("status=running");
    expect(text).toContain("its result will wake this chat");
  });

  test("a Stop of the native turn ends the wait at once and hands the result over to the chat", async () => {
    const turn = new AbortController();
    const urls: string[] = [];
    const fetchImpl = stubFetch(async (url, init) => {
      urls.push(String(url));
      if (String(url).endsWith("/spawn")) return new Response(JSON.stringify({ agentId: "kid1", name: "scout", cwd: "/p", notify: "chat" }), { status: 200 });
      if (String(url).includes("release=1")) return new Response(JSON.stringify({ status: "running", agentId: "kid1" }), { status: 200 });
      // The leg the user's Stop lands in: it is held open until its signal says otherwise.
      setTimeout(() => turn.abort(), 50);
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(new Response(JSON.stringify({ status: "running", agentId: "kid1" }), { status: 200 })), 2_000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); });
      });
    });
    const t0 = Date.now();
    const outcome = await callSpawnAgent(
      { baseUrl: "http://x", sessionKey: "topic:abc", turnSignal: turn.signal },
      { prompt: "go", run_in_background: false },
      fetchImpl,
      { legMs: 100, foregroundMs: 60_000 },
    ).then((text) => `resolved: ${text}`, (err: Error) => `threw: ${err.message}`);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(outcome).toStartWith("threw:");
    expect(outcome).toContain("its result will wake this chat");
    expect(urls.filter((u) => u.includes("/wait?legMs=")).length).toBe(1);
    expect(urls.at(-1)).toContain("/wait?release=1");
  });
});

