/**
 * A MAIL LEAVES ONCE, EVEN ACROSS A RESTART (agent mail change, bar E5).
 *
 * The bridge (`callSendMail`) and the route run for real against a fake CLI
 * that records every start in a file: the number of lines in that file is the
 * number of mails that would have left. The register is a real SQLite file, and
 * a "restart" is what a new process sees: a second connection on the same file,
 * a new router (whose boot step judges what was mid-send) and the in-memory maps
 * of the gate emptied.
 * @covers MAIL-08
 */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutboundRouter } from "../routes/outbound";
import { callSendMail } from "../mcp/outbound-tools";
import { CONFIRM_LABEL, confirmKey, _resetOutboundHolds } from "./outbound-gate";
import { cancelAsk, deliverAnswer } from "./ask-user-bridge";
import { _resetRoutedAsks } from "../services/board-ask-routing";
import { _resetTurnBodyFlushers } from "./turn-body-flush";
import { answerPendingMailFromThread, createMailLedger, messageIdOf, registerPendingMailAnswer } from "./outbound-mail-ledger";

const root = realpathSync(mkdtempSync(join(tmpdir(), "mail-once-")));
const LOG = join(root, "starts.log");
const STAGING = join(root, "staging");
const MIGRATIONS = join(import.meta.dir, "../db/migrations");
const SESSION = "topic:abcd1234";
const CARD = { id: "task-1", project_id: "project-1", assigned_topic_id: "topic-abcd1234" };

/** One line per start; `exit` and `sleep` shape the outcome. */
function installCli(name: string, opts: { exit?: number; sleep?: number } = {}): void {
  const file = join(root, name);
  writeFileSync(file, [
    "#!/bin/bash",
    `echo started >> "${LOG}"`,
    opts.sleep ? `sleep ${opts.sleep}` : "",
    `echo '{"id":"msg-'"$(wc -l < "${LOG}" | tr -d ' ')"'"}'`,
    `exit ${opts.exit ?? 0}`,
  ].join("\n"), "utf8");
  chmodSync(file, 0o755);
}
installCli("mail-ok");
installCli("mail-fail", { exit: 1 });
installCli("mail-slow", { sleep: 1 });

const envFor = (cli: string) => ({
  TOPICS_MAIL_CLI: cli,
  TOPICS_MAIL_ACCOUNT: "first",
  TOPICS_MAIL_FROM: "first@example.test",
  TOPICS_MAIL_ACCOUNTS: "first:first@example.test",
});
const starts = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).length : 0);

let dbFile = "";
function openRegister(): Database {
  const db = new Database(dbFile);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
  return db;
}
const opened: Database[] = [];

beforeEach(() => {
  dbFile = join(root, `register-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbFile);
  for (const file of ["20261126100000-scheduled-delivery.sql", "20261128061145-mail-sent-once.sql"]) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8").replace(/ALTER TABLE app_settings[^;]*;/g, ""));
  }
  db.close();
});
afterEach(() => {
  cancelAsk(SESSION, "end of test");
  _resetRoutedAsks(); _resetOutboundHolds(); _resetTurnBodyFlushers();
  registerPendingMailAnswer(null);
  for (const db of opened.splice(0)) db.close();
  if (existsSync(LOG)) unlinkSync(LOG);
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** One server process: its own connection on the register file and its own router. */
function boot(cli = "mail-ok") {
  const db = openRegister();
  opened.push(db);
  const comments: Array<{ id: string; content: string; options: string[] }> = [];
  const ctx = {
    db: {
      prepare: (sql: string) => ({ get: () => (String(sql).includes("FROM messages") ? undefined : CARD), all: () => [] }),
      query: () => ({ get: () => null }),
    },
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    matchRoute: (pathname: string, pattern: string): Record<string, string> | null => {
      const pp = pattern.split("/"); const xp = pathname.split("/");
      if (pp.length !== xp.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < pp.length; i++) {
        if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
        else if (pp[i] !== xp[i]) return null;
      }
      return params;
    },
    broadcastToAll: () => {},
    getTopicBySessionKey: (key: string) => ({ id: `topic-of-${key}`, sessionKey: key, projectPath: root }),
    updateToolCallFields: () => {},
  } as never;
  const ledger = createMailLedger(db);
  const router = createOutboundRouter(ctx, {
    env: envFor(cli), searchDirs: [root], stagingRoot: STAGING, cliTimeoutMs: 10_000, ledger,
    comment: (args) => { const id = `c-${comments.length + 1}`; comments.push({ id, content: args.content, options: args.options }); return id; },
  });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(String(url), init);
    const u = new URL(req.url);
    return (await router(req, u, u.pathname, req.method)) ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { db, ledger, router, comments, fetchImpl };
}

const ARGS = { baseUrl: "http://topics.test", sessionKey: SESSION };
const MESSAGE = { to: "someone@example.test", subject: "Quote", body: "Hello, the quote is attached." };
const LEGS = { legMs: 300, backoffMs: [5], transportGraceMs: 15_000 };
const questions = (comments: Array<{ content: string }>) => comments.filter((c) => /Confermi\? \(/.test(c.content));
const digestOf = (comments: Array<{ content: string }>) => /Confermi\? \(([0-9a-f]+)\)/.exec(questions(comments).at(-1)?.content ?? "")?.[1] ?? "";

/** Says yes to the newest question of the card as soon as one is on it. */
function confirmEachQuestion(comments: Array<{ content: string }>, seen = { n: 0 }): () => void {
  const timer = setInterval(() => {
    const asked = questions(comments).length;
    if (asked > seen.n) { seen.n = asked; deliverAnswer(SESSION, { [confirmKey(digestOf(comments))]: CONFIRM_LABEL }); }
  }, 15);
  return () => clearInterval(timer);
}

/** A raw leg, as the bridge sends it: the key of the call plus the hold of its previous leg. */
async function leg(server: ReturnType<typeof boot>, key: string, hold?: string) {
  const res = await server.fetchImpl(`${ARGS.baseUrl}/api/sessions/${SESSION}/outbound/mail`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...MESSAGE, key, legMs: 120, ...(hold ? { hold } : {}) }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("condition never met"); await Bun.sleep(20); }
}

describe("a mail leaves once", () => {
  test("restart between the send and its record: no second send, `unknown`, the card is told", async () => {
    const before = boot("mail-slow");
    const stop = confirmEachQuestion(before.comments);
    const call = callSendMail(ARGS, MESSAGE, before.fetchImpl, LEGS).catch((error: unknown) => error);
    // The CLI started and has not answered: this is where the process dies.
    await until(() => starts() === 1);
    stop();
    const key = (before.db.query("SELECT key FROM deliveries").get() as { key: string }).key;
    expect(before.ledger.registry.get(key)?.state).toBe("delivering");

    _resetOutboundHolds(); _resetRoutedAsks(); cancelAsk(SESSION, "restart");
    const after = boot();
    expect(after.ledger.registry.get(key)?.state).toBe("unknown");
    expect(after.comments.some((c) => c.content.startsWith("Invio forse partito"))).toBe(true);

    const again = await leg(after, key.slice("mail:".length));
    expect(again.body.unknown).toBe(true);
    await call;
    // The late answer of the dead process cannot overwrite what boot judged.
    expect(after.ledger.registry.get(key)?.state).toBe("unknown");
    expect(starts()).toBe(1);
    // And a third boot does not tell the card twice.
    expect(boot().comments.some((c) => c.content.startsWith("Invio forse partito"))).toBe(false);
  });

  test("confirmation given after a restart: the server sends from the row, once", async () => {
    const before = boot();
    const key = "call-after-restart-01";
    const first = await leg(before, key);
    expect(first.body.pending).toBe(true);
    expect(starts()).toBe(0);
    const askId = before.comments.find((c) => /Confermi\?/.test(c.content))!.id;

    _resetOutboundHolds(); _resetRoutedAsks(); cancelAsk(SESSION, "restart");
    const after = boot();
    expect(answerPendingMailFromThread(askId, CONFIRM_LABEL)).toBe(true);
    await until(() => after.ledger.registry.get(`mail:${key}`)?.state === "delivered");
    // A second click on the same question, and the bridge that still polls: nothing more leaves.
    expect(answerPendingMailFromThread(askId, CONFIRM_LABEL)).toBe(false);
    const polled = await leg(after, key);
    expect(polled.body.sent).toBe(true);
    expect(polled.body.messageId).toBe("msg-1");
    expect(starts()).toBe(1);
  });

  test("a no given after a restart closes the row and sends nothing", async () => {
    const before = boot();
    const key = "call-refused-0001";
    await leg(before, key);
    const askId = before.comments.find((c) => /Confermi\?/.test(c.content))!.id;
    _resetOutboundHolds(); _resetRoutedAsks(); cancelAsk(SESSION, "restart");
    const after = boot();
    expect(answerPendingMailFromThread(askId, "Annulla")).toBe(true);
    expect(after.ledger.registry.get(`mail:${key}`)?.state).toBe("not_delivered");
    expect((await leg(after, key)).body.refused).toBe(true);
    expect(starts()).toBe(0);
  });

  test("`failed` is final for its key: a retry starts nothing", async () => {
    const server = boot("mail-fail");
    const stop = confirmEachQuestion(server.comments);
    await expect(callSendMail(ARGS, MESSAGE, server.fetchImpl, LEGS)).rejects.toThrow(/send_failed|exited 1/);
    stop();
    const key = (server.db.query("SELECT key FROM deliveries").get() as { key: string }).key;
    expect(server.ledger.registry.get(key)?.state).toBe("delivery_failed");
    const again = await leg(server, key.slice("mail:".length));
    expect(again.status).toBe(502);
    expect(starts()).toBe(1);
  });
});

describe("one call, one question; two calls, two", () => {
  test("the same content asked twice is two questions and two mails", async () => {
    const server = boot();
    const stop = confirmEachQuestion(server.comments);
    const a = await callSendMail(ARGS, MESSAGE, server.fetchImpl, LEGS);
    const b = await callSendMail(ARGS, MESSAGE, server.fetchImpl, LEGS);
    stop();
    expect(a).toContain("Message id: msg-1");
    expect(b).toContain("Message id: msg-2");
    expect(questions(server.comments)).toHaveLength(2);
    expect(starts()).toBe(2);
  });

  test("a call whose answer is lost retries with its key: one question, one mail", async () => {
    const server = boot();
    const stop = confirmEachQuestion(server.comments);
    let dropped = false;
    // The send happens on the server, and the socket dies before its answer arrives.
    const dropOnce = (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await server.fetchImpl(url, init);
      const peek = await res.clone().json() as Record<string, unknown>;
      if (peek.sent && !dropped) { dropped = true; throw new TypeError("socket hang up"); }
      return res;
    }) as typeof fetch;
    const out = await callSendMail(ARGS, MESSAGE, dropOnce, LEGS);
    stop();
    expect(dropped).toBe(true);
    expect(out).toContain("Message id: msg-1");
    expect(questions(server.comments)).toHaveLength(1);
    expect(starts()).toBe(1);
  });
});

describe("messageIdOf", () => {
  test("reads `id` or `messageId`, and nothing from text that is not JSON", () => {
    expect(messageIdOf('{"id":"18c2f","threadId":"t"}')).toBe("18c2f");
    expect(messageIdOf('log line\n{"messageId":"<a@b>"}')).toBe("<a@b>");
    expect(messageIdOf("sent")).toBeUndefined();
  });
});
