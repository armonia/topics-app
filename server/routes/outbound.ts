import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AppContext, RouteHandler } from "../types";
import { isInsideDir } from "../lib/path-containment";
import {
  OutboundConfigError,
  pickAccount,
  readGoogleConfig,
  readMailConfig,
  type EnvMap,
  type MailAccount,
} from "../lib/outbound-config";
import { resolveCliPath, runCli, CLI_SEARCH_DIRS } from "../lib/outbound-cli";
import { confirmOutbound, type ConfirmOutcome, type OutboundGateDeps } from "../lib/outbound-gate";
import { deliverAnswer } from "../lib/ask-user-bridge";
import { boardTaskForSession } from "../services/agent-census";
import { createTaskService } from "../services/tasks";
import { decodeCol } from "../../shared/message-blob";
import { isGlobalOrchestratorSession } from "../services/global-orchestrator-session";

/**
 * THE TWO DOORS THAT LEAVE THE MACHINE: one message, one Google call.
 *
 * WHY THE SPAWN IS HERE AND NOT IN THE MCP BRIDGE. The bridge is a subprocess
 * the model's CLI talks to; whatever policy lived there would be policy the
 * agent's own process enforces on itself. Here the confirmation, the roster of
 * accounts, the containment of attachments and the trace on the card are one
 * server-side sequence, and the last of them is the only place a child process
 * is started. An agent that skips the bridge and calls this route by hand gets
 * the same gate.
 *
 * SHORT LEGS, like the human channel next door. A person may take minutes to
 * answer, and an HTTP request held open with no bytes flowing is what an idle
 * socket timeout kills client-side. So a call that is still waiting answers
 * `{pending:true}` and the bridge comes straight back; the question stays on
 * screen across legs because it lives in the ask rendez-vous, not in the
 * request.
 *
 * NOTHING IS SPAWNED BEFORE A PERSON SAYS SO, and "a person said so" is scoped
 * to ONE message: see `lib/outbound-gate.ts` for why this does not go through
 * the permission bridge (which is designed to be able to stop asking).
 */

/** How long a CLI may take before the call is a timeout instead of an answer. */
const CLI_TIMEOUT_MS = 120_000;

/** Bounds a leg the way the ask bridge does: short enough for any socket. */
const DEFAULT_LEG_MS = 25_000;

/** The subject line is quoted in the card trace; a book is not a subject. */
const SUBJECT_TRACE_CHARS = 120;

export interface OutboundRouterOptions {
  /** Injected so a test can point the CLIs at a fake executable. */
  env?: EnvMap;
  /** Injected so a test can look for that fake executable in a temp dir. */
  searchDirs?: string[];
  cliTimeoutMs?: number;
  /**
   * The board writer. Defaults to the real task service; injected by the test,
   * which has no board to write on and everything to check about WHAT would be
   * written.
   */
  comment?: (args: { taskId: string; projectId: string; content: string; options: string[]; sessionKey?: string }) => boolean;
}

/**
 * Read methods, by the verb the CLI uses. Everything else — including a method
 * nobody here recognises — counts as a WRITE and asks. A read misclassified as
 * a write costs one click; a write misclassified as a read is a change on
 * somebody's calendar that nobody approved.
 */
const READ_METHOD_PREFIXES = ["list", "get", "search", "export", "download", "read", "watch", "schema"];

export function googleCallWrites(method: string): boolean {
  const verb = method.trim().toLowerCase();
  if (!verb) return true;
  return !READ_METHOD_PREFIXES.some((prefix) => verb === prefix || verb.startsWith(prefix));
}

/** The identity of one message: same payload, same digest; one field differs, new question. */
export function payloadDigest(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 8);
}

function clampLeg(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(value, 100), 60_000)
    : DEFAULT_LEG_MS;
}

/** A one-line quote of a subject: enough to recognise it, not enough to repeat it. */
function shortSubject(subject: string): string {
  const flat = subject.replace(/\s+/g, " ").trim();
  return flat.length > SUBJECT_TRACE_CHARS ? `${flat.slice(0, SUBJECT_TRACE_CHARS)}...` : flat;
}

/**
 * The minimal environment a child gets. Not `process.env`: a CLI that reaches
 * the network has no business reading the server's tokens, and a short explicit
 * list is the only form of that promise anyone can check.
 *
 * `USER` IS IN THE LIST BECAUSE IT WAS MEASURED, not to be safe. Both CLIs read
 * their credentials from the macOS Keychain, and with `env -i` plus PATH and
 * HOME the lookup never returns: `gws drive files list` printed "Using keyring
 * backend: keyring" and then hung past 25s, twice. With `USER` present the same
 * call answered in a second (probed 2026-09-16 on this machine). A hang is the
 * worst shape this could have taken: it looks like a slow network, it burns the
 * whole CLI deadline, and it would have been discovered only in production.
 * `TMPDIR` was probed separately and changes nothing, so it is not here.
 */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: CLI_SEARCH_DIRS.join(":"),
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    ...extra,
  };
}

export function createOutboundRouter(ctx: AppContext, options: OutboundRouterOptions = {}): RouteHandler {
  const { json, readJSON, matchRoute, broadcastToAll, getTopicBySessionKey, updateToolCallFields } = ctx;
  const env = options.env ?? (process.env as EnvMap);
  const cliTimeoutMs = options.cliTimeoutMs ?? CLI_TIMEOUT_MS;

  /** The card this session works on, when it has one. */
  const cardOf = (sessionKey: string) => {
    try {
      return boardTaskForSession(ctx.db, sessionKey);
    } catch {
      return null;
    }
  };

  const addComment = options.comment ?? ((args: { taskId: string; projectId: string; content: string; options: string[]; sessionKey?: string }) => {
    try {
      const service = createTaskService(ctx.db);
      service.addComment({
        taskId: args.taskId,
        author: "agent",
        content: args.content,
        projectId: args.projectId,
        questionOptions: args.options,
        messageId: args.sessionKey ? ctx.isStreaming?.(args.sessionKey)?.messageId ?? null : null,
      });
      const task = service.get(args.taskId, { projectId: args.projectId })?.task;
      if (task) broadcastToAll({ type: "task:updated", projectId: args.projectId, task });
      return true;
    } catch {
      return false;
    }
  });

  /**
   * THE TRACE. Something left this machine (or was stopped on its way out), and
   * that is a fact of the card, not a line in a log file nobody opens. The body
   * is deliberately absent: who, what, to whom, and how it went.
   */
  const trace = (sessionKey: string, line: string): boolean => {
    const card = cardOf(sessionKey);
    if (!card) return false;
    return addComment({ taskId: card.taskId, projectId: card.projectId, content: line, options: [], sessionKey });
  };

  const gateDeps: OutboundGateDeps = {
    db: ctx.db,
    comment: addComment,
    deliver: (sessionKey, answers) => deliverAnswer(sessionKey, answers),
    lastToolRow: (sessionKey) => {
      try {
        const row = ctx.db
          .prepare("SELECT tool_calls, blocks FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 1")
          .get(sessionKey) as { tool_calls?: unknown; blocks?: unknown } | undefined;
        if (!row) return null;
        return { tool_calls: decodeCol(row.tool_calls), blocks: decodeCol(row.blocks) };
      } catch {
        return null;
      }
    },
    paint: ({ sessionKey, toolCallId, schema }) => {
      const topic = getTopicBySessionKey(sessionKey);
      updateToolCallFields(sessionKey, toolCallId, { status: "waiting_for_input", userInputSchema: schema });
      broadcastToAll({
        type: "stream:tool_user_input_required",
        sessionKey,
        topicId: topic?.id,
        toolCallId,
        schema,
      });
    },
  };

  /** The workspace an attachment must live inside: this session's own directory. */
  const workspaceOf = (sessionKey: string): string | null => {
    const topic = getTopicBySessionKey(sessionKey);
    const path = typeof topic?.projectPath === "string" ? topic.projectPath.trim() : "";
    return path ? path : null;
  };

  /**
   * Attachment paths, resolved inside the workspace.
   *
   * An agent picks these names from text it has read, so "inside" is checked
   * and not assumed: `../../.ssh/id_rsa` resolves perfectly well, and a mail
   * tool is a file exfiltration tool the moment it stops looking.
   */
  const resolveAttachments = (sessionKey: string, raw: unknown): { paths: string[] } | { error: string } => {
    if (raw === undefined || raw === null) return { paths: [] };
    if (!Array.isArray(raw)) return { error: "attachments must be an array of paths" };
    const wanted = raw.filter((p): p is string => typeof p === "string" && !!p.trim()).map((p) => p.trim());
    if (!wanted.length) return { paths: [] };
    const workspace = workspaceOf(sessionKey);
    if (!workspace) {
      return { error: "this session has no workspace directory: attachments can only be sent from a card or a project session" };
    }
    const paths: string[] = [];
    for (const candidate of wanted) {
      const full = isAbsolute(candidate) ? resolve(candidate) : resolve(workspace, candidate);
      if (!isInsideDir(full, workspace)) {
        return { error: `attachment "${candidate}" resolves outside this session workspace` };
      }
      if (!existsSync(full)) return { error: `attachment "${candidate}" does not exist in this session workspace` };
      paths.push(full);
    }
    return { paths };
  };

  /** The argv of one message, per transport. Arrays only: never a shell string. */
  const mailArgv = (account: MailAccount, message: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    attachments: string[];
  }): string[] => {
    if (account.transport === "exchange") {
      // The Exchange box is driven through its MCP-shaped CLI: one tool name and
      // one JSON argument. `confirm` is true here because the human gate above
      // is the confirmation that CLI is asking for.
      const payload = {
        to: message.to,
        subject: message.subject,
        text: message.body,
        ...(message.cc ? { cc: message.cc } : {}),
        ...(message.attachments.length ? { attachments: message.attachments.map((path) => ({ path })) } : {}),
        confirm: true,
      };
      return ["mail_send", JSON.stringify(payload)];
    }
    const argv = [
      account.name,
      "gmail",
      "+send",
      "--to",
      message.to,
      "--subject",
      message.subject,
      "--body",
      message.body,
    ];
    if (message.cc) argv.push("--cc", message.cc);
    for (const path of message.attachments) argv.push("--attach", path);
    return argv;
  };

  const refuse = (sessionKey: string, line: string, reason: string) => {
    trace(sessionKey, line);
    return json({ refused: true, reason });
  };

  return async function outboundRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    // POST /api/sessions/:sessionKey/outbound/mail
    {
      const match = matchRoute(pathname, "/api/sessions/:sessionKey/outbound/mail");
      if (match && method === "POST") {
        const sessionKey = decodeURIComponent(match.sessionKey);
        if (isGlobalOrchestratorSession(ctx.db, sessionKey)) {
          return json({ error: "the global coordinator does not send mail", code: "orchestrator_topic_invariant" }, 403);
        }
        const body = (await readJSON(req)) as Record<string, unknown> | null;
        const to = typeof body?.to === "string" ? body.to.trim() : "";
        const subject = typeof body?.subject === "string" ? body.subject : "";
        const text = typeof body?.body === "string" ? body.body : "";
        const cc = typeof body?.cc === "string" && body.cc.trim() ? body.cc.trim() : undefined;
        if (!to || !subject.trim() || !text.trim()) {
          return json({ error: "to, subject and body are required", code: "invalid_message" }, 400);
        }

        let roster;
        try {
          roster = readMailConfig(env);
        } catch (err) {
          if (err instanceof OutboundConfigError) {
            return json({ error: err.message, code: "outbound_not_configured", variable: err.variable }, 400);
          }
          throw err;
        }
        let account: MailAccount;
        try {
          account = pickAccount(roster, typeof body?.account === "string" ? body.account : undefined);
        } catch (err) {
          // A separate code from a missing variable: one is "nobody configured
          // this machine", the other is "you asked for a mailbox that is not
          // yours to use", and the agent's next move differs.
          if (err instanceof OutboundConfigError) {
            return json({ error: err.message, code: "unknown_account" }, 400);
          }
          throw err;
        }

        const attachments = resolveAttachments(sessionKey, body?.attachments);
        if ("error" in attachments) {
          return json({ error: attachments.error, code: "attachment_refused" }, 400);
        }

        const digest = payloadDigest([account.name, to, subject, text, cc ?? "", attachments.paths]);
        const quoted = shortSubject(subject);
        const summary = [
          `Invio una mail dall'account ${account.name}.`,
          `A: ${to}${cc ? ` (cc ${cc})` : ""}`,
          `Oggetto: ${quoted}`,
          attachments.paths.length ? `Allegati: ${attachments.paths.length}` : "Nessun allegato",
          `Corpo: ${text.trim().length} caratteri`,
        ].join("\n");

        let outcome: ConfirmOutcome;
        try {
          outcome = await confirmOutbound(gateDeps, {
            sessionKey,
            toolName: "mcp__topics__send_mail",
            header: "Posta",
            summary,
            digest,
            legMs: clampLeg(body?.legMs),
          });
        } catch (err) {
          return json({ refused: true, reason: err instanceof Error ? err.message : String(err) });
        }
        if (outcome.state === "pending") return json({ pending: true });
        if (outcome.state === "refused") {
          return refuse(
            sessionKey,
            `Invio NON partito (${account.name} a ${to}, oggetto "${quoted}"): ${outcome.reason}`,
            outcome.reason,
          );
        }

        let file: string;
        try {
          file = resolveCliPath(
            account.cli,
            account.transport === "exchange" ? "TOPICS_MAIL_EDM_CLI" : "TOPICS_MAIL_CLI",
            { searchDirs: options.searchDirs },
          );
        } catch (err) {
          if (err instanceof OutboundConfigError) {
            return json({ error: err.message, code: "outbound_not_configured", variable: err.variable }, 400);
          }
          throw err;
        }

        const run = await runCli({
          file,
          argv: mailArgv(account, { to, subject, body: text, cc, attachments: attachments.paths }),
          env: childEnv(),
          timeoutMs: cliTimeoutMs,
        });
        const failure = run.timedOut
          ? `the CLI did not answer within ${Math.round(cliTimeoutMs / 1000)}s`
          : run.exitCode !== 0
            ? `the CLI exited ${run.exitCode}: ${(run.stderr || run.stdout).trim().slice(0, 400)}`
            : "";
        if (failure) {
          trace(sessionKey, `Invio FALLITO (${account.name} a ${to}, oggetto "${quoted}"): ${failure}`);
          return json({ error: failure, code: "send_failed" }, 502);
        }
        const traced = trace(sessionKey, `Mail inviata: da ${account.name} a ${to}, oggetto "${quoted}"${attachments.paths.length ? `, ${attachments.paths.length} allegati` : ""} - riuscito`);
        return json({ sent: true, account: account.name, to, subject: quoted, traced });
      }
    }

    // POST /api/sessions/:sessionKey/outbound/google
    {
      const match = matchRoute(pathname, "/api/sessions/:sessionKey/outbound/google");
      if (match && method === "POST") {
        const sessionKey = decodeURIComponent(match.sessionKey);
        if (isGlobalOrchestratorSession(ctx.db, sessionKey)) {
          return json({ error: "the global coordinator does not call Google", code: "orchestrator_topic_invariant" }, 403);
        }
        const body = (await readJSON(req)) as Record<string, unknown> | null;
        const service = typeof body?.service === "string" ? body.service.trim() : "";
        const resource = typeof body?.resource === "string" ? body.resource.trim() : "";
        const subresource = typeof body?.subresource === "string" ? body.subresource.trim() : "";
        const apiMethod = typeof body?.method === "string" ? body.method.trim() : "";
        if (!service || !resource || !apiMethod) {
          return json({ error: "service, resource and method are required", code: "invalid_call" }, 400);
        }
        // `params` and `body` travel as JSON TEXT, one argv element each. They
        // are re-serialised here rather than forwarded verbatim so a string
        // that is not JSON cannot become a flag.
        const params = body?.params === undefined || body?.params === null ? null : JSON.stringify(body.params);
        const requestBody = body?.body === undefined || body?.body === null ? null : JSON.stringify(body.body);

        let config;
        try {
          config = readGoogleConfig(env);
        } catch (err) {
          if (err instanceof OutboundConfigError) {
            return json({ error: err.message, code: "outbound_not_configured", variable: err.variable }, 400);
          }
          throw err;
        }

        const call = [service, resource, subresource, apiMethod].filter(Boolean).join(" ");
        if (googleCallWrites(apiMethod)) {
          const digest = payloadDigest([service, resource, subresource, apiMethod, params, requestBody]);
          const summary = [
            `Chiamata Google che SCRIVE: ${call}`,
            params ? `params: ${params.slice(0, 300)}` : "params: nessuno",
            requestBody ? `body: ${requestBody.slice(0, 300)}` : "body: nessuno",
          ].join("\n");
          let outcome: ConfirmOutcome;
          try {
            outcome = await confirmOutbound(gateDeps, {
              sessionKey,
              toolName: "mcp__topics__google_call",
              header: "Google",
              summary,
              digest,
              legMs: clampLeg(body?.legMs),
            });
          } catch (err) {
            return json({ refused: true, reason: err instanceof Error ? err.message : String(err) });
          }
          if (outcome.state === "pending") return json({ pending: true });
          if (outcome.state === "refused") {
            return refuse(sessionKey, `Scrittura Google NON eseguita (${call}): ${outcome.reason}`, outcome.reason);
          }
        }

        let file: string;
        try {
          file = resolveCliPath(config.cli, "TOPICS_GOOGLE_CLI", { searchDirs: options.searchDirs });
        } catch (err) {
          if (err instanceof OutboundConfigError) {
            return json({ error: err.message, code: "outbound_not_configured", variable: err.variable }, 400);
          }
          throw err;
        }

        const argv = [service, resource, ...(subresource ? [subresource] : []), apiMethod];
        if (params) argv.push("--params", params);
        if (requestBody) argv.push("--json", requestBody);
        argv.push("--format", "json");

        const run = await runCli({
          file,
          argv,
          env: childEnv({
            // The names the CLI itself reads. The Topics-side variables are the
            // ones a person writes; this is where they are handed over.
            GOOGLE_WORKSPACE_CLI_CONFIG_DIR: config.configDir,
            GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: config.clientSecret,
          }),
          timeoutMs: cliTimeoutMs,
        });
        const failure = run.timedOut
          ? `the CLI did not answer within ${Math.round(cliTimeoutMs / 1000)}s`
          : run.exitCode !== 0
            ? `the CLI exited ${run.exitCode}: ${(run.stderr || run.stdout).trim().slice(0, 400)}`
            : "";
        if (failure) {
          if (googleCallWrites(apiMethod)) trace(sessionKey, `Scrittura Google FALLITA (${call}): ${failure}`);
          return json({ error: failure, code: "google_call_failed" }, 502);
        }
        const traced = googleCallWrites(apiMethod)
          ? trace(sessionKey, `Scrittura Google eseguita: ${call} - riuscita`)
          : false;
        return json({ ok: true, call, output: run.stdout, traced });
      }
    }

    return null;
  };
}
