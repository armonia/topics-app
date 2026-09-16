/**
 * THE TWO DOORS THAT LEAVE THE MACHINE, tested against a fake executable.
 *
 * Nothing is ever sent: `TOPICS_MAIL_CLI` and `TOPICS_GOOGLE_CLI` point at a
 * script that records `argv` in a temporary file and exits. That file is also
 * the NEGATIVE proof, which matters more: if it does not exist, no process was
 * started.
 *
 * The human rendez-vous runs FOR REAL (in-memory maps), as in
 * `permission.test.ts`: it is exactly what is being measured here.
 *
 * The regressions it watches:
 *   - a spawn BEFORE the confirmation (the order is everything: a message that
 *     left cannot be recalled);
 *   - an undeclared account quietly swapped for the default one;
 *   - an attachment that resolves outside the workspace, i.e. mail as an
 *     exfiltration path;
 *   - a Google read that asks for confirmation (noise) or a write that does not
 *     (damage);
 *   - a send that leaves no trace on the card, or one that pastes the body into
 *     it.
  * @covers OUTBOUND-04
  * @covers OUTBOUND-05
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutboundRouter, googleCallWrites } from "./outbound";
import { CONFIRM_LABEL, REFUSE_LABEL, confirmKey } from "../lib/outbound-gate";
import { deliverAnswer, cancelAsk } from "../lib/ask-user-bridge";
import { _resetRoutedAsks } from "../services/board-ask-routing";
import { payloadDigest } from "./outbound";

const root = mkdtempSync(join(tmpdir(), "outbound-route-"));
const LOG = join(root, "calls.log");
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
afterEach(() => { _resetRoutedAsks(); if (existsSync(LOG)) unlinkSync(LOG); });

/** The stand-in for `gws-mail` and `gws`: it records argv and sends nothing. */
function installFakeCli(name: string): string {
  const file = join(root, name);
  writeFileSync(
    file,
    ["#!/bin/bash", `LOG="${LOG}"`, `printf "%s\\0" "${name}" >> "$LOG"`, 'for a in "$@"; do printf "%s\\0" "$a" >> "$LOG"; done', 'echo "{\\"ok\\":true}"', "exit 0"].join("\n"),
    "utf8",
  );
  chmodSync(file, 0o755);
  return file;
}
installFakeCli("fake-mail");
installFakeCli("fake-google");

const recorded = (): string[] => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\0").slice(0, -1) : []);

const ENV = {
  TOPICS_MAIL_CLI: "fake-mail",
  TOPICS_MAIL_ACCOUNT: "primo",
  TOPICS_MAIL_FROM: "primo@esempio.test",
  TOPICS_MAIL_ACCOUNTS: "primo:primo@esempio.test,secondo:secondo@esempio.test",
  TOPICS_GOOGLE_CLI: "fake-google",
  TOPICS_GOOGLE_CONFIG_DIR: join(root, "gws-config"),
  TOPICS_GOOGLE_CLIENT_SECRET: join(root, "client_secret.json"),
};

const CARD = { id: "task-1", project_id: "project-1", assigned_topic_id: "topic-abcd1234" };

function makeHarness(options: { env?: Record<string, string>; card?: boolean; workspace?: string } = {}) {
  const comments: Array<{ taskId: string; content: string }> = [];
  const ctx = {
    db: {
      prepare: () => ({ get: () => (options.card === false ? undefined : CARD) }),
      query: () => ({ get: () => null }),
    },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    matchRoute: (pathname: string, pattern: string): Record<string, string> | null => {
      const pp = pattern.split("/");
      const xp = pathname.split("/");
      if (pp.length !== xp.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < pp.length; i++) {
        if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
        else if (pp[i] !== xp[i]) return null;
      }
      return params;
    },
    broadcastToAll: () => {},
    getTopicBySessionKey: (key: string) => ({ id: `topic-of-${key}`, sessionKey: key, projectPath: options.workspace ?? root }),
    updateToolCallFields: () => {},
  } as never;
  const router = createOutboundRouter(ctx, {
    env: options.env ?? ENV,
    searchDirs: [root],
    cliTimeoutMs: 10_000,
    comment: (args) => { comments.push({ taskId: args.taskId, content: args.content }); return true; },
  });
  const call = (path: string, body: unknown) => {
    const url = new URL(`http://topics.test${path}`);
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return router(req, url, url.pathname, "POST") as Promise<Response | null>;
  };
  return { call, comments };
}

const mailPath = (sessionKey: string) => `/api/sessions/${sessionKey}/outbound/mail`;
const googlePath = (sessionKey: string) => `/api/sessions/${sessionKey}/outbound/google`;

const message = {
  to: "destinatario@esempio.test",
  subject: "Preventivo",
  body: "Ciao, in allegato il preventivo.",
  legMs: 150,
};

describe("POST /outbound/mail", () => {
  test("senza conferma NON parte niente: `pending` e nessun processo", async () => {
    const h = makeHarness();
    const resp = (await h.call(mailPath("topic:abcd1234"), message))!;
    expect(await resp.json()).toEqual({ pending: true });
    expect(recorded()).toEqual([]);
    cancelAsk("topic:abcd1234", "fine del test");
  });

  test("con la conferma parte, per ARGV, e l'iniezione resta un argomento", async () => {
    const h = makeHarness();
    const sessionKey = "topic:abcd1235";
    const injected = {
      to: "vittima@esempio.test; rm -rf /tmp/qualcosa",
      subject: 'Oggetto "con virgolette"\ne un a capo',
      body: "corpo con $(touch /tmp/mai-eseguito)",
      legMs: 400,
    };
    const digest = payloadDigest(["primo", injected.to, injected.subject, injected.body, "", []]);
    setTimeout(() => { deliverAnswer(sessionKey, { [confirmKey(digest)]: CONFIRM_LABEL }); }, 20);
    const resp = (await h.call(mailPath(sessionKey), injected))!;
    const body = await resp.json() as Record<string, unknown>;
    expect(body.sent).toBe(true);
    expect(body.account).toBe("primo");
    const args = recorded();
    expect(args[0]).toBe("fake-mail");
    expect(args.slice(1, 5)).toEqual(["primo", "gmail", "+send", "--to"]);
    // One argument, literal: no shell in between.
    expect(args[5]).toBe(injected.to);
    expect(args[7]).toBe(injected.subject);
    expect(args[9]).toBe(injected.body);
    expect(existsSync("/tmp/mai-eseguito")).toBe(false);
  });

  test("l'invio riuscito lascia la traccia sulla card, e il corpo NON ci finisce", async () => {
    const h = makeHarness();
    const sessionKey = "topic:abcd1236";
    const digest = payloadDigest(["primo", message.to, message.subject, message.body, "", []]);
    setTimeout(() => { deliverAnswer(sessionKey, { [confirmKey(digest)]: CONFIRM_LABEL }); }, 20);
    const resp = (await h.call(mailPath(sessionKey), message))!;
    expect((await resp.json() as Record<string, unknown>).traced).toBe(true);
    // Two comments: the question and then the trace. The trace is the last.
    expect(h.comments).toHaveLength(2);
    const line = h.comments[1].content;
    expect(line).toContain("primo");
    expect(line).toContain(message.to);
    expect(line).toContain(message.subject);
    expect(line).not.toContain(message.body);
  });

  test("un rifiuto non manda niente e lascia comunque la sua riga", async () => {
    const h = makeHarness();
    const sessionKey = "topic:abcd1237";
    const digest = payloadDigest(["primo", message.to, message.subject, message.body, "", []]);
    setTimeout(() => { deliverAnswer(sessionKey, { [confirmKey(digest)]: REFUSE_LABEL }); }, 20);
    const resp = (await h.call(mailPath(sessionKey), message))!;
    const body = await resp.json() as Record<string, unknown>;
    expect(body.refused).toBe(true);
    expect(recorded()).toEqual([]);
    expect(h.comments.at(-1)?.content).toContain("NON partito");
  });

  test("un account non dichiarato e' rifiutato PRIMA della conferma, e non diventa il default", async () => {
    const h = makeHarness();
    const resp = (await h.call(mailPath("topic:abcd1238"), { ...message, account: "terzo" }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json() as Record<string, unknown>).code).toBe("unknown_account");
    expect(recorded()).toEqual([]);
  });

  test("una variabile mancante dice QUALE, e non apre nessuna domanda", async () => {
    const env = { ...ENV } as Record<string, string>;
    delete env.TOPICS_MAIL_ACCOUNTS;
    const h = makeHarness({ env });
    const resp = (await h.call(mailPath("topic:abcd1239"), message))!;
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.variable).toBe("TOPICS_MAIL_ACCOUNTS");
    expect(recorded()).toEqual([]);
  });

  test("an attachment that EXISTS but sits outside the workspace is refused for THAT reason", async () => {
    // The file is real and readable: if containment stopped working, the send
    // would go through. A path that merely does not exist would be refused by
    // the existence check too, and the test would pass with the gate removed.
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(root, "segreto.txt"), "chiave privata finta", "utf8");
    const h = makeHarness({ workspace });
    const resp = (await h.call(mailPath("topic:abcd1240"), { ...message, attachments: ["../segreto.txt"] }))!;
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.code).toBe("attachment_refused");
    expect(String(body.error)).toContain("outside");
    expect(recorded()).toEqual([]);
  });

  test("an attachment INSIDE the workspace reaches the CLI as -a <absolute path>", async () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const attached = join(workspace, "preventivo.pdf");
    writeFileSync(attached, "%PDF-finto", "utf8");
    const h = makeHarness({ workspace });
    const sessionKey = "topic:abcd1246";
    const digest = payloadDigest(["primo", message.to, message.subject, message.body, "", [attached]]);
    setTimeout(() => { deliverAnswer(sessionKey, { [confirmKey(digest)]: CONFIRM_LABEL }); }, 20);
    const resp = (await h.call(mailPath(sessionKey), { ...message, attachments: ["preventivo.pdf"], legMs: 400 }))!;
    expect((await resp.json() as Record<string, unknown>).sent).toBe(true);
    const args = recorded();
    expect(args).toContain("--attach");
    expect(args).toContain(attached);
  });

  test("un messaggio senza oggetto non arriva nemmeno alla conferma", async () => {
    const h = makeHarness();
    const resp = (await h.call(mailPath("topic:abcd1241"), { ...message, subject: "  " }))!;
    expect(resp.status).toBe(400);
    expect(recorded()).toEqual([]);
  });
});

describe("POST /outbound/google", () => {
  test("una LETTURA non chiede niente e risponde subito", async () => {
    const h = makeHarness();
    const resp = (await h.call(googlePath("topic:abcd1242"), {
      service: "calendar", resource: "events", method: "list", params: { calendarId: "primary" },
    }))!;
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    const args = recorded();
    expect(args.slice(0, 5)).toEqual(["fake-google", "calendar", "events", "list", "--params"]);
    expect(args[5]).toBe(JSON.stringify({ calendarId: "primary" }));
    // No confirmation for a read, and therefore no trace to leave.
    expect(h.comments).toHaveLength(0);
  });

  test("una SCRITTURA aspetta la persona: `pending` e nessun processo", async () => {
    const h = makeHarness();
    const sessionKey = "topic:abcd1243";
    const resp = (await h.call(googlePath(sessionKey), {
      service: "calendar", resource: "events", method: "insert", body: { summary: "riunione" }, legMs: 150,
    }))!;
    expect(await resp.json()).toEqual({ pending: true });
    expect(recorded()).toEqual([]);
    cancelAsk(sessionKey, "fine del test");
  });

  test("una scrittura confermata esegue e lascia la traccia", async () => {
    const h = makeHarness();
    const sessionKey = "topic:abcd1244";
    const digest = payloadDigest(["calendar", "events", "", "insert", null, JSON.stringify({ summary: "riunione" })]);
    setTimeout(() => { deliverAnswer(sessionKey, { [confirmKey(digest)]: CONFIRM_LABEL }); }, 20);
    const resp = (await h.call(googlePath(sessionKey), {
      service: "calendar", resource: "events", method: "insert", body: { summary: "riunione" }, legMs: 400,
    }))!;
    expect((await resp.json() as Record<string, unknown>).ok).toBe(true);
    expect(recorded()).toContain("insert");
    expect(h.comments.at(-1)?.content).toContain("calendar events insert");
  });

  test("un metodo che nessuno sa classificare conta come scrittura", async () => {
    const h = makeHarness();
    const sessionKey = "topic:abcd1245";
    const resp = (await h.call(googlePath(sessionKey), {
      service: "drive", resource: "files", method: "frobnicate", legMs: 150,
    }))!;
    expect(await resp.json()).toEqual({ pending: true });
    expect(recorded()).toEqual([]);
    cancelAsk(sessionKey, "fine del test");
  });
});

describe("googleCallWrites", () => {
  test("i verbi che leggono non chiedono, tutto il resto si", () => {
    for (const verb of ["list", "get", "search", "export", "download", "watch", "schema"]) {
      expect(googleCallWrites(verb)).toBe(false);
    }
    for (const verb of ["insert", "create", "update", "patch", "delete", "send", "batchUpdate", "", "frobnicate"]) {
      expect(googleCallWrites(verb)).toBe(true);
    }
  });
});
