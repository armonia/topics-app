import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/ping-two-turns.json";
import { CloudApi, type CloudEvent, type FetchLike } from "./api";
import { applyEvent, newTurnState } from "./events";
import { CloudSessionRunner } from "./session";
import type { StreamHandler } from "../types";

function recorder() {
  const log: string[] = [];
  const h = {
    onTextDelta: (d: string) => log.push(`text:${d}`),
    onToolStart: (id: string, name: string) => log.push(`tool:${id}:${name}`),
    onToolResult: (id: string, r: string, err?: boolean) => log.push(`result:${id}:${err ? "err" : "ok"}:${r}`),
    onDone: () => log.push("done"),
    onError: (e: string) => log.push(`error:${e}`),
  } as unknown as StreamHandler;
  return { log, h };
}

/** API finta: serve una coda di pagine di eventi e registra ciò che riceve. */
function fakeApi(pages: CloudEvent[][], opts: { failAfter?: number } = {}) {
  const posts: unknown[] = [];
  let served = 0;
  const f: FetchLike = async (url, init) => {
    const path = url.replace("https://api.anthropic.com", "");
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (path === "/v1/environment_providers") return json({ environments: [{ environment_id: "env_x", kind: "anthropic_cloud", state: "active" }] });
    if (init?.method === "POST" && path === "/v1/sessions") { posts.push(JSON.parse(String(init.body))); return json({ id: "session_t" }); }
    if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return json({}); }
    if (path.startsWith("/v1/sessions/session_t/events")) {
      if (opts.failAfter !== undefined && served >= opts.failAfter) throw new Error("rete giù");
      const data = pages[served++] ?? [];
      return json({ data, has_more: false, ...(data.length ? { last_id: String(data.at(-1)!.uuid ?? served) } : {}) });
    }
    return new Response("?", { status: 404 });
  };
  return { api: new CloudApi(async () => ({ accessToken: "t", orgUuid: "o" }), f), posts };
}

const base = { source: { repo: "armonia/topics-app", revision: "main" }, deliveryBranch: "claude/x", model: "claude-sonnet-5-5", pollMs: 1 };

describe("events: sessione vera registrata il 26/10", () => {
  test("due turni: testo e fine di ognuno", () => {
    const { log, h } = recorder();
    let st = newTurnState();
    for (const ev of fixture as CloudEvent[]) {
      if (ev.type === "user") st = newTurnState();
      applyEvent(ev, st, h);
    }
    expect(log).toEqual(["text:ok", "done", "text:ok2", "done"]);
  });
});

describe("runner", () => {
  test("crea la sessione col payload della CLI e finisce sul result", async () => {
    const { api, posts } = fakeApi([
      [{ type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } }],
      [{ type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "file" }] } }],
      [
        { type: "system", subtype: "code_change_published", uuid: "s1", branch: "claude/x", url: "https://github.com/armonia/topics-app/pull/1" },
        { type: "result", subtype: "success", uuid: "r1", result: "fatto" },
      ],
    ]);
    const { log, h } = recorder();
    const r = await new CloudSessionRunner(api).sendTurn("card-1", "fai x", h, base);
    expect(r).toEqual({ sessionId: "session_t", outcome: "done", deliveredBranch: "claude/x", deliveredUrl: "https://github.com/armonia/topics-app/pull/1" });
    expect(log).toEqual(["tool:tu1:Bash", "result:tu1:ok:file", "done"]);
    const create = posts[0] as { session_context: { sources: Array<{ type: string; url: string; revision: string }> }; environment_id: string };
    expect(create.session_context.sources[0]).toEqual({ type: "git_repository", url: "https://github.com/armonia/topics-app", revision: "main" });
    expect(create.environment_id).toBe("env_x");
  });

  test("un permesso chiesto torna come control_response", async () => {
    const { api, posts } = fakeApi([
      [{ type: "control_request", uuid: "c1", request_id: "req_1", request: { tool_name: "Bash", input: { command: "rm x" } } }],
      [{ type: "result", subtype: "success", uuid: "r1" }],
    ]);
    const { h } = recorder();
    await new CloudSessionRunner(api).sendTurn("card-2", "fai y", h, { ...base, onPermission: async () => ({ allow: true }) });
    const resp = (posts[1] as { events: Array<{ type: string; response: { request_id: string; response: { behavior: string } } }> }).events[0];
    expect(resp.type).toBe("control_response");
    expect(resp.response.request_id).toBe("req_1");
    expect(resp.response.response.behavior).toBe("allow");
  });

  // Mutazione della barra: il polling smette di vedere eventi a metà sessione.
  // La card deve risultare ferma, mai consegnata.
  test("polling morto a metà = stalled, mai done", async () => {
    const { api } = fakeApi(
      [[{ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "inizio" }] } }]],
      { failAfter: 1 },
    );
    const { log, h } = recorder();
    const r = await new CloudSessionRunner(api).sendTurn("card-3", "fai z", h, { ...base, stallMs: 30 });
    expect(r.outcome).toBe("stalled");
    expect(log).not.toContain("done");
  });

  test("il secondo turno scrive alla stessa sessione", async () => {
    const { api, posts } = fakeApi([
      [{ type: "result", subtype: "success", uuid: "r1" }],
      [],
      [{ type: "result", subtype: "success", uuid: "r2" }],
    ]);
    const run = new CloudSessionRunner(api);
    const { h } = recorder();
    await run.sendTurn("card-4", "uno", h, base);
    await run.sendTurn("card-4", "due", h, base);
    const msg = (posts[1] as { events: Array<{ type: string; message: { content: string } }> }).events[0];
    expect(msg.type).toBe("user");
    expect(msg.message.content).toBe("due");
  });
});
