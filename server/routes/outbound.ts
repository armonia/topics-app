import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { AppContext, RouteHandler } from "../types";
import { isInsideDir } from "../lib/path-containment";
import { realPathForNewEntry } from "../lib/real-path";
import {
  OutboundConfigError,
  pickAccount,
  readGoogleClient,
  readGoogleConfig,
  readMailConfig,
  type EnvMap,
  type MailAccount,
} from "../lib/outbound-config";
import { resolveCliPath, runCli } from "../lib/outbound-cli";
import { confirmOutbound, findWaitingToolRow, type ConfirmOutcome, type OutboundGateDeps } from "../lib/outbound-gate";
import { MAIL_DELIVERY_KIND, mailDeliveryKey, type MailLedger, type MailPayload } from "../lib/outbound-mail-ledger";
import { childEnv, createMailSend, shortSubject } from "./outbound-mail-send";
import { discardStaging, freezeAttachments, OutboundStagingError, type FrozenAttachments } from "../lib/outbound-staging";
import { announcedCut, decodeRawMail, gmailSendsMail, googleWriteSummary } from "../lib/outbound-summary";
import { flushTurnBody } from "../lib/turn-body-flush";
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


/**
 * How much of the body the person reads BEFORE deciding.
 *
 * The board's own rule: "if you ask 'do you confirm X?' the human has to be
 * able to see X". A confirmation that showed only the recipient and a character
 * count would be a signature on a sealed envelope, which is not consent to
 * anything. The cap exists so a long draft does not bury the two buttons under
 * it; what is cut is announced, and the whole text is in the agent's own
 * message anyway.
 */
const BODY_PREVIEW_CHARS = 1500;

export interface OutboundRouterOptions {
  /** Injected so a test can point the CLIs at a fake executable. */
  env?: EnvMap;
  /** Injected so a test can look for that fake executable in a temp dir. */
  searchDirs?: string[];
  /**
   * Where the frozen copies of the attachments are staged. Injected for the
   * same reason as the two above: a test that used the default would write
   * fixtures into the real `~/.topics` and have the sweeper loose in it.
   */
  stagingRoot?: string;
  cliTimeoutMs?: number;
  /**
   * The board writer. Defaults to the real task service; injected by the test,
   * which has no board to write on and everything to check about WHAT would be
   * written.
   */
  comment?: (args: { taskId: string; projectId: string; content: string; options: string[]; sessionKey?: string; quiet?: boolean }) => string | null;
  /** The register of the sends. Defaults to the app database; a test passes one on a real SQLite file. */
  ledger?: MailLedger;
}

/**
 * Read methods, by the verb the CLI uses. Everything else — including a method
 * nobody here recognises — counts as a WRITE and asks. A read misclassified as
 * a write costs one click; a write misclassified as a read is a change on
 * somebody's calendar that nobody approved.
 */
const READ_METHOD_PREFIXES = ["list", "get", "search", "export", "download", "read", "schema"];

export function googleCallWrites(method: string): boolean {
  const verb = method.trim().toLowerCase();
  if (!verb) return true;
  return !READ_METHOD_PREFIXES.some((prefix) => verb === prefix || verb.startsWith(prefix));
}

/**
 * What the four fields of a Google call may look like.
 *
 * The API path of the CLI is `gmail users messages list`: names. The four
 * strings are handed to `runCli` as argv elements, so anything else in them is
 * an argument to a command, which is a second interface nobody wrote down -
 * `{resource: "+forward", subresource: "--message-id=...", method: "--to=..."}`
 * was a complete, valid `gws` command and it forwards a mailbox message, with
 * its attachments, to any address.
 */
const API_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.]*$/;

/** The identity of one message: same payload, same digest; one field differs, new question. */
export function payloadDigest(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 8);
}

function clampLeg(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(value, 100), 60_000)
    : DEFAULT_LEG_MS;
}

/**
 * The hold token the PREVIOUS leg of this request was given, echoed back.
 *
 * It is the only thing that tells one request's second leg apart from a second
 * request carrying a byte-identical payload - same digest, same question, same
 * everything - and those two must get opposite answers: the leg renews the card,
 * the stranger is refused. Absent on the first leg, and absent from a caller
 * that does not know about it, which is right: it then asks for a hold of its
 * own and gets one only if the card is free.
 */
function holdToken(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** One attachment, named and contained. Its BYTES are frozen further down. */
interface ResolvedAttachment {
  /** The REAL path, with every link already resolved: this is what gets read. */
  path: string;
  name: string;
}

/** A size a person reads at a glance. An attachment nobody weighed is a surprise. */
function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

  const addComment = options.comment ?? ((args: { taskId: string; projectId: string; content: string; options: string[]; sessionKey?: string; quiet?: boolean }) => {
    try {
      const service = createTaskService(ctx.db);
      const written = service.addComment({
        taskId: args.taskId,
        author: "agent",
        content: args.content,
        projectId: args.projectId,
        questionOptions: args.options,
        messageId: args.sessionKey ? ctx.isStreaming?.(args.sessionKey)?.messageId ?? null : null,
        ...(args.quiet ? { quiet: true } : {}),
      });
      const task = service.get(args.taskId, { projectId: args.projectId })?.task;
      if (task) broadcastToAll({ type: "task:updated", projectId: args.projectId, task });
      // The id of the row, not a yes/no: a confirmation is answered by clicking
      // THAT comment, and the registry compares the two.
      return written?.id ?? null;
    } catch {
      return null;
    }
  });

  /**
   * THE TRACE. Something left this machine (or was stopped on its way out), and
   * that is a fact of the card, not a line in a log file nobody opens. The body
   * is deliberately absent: who, what, to whom, and how it went.
   *
   * `quiet` BECAUSE A TRACE IS NOT AN ANSWER, and that flag is the one place
   * where the writer gets to say so (`TaskComment.quiet`, read by
   * `pendingQuestionComment`). Without it this line SILENCED the question above
   * it: the scan for the open question stops on the first agent row that is
   * neither a question nor a delivery, so a refusal written under a live
   * confirmation of another request took its buttons away and, with them, the
   * `answerTo` the drawer sends - measured, `pendingQuestionComment -> null`
   * with the trace in the thread and the question without it. The alternative,
   * holding the line back until the question is answered, would mean an agent
   * told "nothing was sent" while the card says nothing at all; the trace must
   * be written when it is true, so it is written in a shape that answers
   * nothing. It stays a normal comment everywhere else: visible in the thread,
   * counted as the card's last word.
   */
  const trace = (sessionKey: string, line: string): boolean => {
    const card = cardOf(sessionKey);
    if (!card) return false;
    return !!addComment({ taskId: card.taskId, projectId: card.projectId, content: line, options: [], sessionKey, quiet: true });
  };

  const gateDeps: OutboundGateDeps = {
    db: ctx.db,
    comment: addComment,
    deliver: (sessionKey, answers) => deliverAnswer(sessionKey, answers),
    lastToolRow: (sessionKey, toolName) => {
      try {
        // THE ROW IS WRITTEN LATE, so it is asked for first. `blocks` is the
        // only column carrying tool calls on a modern row, and it goes through
        // a throttle that can owe the write for up to fifteen seconds: a
        // `send_mail` that is not the first tool of its turn was simply not
        // there yet, and "not persisted yet" was being read as "nobody to ask".
        // Same move `routes/chat.ts` already makes when a tool stops to ask.
        flushTurnBody(sessionKey);
        // NOT ONLY THE LAST ROW. A turn the watchdog closed keeps working under
        // the resume sweep's notice, and reading the notice alone refused the
        // send with "nobody could confirm" while the person was there (card
        // 1046df0b). Same short window as the answer route's lookup
        // (`lib/ask-answer-routing.ts`), newest first, stopping at the first hit.
        const rows = ctx.db
          .prepare("SELECT id, tool_calls, blocks FROM messages WHERE session_key = ? ORDER BY sort_order DESC LIMIT 20")
          .all(sessionKey) as Array<{ id: string; tool_calls?: unknown; blocks?: unknown }>;
        for (const row of rows) {
          const columns = { id: String(row.id), tool_calls: decodeCol(row.tool_calls), blocks: decodeCol(row.blocks) };
          if (findWaitingToolRow(columns, toolName)) return columns;
        }
        return null;
      } catch {
        return null;
      }
    },
    paint: ({ sessionKey, toolCallId, schema, rowId }) => {
      const topic = getTopicBySessionKey(sessionKey);
      // On the row the call was found on, by id: the last row may be a notice
      // written after it. The reader above always hands the id over.
      if (rowId) updateToolCallFields(sessionKey, toolCallId, { status: "waiting_for_input", userInputSchema: schema }, { rowId });
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
   *
   * THE DECISION RUNS ON THE REAL PATH, and that is the half `../` does not
   * cover. `isInsideDir` normalises `..` and says so itself, in the same breath
   * in which it says it does NOT follow a symlink: "a link inside an allowed
   * root pointing at /etc would produce a string that is impeccable". An agent
   * has a shell in its own worktree, so writing that link costs it one command
   * (`ln -s ~/.topics-server-env preventivo.pdf`) and the string check waves it
   * through. Same rule, same reason, same shape as `browser-tool-dispatcher.ts`
   * in front of `checkUploadPath`: resolve first, decide after.
   *
   * RESOLVING IS NOT FREEZING, and this function does only the first. The real
   * path is what gets decided on, but the BYTES behind it are still the
   * workspace's, and the workspace belongs to an agent that keeps its shell
   * while the person reads. What leaves is the copy `freezeAttachments` takes
   * at question time - see `lib/outbound-staging.ts` for the race that is.
   */
  const resolveAttachments = (
    sessionKey: string,
    raw: unknown,
  ): { files: ResolvedAttachment[] } | { error: string } => {
    if (raw === undefined || raw === null) return { files: [] };
    if (!Array.isArray(raw)) return { error: "attachments must be an array of paths" };
    const wanted = raw.filter((p): p is string => typeof p === "string" && !!p.trim()).map((p) => p.trim());
    if (!wanted.length) return { files: [] };
    const workspace = workspaceOf(sessionKey);
    if (!workspace) {
      return { error: "this session has no workspace directory: attachments can only be sent from a card or a project session" };
    }
    // The root is resolved too: on macOS a project under `/tmp` lives at
    // `/private/tmp`, and comparing a real path against a linked root would
    // refuse every legitimate file in it.
    const root = realPathForNewEntry(workspace) ?? resolve(workspace);
    const files: ResolvedAttachment[] = [];
    for (const candidate of wanted) {
      const full = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
      const real = realPathForNewEntry(full);
      if (!real) {
        return { error: `attachment "${candidate}" cannot be resolved: a broken link, or a path this server cannot read` };
      }
      if (!isInsideDir(real, root)) {
        return { error: `attachment "${candidate}" resolves outside this session workspace` };
      }
      if (!existsSync(real)) return { error: `attachment "${candidate}" does not exist in this session workspace` };
      files.push({ path: real, name: basename(real) });
    }
    return { files };
  };


  const refuse = (sessionKey: string, line: string, reason: string) => {
    trace(sessionKey, line);
    return json({ refused: true, reason });
  };

  const { ledger, answerKnown, sendConfirmed } = createMailSend({
    db: ctx.db, ledger: options.ledger, env, searchDirs: options.searchDirs, cliTimeoutMs, trace, json,
  });

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
        // A KEY ALREADY DECIDED IS ANSWERED FROM THE REGISTER, before anything
        // else runs: the retry of a call whose answer was lost, or the first leg
        // after a restart, must not open a second question for the same mail.
        const deliveryKey = mailDeliveryKey(body?.key);
        if (deliveryKey) {
          const known = ledger.registry.get(deliveryKey);
          if (known && known.state !== "pending") return answerKnown(deliveryKey, holdToken(body?.hold));
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

        // THE BYTES ARE FROZEN HERE, before anybody is asked. Everything below
        // - the digest, the question, the argv - is about the copy.
        let frozen: FrozenAttachments;
        try {
          frozen = freezeAttachments(sessionKey, attachments.files, { root: options.stagingRoot });
        } catch (err) {
          if (err instanceof OutboundStagingError) {
            return json({ error: err.message, code: "attachment_refused" }, 400);
          }
          throw err;
        }

        // The identity of the message includes the FINGERPRINT of every
        // attachment, not its path: swapped bytes are a different message, so
        // they get a different question instead of riding the previous yes.
        const digest = payloadDigest([
          account.name, to, subject, text, cc ?? "",
          frozen.files.map((f) => [f.name, f.bytes, f.sha256]),
        ]);
        const quoted = shortSubject(subject);
        const preview = announcedCut(text.trim(), BODY_PREVIEW_CHARS);
        // THE FILES ARE NAMED, not counted. "Allegati: 1" is the sealed
        // envelope this route refuses for the body two constants above: a
        // person who cannot see WHICH file leaves cannot stop the one that
        // should not, and the workspace of a card is the whole project
        // directory - `data/topics.db` is in there, and it counts as one.
        const attachmentLine = frozen.files.length
          ? `Allegati (${frozen.files.length}): ${frozen.files.map((f) => `${f.name} (${humanBytes(f.bytes)}, sha256 ${f.shortSha})`).join(", ")}`
          : "Nessun allegato";
        const summary = [
          `Invio una mail dall'account ${account.name}.`,
          `A: ${to}${cc ? ` (cc ${cc})` : ""}`,
          `Oggetto: ${quoted}`,
          attachmentLine,
          "",
          preview,
        ].join("\n");

        // THE ROW IS WRITTEN BEFORE ANYBODY IS ASKED, and it holds the message:
        // a restart between now and the answer keeps both the question and what
        // it is about. A key that exists already is this call's own earlier leg.
        const payload: MailPayload = { sessionKey, account: account.name, to, subject, body: text, ...(cc ? { cc } : {}), frozen };
        if (deliveryKey) {
          const known = ledger.registry.payloadOf<MailPayload>(deliveryKey);
          if (!ledger.registry.hold(deliveryKey, MAIL_DELIVERY_KIND, payload) && known) payload.askId = known.askId;
        }

        let outcome: ConfirmOutcome;
        try {
          outcome = await confirmOutbound(gateDeps, {
            sessionKey,
            toolName: "mcp__topics__send_mail",
            header: "Posta",
            summary,
            digest,
            legMs: clampLeg(body?.legMs),
            hold: holdToken(body?.hold),
          });
        } catch (err) {
          discardStaging(frozen.dir);
          const reason = err instanceof Error ? err.message : String(err);
          if (deliveryKey) ledger.registry.drop(deliveryKey, reason);
          return refuse(sessionKey, `Invio NON partito (${account.name} a ${to}, oggetto "${quoted}"): ${reason}`, reason);
        }
        // `pending` KEEPS the copies: the next leg re-reads the same bytes,
        // lands on the same staging directory and asks the same question. What
        // a server killed mid-confirmation leaves behind is swept by age.
        if (outcome.state === "pending") {
          // The thread row goes into the register row: it is how a click on it
          // finds this message once nobody is polling any more.
          if (deliveryKey && outcome.askId && outcome.askId !== payload.askId) {
            ledger.registry.updatePayload(deliveryKey, { ...payload, askId: outcome.askId });
          }
          // A click after a restart may have sent it from the row meanwhile.
          if (deliveryKey && ledger.registry.get(deliveryKey)?.state !== "pending") return answerKnown(deliveryKey, holdToken(body?.hold));
          return json({ pending: true, hold: outcome.hold });
        }
        if (outcome.state === "refused") {
          discardStaging(frozen.dir);
          if (deliveryKey) {
            if (!ledger.registry.drop(deliveryKey, outcome.reason)) return answerKnown(deliveryKey, holdToken(body?.hold));
          }
          return refuse(
            sessionKey,
            `Invio NON partito (${account.name} a ${to}, oggetto "${quoted}"): ${outcome.reason}`,
            outcome.reason,
          );
        }

        if (deliveryKey) {
          // ONE YES, ONE SEND. `pending` to `delivering` is the conditional
          // update both roads go through: a click on the question after a
          // restart and this leg cannot both win it.
          if (!ledger.registry.start(deliveryKey)) return answerKnown(deliveryKey, holdToken(body?.hold));
        }
        const sent = await sendConfirmed(payload, account, deliveryKey);
        return json(sent.body, sent.status);
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
        // THE OTHER MAIL DOOR IS CLOSED HERE. `gws gmail users messages send`
        // sends a message without ever passing the gate `send_mail` stands in
        // front of, and its own confirmation showed base64 cut in half. One act
        // gets one door: the tool that can show the message to a person.
        if (gmailSendsMail({ service, resource, subresource, method: apiMethod })) {
          return json({
            error: "this call sends mail: use send_mail, which shows the message to a person before anything leaves and traces it on the card",
            code: "use_send_mail",
          }, 400);
        }
        // AND THE FOUR FIELDS ARE NAMES, NOT ARGUMENTS. They become argv
        // verbatim, so a field starting with a dash was a FLAG for the CLI:
        // `subresource: "--upload-file=..."` rode through on a read verb, which
        // asks nobody. The refusal above is a list of calls and cannot cover a
        // shape it never sees; this covers the shape. Letters, digits, dot and
        // underscore is what an API path is made of - a `+helper` and a
        // `--flag` are not.
        if (![service, resource, subresource, apiMethod].filter(Boolean).every((part) => API_IDENTIFIER.test(part))) {
          return json({
            error: "service, resource, subresource and method are API names (letters, digits, dot, underscore): this door is not a command line, and a `+helper` or a `--flag` is refused here",
            code: "invalid_call",
          }, 400);
        }
        // `params` and `body` travel as JSON TEXT, one argv element each. They
        // are re-serialised here rather than forwarded verbatim so a string
        // that is not JSON cannot become a flag.
        const params = body?.params === undefined || body?.params === null ? null : JSON.stringify(body.params);
        const requestBody = body?.body === undefined || body?.body === null ? null : JSON.stringify(body.body);

        let config;
        let client;
        try {
          config = readGoogleConfig(env);
          client = readGoogleClient(config.clientSecretFile, (path) => readFileSync(path, "utf8"));
        } catch (err) {
          if (err instanceof OutboundConfigError) {
            return json({ error: err.message, code: "outbound_not_configured", variable: err.variable }, 400);
          }
          throw err;
        }

        const call = [service, resource, subresource, apiMethod].filter(Boolean).join(" ");
        // A message can still ride a write that does not send (a draft): what it
        // says is read out of it for the question and for the trace.
        const carried = decodeRawMail(body?.body);
        if (googleCallWrites(apiMethod)) {
          const digest = payloadDigest([service, resource, subresource, apiMethod, params, requestBody]);
          // A SUMMARY SOMEBODY CAN READ. What stood here printed the body cut
          // at 300 characters, which on a Gmail call is base64 stopped halfway:
          // recipient, subject and text invisible, the signature on a sealed
          // envelope OUTBOUND-03 forbids.
          const summary = googleWriteSummary({
            call,
            params,
            body: requestBody,
            bodyValue: body?.body,
            maxChars: BODY_PREVIEW_CHARS,
          });
          let outcome: ConfirmOutcome;
          try {
            outcome = await confirmOutbound(gateDeps, {
              sessionKey,
              toolName: "mcp__topics__google_call",
              header: "Google",
              summary,
              digest,
              legMs: clampLeg(body?.legMs),
              hold: holdToken(body?.hold),
            });
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return refuse(sessionKey, `Scrittura Google NON eseguita (${call}): ${reason}`, reason);
          }
          if (outcome.state === "pending") return json({ pending: true, hold: outcome.hold });
          if (outcome.state === "refused") {
            return refuse(sessionKey, `Scrittura Google NON eseguita (${call}): ${outcome.reason}`, outcome.reason);
          }
        }

        let file: string;
        try {
          file = resolveCliPath(config.cli, "TOPICS_GOOGLE_CLI", { searchDirs: options.searchDirs });
        } catch (err) {
          if (err instanceof OutboundConfigError) {
            // Same reason as the mail route: a write the person approved and
            // that never ran is a fact of the card. A read that cannot run is
            // not - nobody was asked, and nothing was promised.
            if (googleCallWrites(apiMethod)) trace(sessionKey, `Scrittura Google FALLITA (${call}): ${err.message}`);
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
            // ones a person writes; this is where they are handed over. Not
            // `..._CREDENTIALS_FILE`: that one wants an authorized-USER file and
            // refuses an installed-app client (measured, see `readGoogleClient`).
            GOOGLE_WORKSPACE_CLI_CONFIG_DIR: config.configDir,
            GOOGLE_WORKSPACE_CLI_CLIENT_ID: client.clientId,
            GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: client.clientSecret,
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
        // WHO AND WHAT, when the call carried a message: a trace that names only
        // the method says a write happened and nothing about what left.
        const addressed = carried ? ` (a ${carried.to || "?"}, oggetto "${shortSubject(carried.subject)}")` : "";
        const traced = googleCallWrites(apiMethod)
          ? trace(sessionKey, `Scrittura Google eseguita: ${call}${addressed} - riuscita`)
          : false;
        return json({ ok: true, call, output: run.stdout, traced });
      }
    }

    return null;
  };
}
