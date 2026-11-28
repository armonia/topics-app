/**
 * WHAT HAPPENS TO A MAIL AFTER THE YES, kept out of `outbound.ts` so the route
 * stays the gate and this file stays the send.
 *
 * One road to the CLI for the leg that held the question and for a yes given
 * on a question nobody polls any more (a restart, an agent that stopped), and
 * every outcome written in the delivery register: see
 * `lib/outbound-mail-ledger.ts` for its states and the boot rule.
 */
import type { Database } from "bun:sqlite";
import { CLI_SEARCH_DIRS, resolveCliPath, runCli } from "../lib/outbound-cli";
import { OutboundConfigError, pickAccount, readMailConfig, type EnvMap, type MailAccount } from "../lib/outbound-config";
import { CONFIRM_LABEL } from "../lib/outbound-gate";
import { createMailLedger, messageIdOf, registerPendingMailAnswer, registerPendingMailChatAnswer, type MailLedger, type MailPayload, type MailSentRecord } from "../lib/outbound-mail-ledger";
import { discardStaging, verifyFrozen } from "../lib/outbound-staging";

/** The subject line is quoted in the card trace; a book is not a subject. */
const SUBJECT_TRACE_CHARS = 120;

/** A one-line quote of a subject: enough to recognise it, not enough to repeat it. */
export function shortSubject(subject: string): string {
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
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: CLI_SEARCH_DIRS.join(":"),
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    ...extra,
  };
}

/** The argv of one message, per transport. Arrays only: never a shell string. */
function mailArgv(account: MailAccount, message: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  attachments: string[];
}): string[] {
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
}

export interface MailSendDeps {
  db: Database;
  ledger?: MailLedger;
  env: EnvMap;
  searchDirs?: string[];
  cliTimeoutMs: number;
  trace: (sessionKey: string, line: string) => boolean;
  json: (data: unknown, status?: number) => Response;
}

export function createMailSend(deps: MailSendDeps) {
  const { trace, json, env, cliTimeoutMs } = deps;
  // THE REGISTER OF THE SENDS, the schedule engine's own (`deliveries`): see
  // `lib/outbound-mail-ledger.ts` for the states and why there is no second one.
  const ledger = deps.ledger ?? createMailLedger(deps.db);

  /**
   * The answer a key already decided gets, whatever leg or retry asks: the
   * bridge that lost the HTTP answer of the send reads it here, and nothing is
   * spawned a second time.
   */
  const answerKnown = (key: string, hold?: string): Response => {
    const row = ledger.registry.get(key);
    if (!row || row.state === "pending" || row.state === "delivering") return json({ pending: true, ...(hold ? { hold } : {}) });
    if (row.state === "delivered") {
      let record: Partial<MailSentRecord> = {};
      try { record = JSON.parse(row.detail ?? "{}") as MailSentRecord; } catch { /* an older detail is still a send */ }
      return json({ sent: true, ...record });
    }
    if (row.state === "delivery_failed") return json({ error: row.detail ?? "the send failed", code: "send_failed" }, 502);
    if (row.state === "unknown") return json({ unknown: true, reason: row.detail ?? "the server stopped while this mail was being sent" });
    return json({ refused: true, reason: row.detail ?? "the person did not confirm" });
  };

  /**
   * AFTER THE YES, the one road to the CLI, for the leg that held the question
   * and for a click that arrives after a restart alike. With a key the row is
   * already `delivering` (written before this is called), and its outcome is
   * written here.
   */
  const sendConfirmed = async (
    message: MailPayload,
    account: MailAccount,
    key: string | null,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const { sessionKey, to, subject, body: text, cc, frozen } = message;
    const quoted = shortSubject(subject);
    const attachedPaths = frozen.files.map((f) => f.path);

    // THE COPIES ARE READ AGAIN, after the yes and before anything is
    // spawned. The staging directory belongs to the user the server runs
    // as, which is the user the agents run as too: what keeps the bytes
    // honest is not the mode of that directory but this check, which turns
    // the window from "the minutes a person spends reading" into "one
    // process start". IT DOES NOT CLOSE IT: that remainder was reproduced,
    // and `/dev/fd/N` does not close it either - this CLI refuses the
    // descriptor twice over, at the path containment check and at the read.
    // The two measures and their exact text are in the header of
    // `outbound-staging.ts`.
    try {
      verifyFrozen(frozen);
    } catch (err) {
      discardStaging(frozen.dir);
      const reason = err instanceof Error ? err.message : String(err);
      if (key) ledger.registry.finish(key, "not_delivered", reason);
      trace(sessionKey, `Invio NON partito (${account.name} a ${to}, oggetto "${quoted}"): ${reason}`);
      return { status: 200, body: { refused: true, reason } };
    }

    let file: string;
    try {
      file = resolveCliPath(
        account.cli,
        account.transport === "exchange" ? "TOPICS_MAIL_EDM_CLI" : "TOPICS_MAIL_CLI",
        { searchDirs: deps.searchDirs },
      );
    } catch (err) {
      if (err instanceof OutboundConfigError) {
        // PAST THE YES. The person confirmed and nothing left: that is the
        // same fact as a CLI exiting non-zero, and OUTBOUND-05 asks for the
        // same line. Without it a confirmed send that never happened exists
        // only in the agent's own message.
        discardStaging(frozen.dir);
        if (key) ledger.registry.finish(key, "delivery_failed", err.message);
        trace(sessionKey, `Invio FALLITO (${account.name} a ${to}, oggetto "${quoted}"): ${err.message}`);
        return { status: 400, body: { error: err.message, code: "outbound_not_configured", variable: err.variable } };
      }
      if (key) ledger.registry.finish(key, "delivery_failed", err instanceof Error ? err.message : String(err));
      throw err;
    }

    const run = await runCli({
      file,
      argv: mailArgv(account, { to, subject, body: text, cc, attachments: attachedPaths }),
      env: childEnv(),
      // THE CHILD RUNS WHERE THE COPIES ARE, and this is not tidiness.
      // Measured on the real `gws` (`+send --dry-run`, nothing sent): an
      // `--attach` whose path resolves OUTSIDE the current directory comes
      // back "resolves to '...' which is outside the current directory",
      // code 400, reason `validationError`. The frozen copies live under
      // `~/.topics` while the server's own cwd is wherever launchd started
      // it, so without this line no confirmed attachment could ever have
      // left - the person said yes and the CLI refused the file.
      //
      // The paths stay ABSOLUTE: `gws` canonicalises them anyway, and a
      // relative name would be one more thing that means something
      // different depending on where the process stands.
      ...(frozen.dir ? { cwd: frozen.dir } : {}),
      timeoutMs: cliTimeoutMs,
    });
    // The CLI has read them, whichever way it went: nothing is waiting for
    // these bytes any more.
    discardStaging(frozen.dir);
    const failure = run.timedOut
      ? `the CLI did not answer within ${Math.round(cliTimeoutMs / 1000)}s`
      : run.exitCode !== 0
        ? `the CLI exited ${run.exitCode}: ${(run.stderr || run.stdout).trim().slice(0, 400)}`
        : "";
    if (failure) {
      // Final for this key: a retry of the same call reads this, it never
      // starts the CLI again.
      if (key) ledger.registry.finish(key, "delivery_failed", failure);
      trace(sessionKey, `Invio FALLITO (${account.name} a ${to}, oggetto "${quoted}"): ${failure}`);
      return { status: 502, body: { error: failure, code: "send_failed" } };
    }
    // THE TRACE SAYS WHAT WAS CONFIRMED, and names it by its fingerprint.
    // It is not a proof of the bytes the CLI read - between the last
    // re-read and the CLI's own `open` there is a whole process start, and
    // an attacker inside this uid can win it (see `outbound-staging.ts`).
    // Writing the short sha is what makes the line CHECKABLE later instead
    // of a claim: the same eight characters the person read in the question.
    const attachedNames = frozen.files.map((f) => `${f.name} (sha256 ${f.shortSha})`).join(", ");
    const traced = trace(sessionKey, `Mail inviata: da ${account.name} a ${to}, oggetto "${quoted}"${attachedNames ? `, allegati confermati: ${attachedNames}` : ""} - riuscito`);
    const messageId = messageIdOf(run.stdout);
    const record: MailSentRecord = { account: account.name, to, subject: quoted, traced, ...(messageId ? { messageId } : {}) };
    if (key) ledger.registry.finish(key, "delivered", JSON.stringify(record));
    return { status: 200, body: { sent: true, ...record } };
  };

  // BOOT: a mail that was leaving when the last process stopped may be out.
  // It is never sent again by itself, and the card says so once.
  try {
    for (const { payload } of ledger.recoverAtBoot()) {
      trace(payload.sessionKey, `Invio forse partito (${payload.account} a ${payload.to}, oggetto "${shortSubject(payload.subject)}"): il server si e' fermato mentre la mail partiva. Non la rimando da solo: controlla la posta inviata prima di chiederla di nuovo.`);
    }
  } catch {
    // A database without the register (a test double, a broken file) has no
    // mail to recover; the routes below still answer.
  }

  // A yes on a question nobody is polling any more (a restart, an agent
  // that stopped) is still a yes to THAT message: the server sends from the row.
  const answerPending = (key: string | null, answer: string): boolean => {
    const message = key ? ledger.registry.payloadOf<MailPayload>(key) : null;
    if (!key || !message) return false;
    const quoted = shortSubject(message.subject);
    const said = answer.trim();
    if (said.toLowerCase() !== CONFIRM_LABEL.toLowerCase()) {
      if (ledger.registry.drop(key, `the person answered "${said}"`)) {
        discardStaging(message.frozen.dir);
        trace(message.sessionKey, `Invio NON partito (${message.account} a ${message.to}, oggetto "${quoted}"): la risposta e' stata "${said}"`);
      }
      return true;
    }
    let account: MailAccount;
    try {
      account = pickAccount(readMailConfig(env), message.account);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (ledger.registry.drop(key, reason)) {
        discardStaging(message.frozen.dir);
        trace(message.sessionKey, `Invio NON partito (${message.account} a ${message.to}, oggetto "${quoted}"): ${reason}`);
      }
      return true;
    }
    if (!ledger.registry.start(key)) return true;
    void sendConfirmed(message, account, key).catch((error) => console.warn("[outbound] send from the register failed:", error));
    return true;
  };
  registerPendingMailAnswer((askId, answer) => answerPending(ledger.pendingByAsk(askId), answer));
  registerPendingMailChatAnswer((sessionKey, toolCallId, answer) => answerPending(ledger.pendingByToolCall(sessionKey, toolCallId), answer));

  return { ledger, answerKnown, sendConfirmed };
}
