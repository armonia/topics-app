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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutboundRouter, googleCallWrites } from "./outbound";
import { CONFIRM_LABEL, REFUSE_LABEL, confirmKey, _resetOutboundHolds } from "../lib/outbound-gate";
import { gmailSendsMail } from "../lib/outbound-summary";
import { deliverAnswer, cancelAsk } from "../lib/ask-user-bridge";
import { _resetRoutedAsks, answerRoutedAsk, pendingRoutedAsk } from "../services/board-ask-routing";
import { registerTurnBodyFlush, _resetTurnBodyFlushers } from "../lib/turn-body-flush";
import { payloadDigest } from "./outbound";

// `realpathSync` on purpose: on macOS `tmpdir()` is itself a symlink
// (`/var` -> `/private/var`), and containment now compares REAL paths. A
// fixture built on the link would be measuring the link, not the rule.
const root = realpathSync(mkdtempSync(join(tmpdir(), "outbound-route-")));
const LOG = join(root, "calls.log");
/** Where the frozen attachments go. Outside every workspace, as in production. */
const STAGING = join(root, "staging");
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
afterEach(() => { _resetRoutedAsks(); _resetOutboundHolds(); _resetTurnBodyFlushers(); if (existsSync(LOG)) unlinkSync(LOG); });

/** The stand-in for `gws-mail` and `gws`: it records argv and sends nothing. */
function installFakeCli(name: string): string {
  const file = join(root, name);
  writeFileSync(
    file,
    [
      "#!/bin/bash",
      `LOG="${LOG}"`,
      `printf "%s\\0" "${name}" >> "$LOG"`,
      // The CONTENT of every argument that is a file, not just its path: what
      // a confirmation binds is the BYTES, and a test that only reads argv
      // cannot tell a frozen copy from a file swapped during the wait.
      'for a in "$@"; do printf "%s\\0" "$a" >> "$LOG"; if [ -f "$a" ]; then printf "LETTO=%s\\0" "$(cat "$a")" >> "$LOG"; fi; done',
      // The environment the child was handed, recorded like the arguments: the
      // Keychain lookup both CLIs do hangs without `USER` (measured), and a
      // hang is indistinguishable from a slow network from the outside.
      'printf "USER=%s\\0" "$USER" >> "$LOG"',
      'printf "CLIENT_ID=%s\\0" "$GOOGLE_WORKSPACE_CLI_CLIENT_ID" >> "$LOG"',
      'printf "CONFIG_DIR=%s\\0" "$GOOGLE_WORKSPACE_CLI_CONFIG_DIR" >> "$LOG"',
      'printf "HOME=%s\\0" "$HOME" >> "$LOG"',
      // The working directory is not decoration: the real `gws` refuses
      // `--attach` on anything that resolves outside it (measured).
      'printf "PWD=%s\\0" "$PWD" >> "$LOG"',
      'echo "{\\"ok\\":true}"',
      "exit 0",
    ].join("\n"),
    "utf8",
  );
  chmodSync(file, 0o755);
  return file;
}
installFakeCli("fake-mail");
installFakeCli("fake-google");
writeFileSync(
  join(root, "client_secret.json"),
  JSON.stringify({ installed: { client_id: "finto-client-id", client_secret: "finto-client-secret" } }),
  "utf8",
);

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

function makeHarness(options: {
  env?: Record<string, string>;
  card?: boolean;
  workspace?: string;
  /** The last persisted row of the session, read fresh: the gate forces a write before looking. */
  lastRow?: () => { tool_calls?: unknown; blocks?: unknown } | undefined;
} = {}) {
  const comments: Array<{ id: string; taskId: string; content: string; options: string[]; quiet?: boolean }> = [];
  const ctx = {
    db: {
      prepare: (sql: string) => ({
        get: () => (String(sql).includes("FROM messages")
          ? options.lastRow?.()
          : (options.card === false ? undefined : CARD)),
      }),
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
    // Never the real `~/.topics`: the frozen copies live here and are swept here.
    stagingRoot: STAGING,
    cliTimeoutMs: 10_000,
    comment: (args) => {
      const id = `c-${comments.length + 1}`;
      comments.push({ id, taskId: args.taskId, content: args.content, options: args.options, quiet: args.quiet });
      return id;
    },
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

/**
 * The digest of the question that was actually asked, read off the card.
 *
 * Recomputing it in the test would mirror the route's own identity rule - and
 * then a test for "the bytes are part of the identity" would pass by
 * construction, whatever the route does.
 */
const askedDigest = (comments: Array<{ content: string }>): string =>
  /Confermi\? \(([0-9a-f]+)\)/.exec(comments[0]?.content ?? "")?.[1] ?? "";

/** Say yes to whatever question is on the card, optionally messing with the
 *  workspace first: that window is the one a person spends reading. */
function confirmWhenAsked(
  h: { comments: Array<{ content: string }> },
  sessionKey: string,
  meanwhile?: () => void,
): void {
  setTimeout(() => {
    meanwhile?.();
    deliverAnswer(sessionKey, { [confirmKey(askedDigest(h.comments))]: CONFIRM_LABEL });
  }, 30);
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
    expect(await resp.json()).toEqual({ pending: true, hold: expect.any(String) });
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
    // Three comments: the question, the line that CLOSES it (the yes came back
    // through the panel in the tab, so nothing in the thread said that block was
    // over and its buttons kept answering nobody), and then the trace.
    expect(h.comments).toHaveLength(3);
    expect(h.comments[1].content).toContain("non aspetta piu'");
    expect(h.comments[1].options).toEqual([]);
    const line = h.comments[2].content;
    expect(line).toContain("primo");
    expect(line).toContain(message.to);
    expect(line).toContain(message.subject);
    expect(line).not.toContain(message.body);
  });

  test("chi conferma LEGGE il messaggio: il corpo sta nella domanda, non nella traccia", async () => {
    const h = makeHarness();
    const sessionKey = "topic:abcd1247";
    const digest = payloadDigest(["primo", message.to, message.subject, message.body, "", []]);
    setTimeout(() => { deliverAnswer(sessionKey, { [confirmKey(digest)]: CONFIRM_LABEL }); }, 20);
    await h.call(mailPath(sessionKey), { ...message, legMs: 400 });
    // The question is the first comment, the trace is the last. A person who
    // can only read "32 characters" is signing a sealed envelope.
    expect(h.comments[0].content).toContain(message.body);
    expect(h.comments.at(-1)?.content).not.toContain(message.body);
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

  test("an attachment INSIDE the workspace reaches the CLI as a FROZEN copy, with its bytes", async () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const attached = join(workspace, "preventivo.pdf");
    writeFileSync(attached, "%PDF-finto", "utf8");
    const h = makeHarness({ workspace });
    const sessionKey = "topic:abcd1246";
    confirmWhenAsked(h, sessionKey);
    const resp = (await h.call(mailPath(sessionKey), { ...message, attachments: ["preventivo.pdf"], legMs: 600 }))!;
    expect((await resp.json() as Record<string, unknown>).sent).toBe(true);
    const args = recorded();
    expect(args).toContain("--attach");
    // The bytes are the file's; the path is not. What the CLI opens lives in
    // the server's staging directory, where the workspace cannot reach it.
    expect(args).toContain("LETTO=%PDF-finto");
    expect(args).not.toContain(attached);
    expect(args.some((a) => a.startsWith(STAGING))).toBe(true);
  });

  test("un allegato che e' un LINK verso l'esterno e' rifiutato: `resolve()` non segue i symlink", async () => {
    // The half the `../` test does not cover. `isInsideDir` says so itself
    // (path-containment.ts: "`../` is normalised here, a symlink is not"), and
    // an agent with a shell in its own worktree writes one in a second:
    // `ln -s ~/.topics-server-env preventivo.pdf`. The string is impeccable,
    // the bytes that leave are somebody else's secrets.
    const workspace = join(root, "ws-link");
    mkdirSync(workspace, { recursive: true });
    const outside = join(root, "fuori-segreto.txt");
    writeFileSync(outside, "TOKEN=finto-super-segreto", "utf8");
    const link = join(workspace, "preventivo.pdf");
    if (existsSync(link)) unlinkSync(link);
    symlinkSync(outside, link);
    const h = makeHarness({ workspace });
    const resp = (await h.call(mailPath("topic:abcd1250"), { ...message, attachments: ["preventivo.pdf"] }))!;
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.code).toBe("attachment_refused");
    expect(String(body.error)).toContain("outside");
    // The negative proof: no confirmation was even opened, and nothing ran.
    expect(recorded()).toEqual([]);
    expect(h.comments).toEqual([]);
  });

  test("un link che resta DENTRO il workspace passa, e quello che parte e' il file reale", async () => {
    // The other side of the same rule: resolving is not refusing. A link that
    // lands inside is legitimate, and the path handed to the CLI is the real
    // one, so re-pointing the link while the person reads the question changes
    // nothing about what leaves.
    const workspace = join(root, "ws-link-dentro");
    mkdirSync(join(workspace, "dati"), { recursive: true });
    const realFile = join(workspace, "dati", "tabella.csv");
    writeFileSync(realFile, "a,b\n1,2\n", "utf8");
    const link = join(workspace, "allegato.csv");
    if (existsSync(link)) unlinkSync(link);
    symlinkSync(realFile, link);
    const h = makeHarness({ workspace });
    const sessionKey = "topic:abcd1251";
    confirmWhenAsked(h, sessionKey);
    const resp = (await h.call(mailPath(sessionKey), { ...message, attachments: ["allegato.csv"], legMs: 600 }))!;
    expect((await resp.json() as Record<string, unknown>).sent).toBe(true);
    // `$(cat)` eats the trailing newline: the two rows are the proof.
    expect(recorded()).toContain("LETTO=a,b\n1,2");
  });

  test("la conferma NOMINA gli allegati: un numero non si puo' leggere", async () => {
    // "Allegati: 1" is the sealed envelope OUTBOUND-03 refuses two paragraphs
    // above: it is exactly what makes a link nobody can see invisible to the
    // one person who could have stopped it.
    const workspace = join(root, "ws-nomi");
    mkdirSync(workspace, { recursive: true });
    const attached = join(workspace, "preventivo-2026.pdf");
    writeFileSync(attached, "%PDF-finto abbastanza lungo da avere un peso", "utf8");
    const h = makeHarness({ workspace });
    const sessionKey = "topic:abcd1252";
    const resp = (await h.call(mailPath(sessionKey), { ...message, attachments: ["preventivo-2026.pdf"], legMs: 150 }))!;
    expect(await resp.json()).toEqual({ pending: true, hold: expect.any(String) });
    const question = h.comments[0]?.content ?? "";
    expect(question).toContain("preventivo-2026.pdf");
    expect(question).not.toContain("Allegati: 1");
    // And the FINGERPRINT of the bytes that were frozen: name and size are
    // what an agent controls, the hash is what it cannot keep true after a swap.
    expect(question).toMatch(/sha256 [0-9a-f]{8}/);
    cancelAsk(sessionKey, "fine del test");
  });

  test("un invio CONFERMATO che non parte lascia comunque la sua riga sulla card", async () => {
    // OUTBOUND-05 asks for a line from a REFUSED or FAILED attempt too. The
    // person said yes and the message did not go: the card has to say so, or
    // the only record of a broken send is the agent's own message.
    const env = { ...ENV, TOPICS_MAIL_CLI: "eseguibile-sparito" };
    const h = makeHarness({ env });
    const sessionKey = "topic:abcd1253";
    const digest = payloadDigest(["primo", message.to, message.subject, message.body, "", []]);
    setTimeout(() => { deliverAnswer(sessionKey, { [confirmKey(digest)]: CONFIRM_LABEL }); }, 20);
    const resp = (await h.call(mailPath(sessionKey), { ...message, legMs: 400 }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json() as Record<string, unknown>).code).toBe("outbound_not_configured");
    expect(recorded()).toEqual([]);
    const line = h.comments.at(-1)?.content ?? "";
    expect(line).toContain("FALLITO");
    expect(line).toContain("TOPICS_MAIL_CLI");
  });

  test("i BYTE sono legati alla conferma: il file sostituito DURANTE l'attesa non parte", async () => {
    // The verifier's reproduction, both halves of it in one case: the name the
    // person read stays, the file behind it becomes a link to a secret. The
    // resolution that used to happen before the question froze the STRING, and
    // the string is exactly what the attacker leaves alone - argv said
    // `--attach <ws>/preventivo.pdf` and the fake CLI read `TOKEN=...`.
    const workspace = join(root, "ws-toctou");
    mkdirSync(workspace, { recursive: true });
    const attached = join(workspace, "preventivo.pdf");
    writeFileSync(attached, "preventivo vero", "utf8");
    const secretFile = join(root, "segreto-toctou.txt");
    writeFileSync(secretFile, "TOKEN=finto-super-segreto-42", "utf8");
    const h = makeHarness({ workspace });
    const sessionKey = "topic:abcd1260";
    confirmWhenAsked(h, sessionKey, () => {
      unlinkSync(attached);
      symlinkSync(secretFile, attached);
    });
    const resp = (await h.call(mailPath(sessionKey), { ...message, attachments: ["preventivo.pdf"], legMs: 600 }))!;
    expect((await resp.json() as Record<string, unknown>).sent).toBe(true);
    const args = recorded();
    expect(args).toContain("LETTO=preventivo vero");
    expect(args.some((a) => a.startsWith("LETTO=TOKEN="))).toBe(false);
    // Not even the path: the workspace name is not what was spawned.
    expect(args).not.toContain(attached);
  });

  test("la copia riscritta DURANTE l'attesa non parte: il si' vale per QUEI byte", async () => {
    // The other half of the same attack, one directory further in. The server
    // and the agent run under the SAME uid, so the staging directory is not out
    // of reach: no computation is needed either, a walk of it finds the copy
    // while the person reads. What closes the minutes-long window is re-reading
    // the copy right before the spawn and refusing when it is not the one that
    // was confirmed.
    const workspace = join(root, "ws-copia-riscritta");
    mkdirSync(workspace, { recursive: true });
    const attached = join(workspace, "preventivo.pdf");
    writeFileSync(attached, "preventivo vero", "utf8");
    const h = makeHarness({ workspace });
    const sessionKey = "topic:abcd1270";
    confirmWhenAsked(h, sessionKey, () => {
      for (const entry of readdirSync(STAGING, { recursive: true }) as string[]) {
        if (entry.endsWith("preventivo.pdf")) writeFileSync(join(STAGING, entry), "TOKEN=chiave-rubata", "utf8");
      }
    });
    const resp = (await h.call(mailPath(sessionKey), { ...message, attachments: ["preventivo.pdf"], legMs: 600 }))!;
    const body = await resp.json() as Record<string, unknown>;
    expect(body.sent).toBeUndefined();
    expect(body.refused).toBe(true);
    // The negative proof: no process at all, so nothing read those bytes.
    expect(recorded()).toEqual([]);
    expect(h.comments.at(-1)?.content).toContain("NON partito");
  });

  test("the attachment arrives INSIDE the child's working directory", async () => {
    // Measured on the real `gws` (`+send --dry-run`, nothing sent): an
    // `--attach` that resolves outside the current directory comes back
    // "resolves to '...' which is outside the current directory", code 400,
    // reason `validationError`. The frozen copy lives under `~/.topics` while
    // the server runs wherever launchd started it: without telling the child
    // where to stand, NO confirmed attachment would ever really have left. The
    // fake CLI does not make that check, so the contract is measured here: the
    // path handed over is inside the child's PWD.
    const workspace = join(root, "ws-cwd");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "preventivo.pdf"), "%PDF-cartella", "utf8");
    const h = makeHarness({ workspace });
    const sessionKey = "topic:abcd1275";
    confirmWhenAsked(h, sessionKey);
    const resp = (await h.call(mailPath(sessionKey), { ...message, attachments: ["preventivo.pdf"], legMs: 600 }))!;
    expect((await resp.json() as Record<string, unknown>).sent).toBe(true);
    const args = recorded();
    const workingDir = args.find((a) => a.startsWith("PWD="))?.slice(4) ?? "";
    const attach = args[args.indexOf("--attach") + 1] ?? "";
    expect(workingDir).toBeTruthy();
    expect(attach.startsWith(`${workingDir}/`)).toBe(true);
  });

  test("a second confirmation on one card is REFUSED, and the yes stays the first message's", async () => {
    // THE DEFECT REPRODUCED. A coordinator and its children sit on the same
    // taskId by construction, and the registry of open questions is keyed
    // there: the second confirmation evicted the first without writing
    // anything, and the yes was delivered under the CURRENT key. The person
    // read the first message on screen, clicked the confirm button, and a
    // different message left for a different recipient.
    const h = makeHarness();
    const firstSession = "topic:abcd1280";
    const secondSession = "topic:abcd1281";

    // The first confirmation stays open: the leg expires, the question does not.
    const legOne = (await h.call(mailPath(firstSession), { ...message, legMs: 120 }))!;
    const legOneBody = await legOne.json() as Record<string, unknown>;
    expect(legOneBody).toEqual({ pending: true, hold: expect.any(String) });
    const asked = h.comments.length;

    // The other session of the same task tries.
    const other = (await h.call(mailPath(secondSession), {
      to: "attaccante@esempio.test", subject: "Credenziali", body: "ecco tutto", legMs: 120,
    }))!;
    const refusal = await other.json() as Record<string, unknown>;
    expect(refusal.refused).toBe(true);
    expect(String(refusal.reason)).toContain("already has a confirmation");
    // No new question on the card: only the trace of the refusal.
    expect(h.comments.filter((c) => c.options.length > 0)).toHaveLength(asked);
    expect(h.comments.at(-1)?.content).toContain("NON partito");
    expect(recorded()).toEqual([]);

    // And the yes read on the FIRST question sends the FIRST message.
    confirmWhenAsked(h, firstSession);
    // The next leg of the FIRST request carries the hold it was handed: that
    // token is what says "same request", and without it this leg is a stranger
    // arriving on a card somebody is holding - which is the point.
    const legTwo = (await h.call(mailPath(firstSession), { ...message, legMs: 600, hold: legOneBody.hold }))!;
    expect((await legTwo.json() as Record<string, unknown>).sent).toBe(true);
    const args = recorded();
    expect(args).toContain(message.to);
    expect(args).not.toContain("attaccante@esempio.test");
    cancelAsk(secondSession, "end of test");
  });

  /**
   * TWO SENDS OF ONE SESSION, 120 ms apart, the second arriving while the first
   * is inside its waiting leg. Reproduced against the real route, the real
   * gate and the real rendez-vous: the MCP bridge handles every JSON-RPC line
   * in a callback it does not await, so two `send_mail` of one message run
   * together on one session - and the route is callable by hand anyway.
   *
   * Three defects in one. The second confirmation REPLACED the first (the gate
   * only looked at other sessions) and the card ended up with TWO blocks of
   * buttons; the losing leg deleted the entry of the one that had WON (the
   * registry was keyed by session), so the click on the live block did not
   * start anything - `pendingRoutedAsk` answered null; and its trace line,
   * written under the live question, took that question's buttons away
   * (`pendingQuestionComment` stops at the first agent row that is neither a
   * question nor a delivery).
   */
  test("due invii della stessa sessione a 120 ms: UNA conferma sulla card, e il si' la consegna", async () => {
    const h = makeHarness();
    const sessionKey = "topic:abcd1290";
    const first = { to: "cliente@esempio.test", subject: "Preventivo", body: "in allegato", legMs: 600 };
    const firstLeg = h.call(mailPath(sessionKey), first);
    await Bun.sleep(120);
    const secondLeg = h.call(mailPath(sessionKey), {
      to: "attaccante@esempio.test", subject: "Credenziali", body: "ecco tutto", legMs: 600,
    });

    const refusal = await (await secondLeg)!.json() as Record<string, unknown>;
    expect(refusal.refused).toBe(true);
    expect(String(refusal.reason)).toContain("already has a confirmation");

    // ONE confirmation on the card, and it is the one of the right message.
    const confirmations = h.comments.filter((c) => c.options.length > 0);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].content).toContain("cliente@esempio.test");
    // The refusal line is there, and it is a NOTE: it answers nothing, so it
    // does not take the buttons away from the question above it.
    const traceLine = h.comments.at(-1)!;
    expect(traceLine.content).toContain("NON partito");
    expect(traceLine.quiet).toBe(true);

    // The registry still holds the first one: without this the click is a no-op.
    expect(pendingRoutedAsk("task-1")?.askId).toBe(confirmations[0].id);
    // The person clicks the confirm button on that block, which is the road
    // `routes/tasks.ts` takes when a quick reply comes back from the drawer.
    const answered = answerRoutedAsk(
      { db: null as never, comment: () => null, deliver: (key, answers) => deliverAnswer(key, answers) },
      "task-1",
      CONFIRM_LABEL,
      { askId: confirmations[0].id },
    );
    expect(answered.delivered).toBe(true);

    const sent = await (await firstLeg)!.json() as Record<string, unknown>;
    expect(sent.sent).toBe(true);
    expect(sent.to).toBe("cliente@esempio.test");
    const args = recorded();
    expect(args).toContain("cliente@esempio.test");
    expect(args).not.toContain("attaccante@esempio.test");
  });

  /**
   * THE SAME TWO SENDS, WITH THE SAME PAYLOAD - which is the case the previous
   * fix did not close, and the one the bridge actually produces.
   *
   * The routing calls two requests carrying the same digest THE SAME QUESTION:
   * same key, same text, so it hands the second one the first one's row id and
   * reports it as already on screen. The `busy` branch never fires, the second
   * walked past the gate into `beginAsk`/`waitForAnswer`, and the rendez-vous -
   * keyed by SESSION - superseded the first. Measured 120 ms apart: the FIRST
   * came back "superseded by a newer question", its clean-up deleted the entry
   * both were now pointing at, `pendingRoutedAsk` answered null, and the click
   * on the confirmation still on screen delivered nothing and said nothing.
   *
   * The hold does not read the payload, so an identical one changes nothing.
   *
   * @covers OUTBOUND-03
   */
  test("due invii IDENTICI della stessa sessione: il secondo e' rifiutato e il si' resta esigibile", async () => {
    const h = makeHarness();
    const sessionKey = "topic:abcd1291";
    const identical = { to: "cliente@esempio.test", subject: "Preventivo", body: "in allegato", legMs: 600 };
    const firstLeg = h.call(mailPath(sessionKey), identical);
    await Bun.sleep(120);
    const secondLeg = h.call(mailPath(sessionKey), { ...identical });

    const refusal = await (await secondLeg)!.json() as Record<string, unknown>;
    expect(refusal.refused).toBe(true);
    expect(String(refusal.reason)).toContain("already has a confirmation");

    // ONE block of buttons, and the registry still names it: both were null
    // before, and that is what made the click reach nobody.
    const confirmations = h.comments.filter((c) => c.options.length > 0);
    expect(confirmations).toHaveLength(1);
    expect(pendingRoutedAsk("task-1")?.askId).toBe(confirmations[0].id);

    const answered = answerRoutedAsk(
      { db: null as never, comment: () => null, deliver: (key, answers) => deliverAnswer(key, answers) },
      "task-1",
      CONFIRM_LABEL,
      { askId: confirmations[0].id },
    );
    expect(answered.delivered).toBe(true);

    const sent = await (await firstLeg)!.json() as Record<string, unknown>;
    expect(sent.sent).toBe(true);
    // One yes, ONE send: the refused request left nothing behind that a later
    // leg could spend.
    expect(recorded().filter((a) => a === "+send")).toHaveLength(1);
  });

  /**
   * THE TOKEN IS WHAT TELLS A LEG FROM A STRANGER, and with an identical
   * payload nothing else can: same digest, same question, same session. The
   * route hands it back with every `pending` and the tool echoes it.
   *
   * @covers OUTBOUND-03
   */
  test("la gamba che porta il suo lucchetto continua; quella che non ce l'ha e' un'estranea", async () => {
    const h = makeHarness();
    const sessionKey = "topic:abcd1292";
    const payload = { to: "cliente@esempio.test", subject: "Preventivo", body: "in allegato", legMs: 120 };

    const legOne = await (await h.call(mailPath(sessionKey), payload))! .json() as Record<string, unknown>;
    expect(legOne).toEqual({ pending: true, hold: expect.any(String) });

    // The same request coming straight back: still pending, still ONE block on
    // the card - the question is the same panel, not a new one.
    const legTwo = await (await h.call(mailPath(sessionKey), { ...payload, hold: legOne.hold }))!.json() as Record<string, unknown>;
    expect(legTwo).toEqual({ pending: true, hold: legOne.hold });
    expect(h.comments.filter((c) => c.options.length > 0)).toHaveLength(1);

    // A byte-identical request that never held this card: refused, and it did
    // not touch the question that is on screen.
    const stranger = await (await h.call(mailPath(sessionKey), { ...payload }))!.json() as Record<string, unknown>;
    expect(stranger.refused).toBe(true);
    // Neither does one waving a token that is not the one on the card.
    const forged = await (await h.call(mailPath(sessionKey), { ...payload, hold: "non-il-mio" }))!.json() as Record<string, unknown>;
    expect(forged.refused).toBe(true);
    expect(h.comments.filter((c) => c.options.length > 0)).toHaveLength(1);
    expect(pendingRoutedAsk("task-1")).not.toBeNull();
    expect(recorded()).toEqual([]);
    cancelAsk(sessionKey, "end of test");
  });

  /**
   * AND THE HOLD CAN LAPSE WHILE THE ROW IT WROTE IS STILL ON THE CARD.
   *
   * The lease is the declared leg plus a grace, so it outlives a request that is
   * still polling and lets go of one that stopped; the registry entry instead is
   * held for two minutes of nobody coming back. Between those two clocks there
   * is a window where the card is FREE and the question is still there - and in
   * it, the routing hands a byte-identical request the id of a row it did not
   * write. Adopting that id is the whole defect again from the other end: the
   * new request joins the other one's rendez-vous, supersedes it, and its own
   * clean-up closes the block the first one is still waiting on. Owning only
   * what it created, it is refused instead, and nothing of the live question
   * moves.
   *
   * `_resetOutboundHolds` is how the lapse is spelled here: it is what the lease
   * expiring does, with no clock to wind forward.
   *
   * @covers OUTBOUND-03
   */
  test("un lucchetto scaduto non regala la domanda di chi aspetta ancora", async () => {
    const h = makeHarness();
    const sessionKey = "topic:abcd1293";
    const payload = { to: "cliente@esempio.test", subject: "Preventivo", body: "in allegato", legMs: 600 };
    const waiting = h.call(mailPath(sessionKey), payload);
    await Bun.sleep(60);
    const block = h.comments.filter((c) => c.options.length > 0);
    expect(block).toHaveLength(1);

    _resetOutboundHolds();
    const identical = await (await h.call(mailPath(sessionKey), { ...payload, legMs: 120 }))!.json() as Record<string, unknown>;
    expect(identical.refused).toBe(true);

    // The question on the card is untouched, and it is still the first one's.
    expect(h.comments.filter((c) => c.options.length > 0)).toHaveLength(1);
    expect(pendingRoutedAsk("task-1")?.askId).toBe(block[0].id);
    const answered = answerRoutedAsk(
      { db: null as never, comment: () => null, deliver: (key, answers) => deliverAnswer(key, answers) },
      "task-1",
      CONFIRM_LABEL,
      { askId: block[0].id },
    );
    expect(answered.delivered).toBe(true);
    expect((await (await waiting)!.json() as Record<string, unknown>).sent).toBe(true);
  });

  /**
   * THE HOLD IS KEYED ON THE CARD, and two sessions of one task exist by
   * construction: `agent-census.ts` maps the coordinator and its children onto
   * the same task on purpose. Keying it on the SESSION was indistinguishable for
   * the suite - mutant run, zero reds - because in the cases already covered the
   * routing's own "busy" branch was enough to turn the second request away, and
   * that branch reads the REGISTRY of open questions.
   *
   * This is the window where the two come apart, and it is the dangerous one:
   * the person has already answered ON THE CARD, so the registry holds nothing,
   * yet the first request is alive and its next leg is about to spend that yes.
   * With the key on the session the sister writes a SECOND confirmation on the
   * card while the first message is leaving: two blocks of buttons, and the card
   * draws one.
   *
   * @covers OUTBOUND-03
   */
  test("il lucchetto e' della CARD: la sessione sorella non apre una seconda conferma", async () => {
    const h = makeHarness();
    const coordinator = "topic:abcd1296";
    const sister = "topic:abcd1297";
    const payload = { to: "cliente@esempio.test", subject: "Preventivo", body: "in allegato", legMs: 120 };

    const legOne = await (await h.call(mailPath(coordinator), payload))!.json() as Record<string, unknown>;
    expect(legOne).toEqual({ pending: true, hold: expect.any(String) });
    const block = h.comments.filter((c) => c.options.length > 0);
    expect(block).toHaveLength(1);

    // The person answers ON THE CARD: the registry empties and the yes waits for
    // the next leg, which is when the message actually leaves.
    const answered = answerRoutedAsk(
      { db: null as never, comment: () => null, deliver: (key, answers) => deliverAnswer(key, answers) },
      "task-1",
      CONFIRM_LABEL,
      { askId: block[0].id },
    );
    expect(answered.delivered).toBe(true);
    expect(pendingRoutedAsk("task-1")).toBeNull();

    // The sister asks to send ANOTHER message: the card is still busy with the
    // request that is finishing.
    const refusal = await (await h.call(mailPath(sister), { ...payload, to: "altro@esempio.test" }))!.json() as Record<string, unknown>;
    expect(refusal.refused).toBe(true);
    expect(String(refusal.reason)).toContain("already has a confirmation");
    expect(h.comments.filter((c) => c.options.length > 0)).toHaveLength(1);

    // And the yes pays for the message the person read, once.
    const sent = await (await h.call(mailPath(coordinator), { ...payload, hold: legOne.hold }))!.json() as Record<string, unknown>;
    expect(sent.sent).toBe(true);
    expect(recorded()).toContain("cliente@esempio.test");
    expect(recorded()).not.toContain("altro@esempio.test");
    expect(recorded().filter((a) => a === "+send")).toHaveLength(1);
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
    // And the child got the session identity it needs to open the Keychain,
    // plus the OAuth client read out of the file the variable points at.
    expect(args).toContain(`USER=${process.env.USER ?? ""}`);
    expect(args.some((a) => a.startsWith("HOME=/"))).toBe(true);
    expect(args).toContain("CLIENT_ID=finto-client-id");
    expect(args).toContain(`CONFIG_DIR=${join(root, "gws-config")}`);
  });

  test("una SCRITTURA aspetta la persona: `pending` e nessun processo", async () => {
    const h = makeHarness();
    const sessionKey = "topic:abcd1243";
    const resp = (await h.call(googlePath(sessionKey), {
      service: "calendar", resource: "events", method: "insert", body: { summary: "riunione" }, legMs: 150,
    }))!;
    expect(await resp.json()).toEqual({ pending: true, hold: expect.any(String) });
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

  test("una scrittura CONFERMATA che non parte lascia comunque la sua riga", async () => {
    const env = { ...ENV, TOPICS_GOOGLE_CLI: "eseguibile-sparito" };
    const h = makeHarness({ env });
    const sessionKey = "topic:abcd1254";
    const digest = payloadDigest(["calendar", "events", "", "insert", null, JSON.stringify({ summary: "riunione" })]);
    setTimeout(() => { deliverAnswer(sessionKey, { [confirmKey(digest)]: CONFIRM_LABEL }); }, 20);
    const resp = (await h.call(googlePath(sessionKey), {
      service: "calendar", resource: "events", method: "insert", body: { summary: "riunione" }, legMs: 400,
    }))!;
    expect(resp.status).toBe(400);
    expect(recorded()).toEqual([]);
    const line = h.comments.at(-1)?.content ?? "";
    expect(line).toContain("FALLITA");
    expect(line).toContain("TOPICS_GOOGLE_CLI");
  });

  test("un metodo che nessuno sa classificare conta come scrittura", async () => {
    const h = makeHarness();
    const sessionKey = "topic:abcd1245";
    const resp = (await h.call(googlePath(sessionKey), {
      service: "drive", resource: "files", method: "frobnicate", legMs: 150,
    }))!;
    expect(await resp.json()).toEqual({ pending: true, hold: expect.any(String) });
    expect(recorded()).toEqual([]);
    cancelAsk(sessionKey, "fine del test");
  });
});

describe("la riga su cui si dipinge la domanda", () => {
  test("una scrittura in RITARDO non e' 'nessuno a cui chiedere'", async () => {
    // The row is the one the throttle has written so far - the tool before
    // this one - and the tool that is asking arrives with the deferred write,
    // up to fifteen seconds later. Refusing on that row answered "nobody could
    // confirm" to a person who was there, and the MCP tool raises on a refusal,
    // so there was no second leg either.
    const sessionKey = "chat:outbound-flush";
    const running = (id: string, name: string) => ({ kind: "tool", toolCall: { id, name, args: {}, status: "running" } });
    let row = { tool_calls: "[]", blocks: JSON.stringify([running("t1", "read_file")]) };
    const release = registerTurnBodyFlush(sessionKey, () => {
      row = { tool_calls: "[]", blocks: JSON.stringify([running("t1", "read_file"), running("t2", "send_mail")]) };
    });
    const h = makeHarness({ card: false, lastRow: () => row });
    const resp = (await h.call(mailPath(sessionKey), { ...message, legMs: 150 }))!;
    // Pending: the question is on the tool row and the person is reading it.
    expect(await resp.json()).toEqual({ pending: true, hold: expect.any(String) });
    expect(recorded()).toEqual([]);
    cancelAsk(sessionKey, "fine del test");
    release();
  });
});

describe("gmail e' la porta della posta, e ha una porta sola", () => {
  test("un metodo che SPEDISCE e' rifiutato e rimanda a send_mail", async () => {
    // `gws gmail users messages send` exists: without this, an agent sends a
    // message without ever passing the gate that shows it to somebody.
    const h = makeHarness();
    const resp = (await h.call(googlePath("topic:abcd1261"), {
      service: "gmail", resource: "users", subresource: "messages", method: "send",
      body: { userId: "me", raw: "Rnjvbtogcg==" }, legMs: 150,
    }))!;
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.code).toBe("use_send_mail");
    expect(String(body.error)).toContain("send_mail");
    // Negative proof: no process, and nobody was even asked.
    expect(recorded()).toEqual([]);
    expect(h.comments).toEqual([]);
  });

  test("un helper della CLI che SPEDISCE non e' una scorciatoia intorno all'elenco", async () => {
    // The refused set named two API paths, and the CLI being driven has four
    // helpers that send: `+send`, `+reply`, `+reply-all`, `+forward`. The last
    // one forwards any message of the mailbox, attachments included, to an
    // address of the caller's choosing - and the four free strings of the call
    // are exactly the four argv slots it needs.
    const h = makeHarness();
    const resp = (await h.call(googlePath("topic:abcd1271"), {
      service: "gmail",
      resource: "+forward",
      subresource: "--message-id=18f1a2b3c4d",
      method: "--to=vittima@esempio.test",
      legMs: 150,
    }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json() as Record<string, unknown>).code).toBe("use_send_mail");
    expect(recorded()).toEqual([]);
    expect(h.comments).toEqual([]);
  });

  test("i quattro campi sono identificatori d'API, non argomenti di una riga di comando", async () => {
    // `[service, resource, subresource, method]` became argv verbatim, so a
    // field that starts with a dash was a FLAG for the CLI. A read verb is
    // enough to get there: nothing asks, and the call runs.
    const h = makeHarness();
    const resp = (await h.call(googlePath("topic:abcd1272"), {
      service: "drive", resource: "files", subresource: "--upload-file=/etc/hosts", method: "list", legMs: 150,
    }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json() as Record<string, unknown>).code).toBe("invalid_call");
    expect(recorded()).toEqual([]);
    expect(h.comments).toEqual([]);
  });

  test("un `raw` che non e' un messaggio non diventa una domanda vuota", async () => {
    // A base64 decoder never refuses: without this, garbage in `raw` was shown
    // as a message with no sender, no recipient and no subject, i.e. LESS than
    // the JSON it replaced.
    const h = makeHarness();
    const sessionKey = "topic:abcd1263";
    const raw = Buffer.from("non e' un messaggio, e non ha intestazioni", "utf8").toString("base64");
    const resp = (await h.call(googlePath(sessionKey), {
      service: "gmail", resource: "users", subresource: "drafts", method: "create",
      body: { userId: "me", raw }, legMs: 150,
    }))!;
    expect(await resp.json()).toEqual({ pending: true, hold: expect.any(String) });
    const question = h.comments[0]?.content ?? "";
    expect(question).toContain("body: ");
    expect(question).not.toContain("Da: (non indicato)");
    cancelAsk(sessionKey, "fine del test");
  });

  test("la traccia di una scrittura che porta un messaggio dice A CHI e con che oggetto", async () => {
    // A trace that names only the method says that something happened and
    // nothing about what left, which is what OUTBOUND-05 refuses. The line as
    // the route writes it: "Scrittura Google eseguita: gmail users drafts create - riuscita". allow-italian: quotes that line
    const raw = Buffer.from("To: cliente@e.test\r\nSubject: Preventivo 2026\r\n\r\nEccolo.", "utf8").toString("base64url");
    const h = makeHarness();
    const sessionKey = "topic:abcd1264";
    confirmWhenAsked(h, sessionKey);
    const resp = (await h.call(googlePath(sessionKey), {
      service: "gmail", resource: "users", subresource: "drafts", method: "create",
      body: { userId: "me", message: { raw } }, legMs: 600,
    }))!;
    expect((await resp.json() as Record<string, unknown>).ok).toBe(true);
    const line = h.comments.at(-1)?.content ?? "";
    expect(line).toContain("cliente@e.test");
    expect(line).toContain("Preventivo 2026");
    // The trace still does not carry the body.
    expect(line).not.toContain("Eccolo.");
  });

  test("il rifiuto non si aggira con maiuscole, spazi o la forma corta", () => {
    for (const parts of [
      { service: "gmail", resource: "users", subresource: "messages", method: "send" },
      { service: " Gmail ", resource: "Users", subresource: " MESSAGES", method: "Send " },
      { service: "gmail", resource: "users", subresource: "drafts", method: "send" },
      { service: "gmail", resource: "messages", method: "send" },
      // The helpers of the CLI that is actually being driven, in the slots the
      // call gives a caller: they send too, and none of them was on the list.
      { service: "gmail", resource: "+send", method: "--to=vittima@e.test" },
      { service: "gmail", resource: "+reply", method: "--message-id=18f1" },
      { service: "gmail", resource: "+reply-all", method: "--message-id=18f1" },
      { service: "gmail", resource: "+forward", subresource: "--message-id=18f1", method: "--to=vittima@e.test" },
    ]) {
      expect(gmailSendsMail(parts)).toBe(true);
    }
    // And a write that does NOT send keeps its door: it asks, like every other.
    for (const parts of [
      { service: "gmail", resource: "users", subresource: "drafts", method: "create" },
      { service: "gmail", resource: "users", subresource: "labels", method: "delete" },
      { service: "calendar", resource: "events", method: "send" },
    ]) {
      expect(gmailSendsMail(parts)).toBe(false);
    }
  });

  test("una scrittura che PORTA un messaggio si legge in chiaro nella domanda", async () => {
    // A draft is a write that does not send, so it still goes through: what it
    // may not do is show the person `raw: "Rnjvbtog..."` cut at 300 characters.
    const raw = Buffer.from(
      "From: primo@esempio.test\r\nTo: vittima@e.test\r\nSubject: Bonifico\r\n\r\nIBAN nuovo, mandate qui.",
      "utf8",
    ).toString("base64url");
    const h = makeHarness();
    const sessionKey = "topic:abcd1262";
    const resp = (await h.call(googlePath(sessionKey), {
      service: "gmail", resource: "users", subresource: "drafts", method: "create",
      body: { userId: "me", message: { raw } }, legMs: 150,
    }))!;
    expect(await resp.json()).toEqual({ pending: true, hold: expect.any(String) });
    const question = h.comments[0]?.content ?? "";
    expect(question).toContain("vittima@e.test");
    expect(question).toContain("Bonifico");
    expect(question).toContain("IBAN nuovo, mandate qui.");
    // And the base64 is not what the person is asked to read.
    expect(question).not.toContain(raw);
    expect(recorded()).toEqual([]);
    cancelAsk(sessionKey, "fine del test");
  });
});

describe("googleCallWrites", () => {
  test("i verbi che leggono non chiedono, tutto il resto si", () => {
    for (const verb of ["list", "get", "search", "export", "download", "schema"]) {
      expect(googleCallWrites(verb)).toBe(false);
    }
    // `watch` is in the second list on purpose: it sounds like an observer and
    // it is not one, it creates a push subscription that outlives the call.
    for (const verb of ["insert", "create", "update", "patch", "delete", "send", "batchUpdate", "watch", "", "frobnicate"]) {
      expect(googleCallWrites(verb)).toBe(true);
    }
  });
});
