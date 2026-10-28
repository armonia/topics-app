/**
 * La rotta di invio verso i terminali: il terminale sparito è 404, il terminale
 * che c'è ma non accetta testo senza Invio (Terminal.app) è 422 con il motivo.
 * Con il 404 di prima, chi scriveva credeva che il terminale fosse sparito.
 */
import { test, expect } from "bun:test";
import { createLiveTerminalsRouter } from "./live-terminals";
import { createLiveTerminals, type Runner } from "../lib/live-terminals";
import type { AppContext } from "../types";

const ctx = {
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
  errorResponse: (status: number, message: string) =>
    new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } }),
  readJSON: async (req: Request) => req.json(),
} as unknown as AppContext;

/** Un servizio vero sopra un runner finto: si vede cosa arriva a osascript. */
function terminalService(osascriptAnswer: string) {
  const calls: Array<[string, string[]]> = [];
  const run: Runner = async (file, args) => {
    calls.push([file, args]);
    return file === "osascript" ? osascriptAnswer : "";
  };
  const svc = createLiveTerminals({
    topics: () => [], topicsScreen: async () => null, topicsSend: () => true,
    run, sources: { tmux: false, terminal: true },
  });
  return { svc, calls };
}

async function postSend(svc: ReturnType<typeof createLiveTerminals>, id: string, body: unknown) {
  const route = createLiveTerminalsRouter(ctx, svc);
  const url = new URL(`https://127.0.0.1/api/live-terminals/${encodeURIComponent(id)}/send`);
  const req = new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const res = await route(req, url, url.pathname, "POST");
  if (!res) throw new Error("la rotta non ha risposto");
  return { status: res.status, body: await res.json() };
}

test("Terminal.app: testo senza Invio è 422 col motivo, e non arriva a osascript", async () => {
  const { svc, calls } = terminalService("ok");
  const r = await postSend(svc, "terminal:ttys004", { text: "prova", enter: false });
  expect(r.status).toBe(422);
  expect(r.body.error).toContain("Terminal.app");
  expect(calls.some(([f]) => f === "osascript")).toBe(false);
});

test("Terminal.app: testo con Invio è 200 e arriva a osascript", async () => {
  const { svc, calls } = terminalService("ok");
  const r = await postSend(svc, "terminal:ttys004", { text: "prova", enter: true });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true });
  expect(calls.at(-1)?.[1].slice(-2)).toEqual(["/dev/ttys004", "prova"]);
});

test("Terminal.app: il terminale sparito resta 404", async () => {
  const { svc } = terminalService("missing");
  const r = await postSend(svc, "terminal:ttys004", { text: "prova" });
  expect(r.status).toBe(404);
  expect(r.body.error).toBe("terminal not found");
});
