/**
 * WHAT TOPICS NEEDS TO KNOW BEFORE IT CAN SEND ANYTHING OUT, read from the
 * environment and from nowhere else.
 *
 * This repo is PUBLIC. An address, an account name or a CLI path written into a
 * tracked file is published, and `tests/unit/no-third-party-emails.test.ts`
 * (GATE-07) already fails the build on the shape that leaked once. So the
 * roster of mailboxes lives in `~/.topics-server-env`, which
 * `scripts/start-prod.sh` sources, and this module only ever READS the map it
 * is handed: no module-level `process.env`, so a test injects an environment
 * instead of mutating the one the server runs under.
 *
 * TWO RULES THAT ARE NOT STYLE:
 *
 * 1. A MISSING VARIABLE IS AN ERROR THAT NAMES ITSELF. "mail is not configured"
 *    sends whoever reads it to grep the source; "TOPICS_MAIL_CLI is not set
 *    (write it in ~/.topics-server-env ...)" sends them to the one line they
 *    have to add.
 *
 * 2. NO SILENT FALLBACK ONTO ANOTHER ACCOUNT. An unknown account name is
 *    refused with the list of NAMES, never with a substitution: a message that
 *    left from the wrong mailbox cannot be recalled, while a message that did
 *    not leave costs one more turn.
 *
 * Addresses never appear in an error or a log. The names do — they are labels
 * the person chose, and an agent that picks one has to be able to read them.
 */

/** Where the variables are written. Part of every error this module raises. */
export const ENV_FILE_HINT = "~/.topics-server-env (sourced by scripts/start-prod.sh)";

/** An environment as this module reads it: a plain map, injected by the caller. */
export type EnvMap = Record<string, string | undefined>;

/** Which CLI carries a mailbox. `edm` is the Exchange box, which has its own. */
export type MailTransport = "default" | "exchange";

export interface MailAccount {
  /** The label a person chose and an agent passes as `account`. */
  name: string;
  /** The sender address. Never logged, never put in an error message. */
  address: string;
  transport: MailTransport;
  /** Absolute-or-resolvable path of the CLI that sends for this account. */
  cli: string;
}

export interface MailConfig {
  /** Declared accounts, in the order they were written. */
  accounts: MailAccount[];
  /** The one used when the caller does not pick: `TOPICS_MAIL_ACCOUNT`. */
  defaultAccount: string;
}

export interface GoogleConfig {
  cli: string;
  /** Where the CLI keeps this account's token store. */
  configDir: string;
  /** PATH of the installed-app OAuth client JSON. Not a secret value: a file. */
  clientSecretFile: string;
}

/** The two fields the CLI wants as environment values, read from that file. */
export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

/**
 * A configuration problem, phrased for the person who has to fix it.
 *
 * `variable` is carried as data and not only inside the sentence so a route can
 * answer with a machine-readable code without re-parsing English.
 */
export class OutboundConfigError extends Error {
  constructor(readonly variable: string, message: string) {
    super(message);
    this.name = "OutboundConfigError";
  }
}

function required(env: EnvMap, variable: string): string {
  const value = env[variable];
  if (typeof value !== "string" || !value.trim()) {
    throw new OutboundConfigError(
      variable,
      `${variable} is not set: write it in ${ENV_FILE_HINT} and restart the server`,
    );
  }
  return value.trim();
}

/**
 * `TOPICS_MAIL_ACCOUNTS` is `name:address,name:address`.
 *
 * Parsed strictly: an entry without a colon, with an empty half, or a name
 * repeated twice is a typo in a file nobody reads twice, and a typo that
 * silently drops one mailbox turns into "why did it send from the other one".
 */
function parseAccounts(raw: string): Array<{ name: string; address: string }> {
  const out: Array<{ name: string; address: string }> = [];
  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    const item = entry.trim();
    if (!item) continue;
    const at = item.indexOf(":");
    if (at <= 0 || at === item.length - 1) {
      throw new OutboundConfigError(
        "TOPICS_MAIL_ACCOUNTS",
        `TOPICS_MAIL_ACCOUNTS is malformed: every entry is "name:address", separated by commas (${ENV_FILE_HINT})`,
      );
    }
    const name = item.slice(0, at).trim();
    const address = item.slice(at + 1).trim();
    if (!name || !address) {
      throw new OutboundConfigError(
        "TOPICS_MAIL_ACCOUNTS",
        `TOPICS_MAIL_ACCOUNTS is malformed: every entry is "name:address", separated by commas (${ENV_FILE_HINT})`,
      );
    }
    if (seen.has(name)) {
      throw new OutboundConfigError(
        "TOPICS_MAIL_ACCOUNTS",
        `TOPICS_MAIL_ACCOUNTS declares the account "${name}" twice: one name, one mailbox (${ENV_FILE_HINT})`,
      );
    }
    seen.add(name);
    out.push({ name, address });
  }
  if (!out.length) {
    throw new OutboundConfigError(
      "TOPICS_MAIL_ACCOUNTS",
      `TOPICS_MAIL_ACCOUNTS is empty: write at least one "name:address" entry in ${ENV_FILE_HINT}`,
    );
  }
  return out;
}

/**
 * The mail roster.
 *
 * THE EXCHANGE BOX IS RECOGNISED BY ADDRESS, not by a name written here. It
 * reaches a different server through a CLI of its own (`TOPICS_MAIL_EDM_CLI`),
 * and the only thing that says "this entry is that box" without publishing a
 * label is the address it is declared with: the roster entry whose address
 * equals `TOPICS_MAIL_EDM_FROM` gets the other transport. Whoever adds the box
 * writes one more `name:address` pair and nothing in this file changes.
 */
export function readMailConfig(env: EnvMap): MailConfig {
  const cli = required(env, "TOPICS_MAIL_CLI");
  const defaultAccount = required(env, "TOPICS_MAIL_ACCOUNT");
  // Read for validation only: a default sender that nobody declared is the
  // half-configured state that ends with a message leaving from elsewhere.
  required(env, "TOPICS_MAIL_FROM");
  const declared = parseAccounts(required(env, "TOPICS_MAIL_ACCOUNTS"));

  const exchangeFrom = (env.TOPICS_MAIL_EDM_FROM ?? "").trim();
  const exchangeCli = (env.TOPICS_MAIL_EDM_CLI ?? "").trim();

  const accounts: MailAccount[] = declared.map((entry) => {
    const isExchange = !!exchangeFrom && entry.address.toLowerCase() === exchangeFrom.toLowerCase();
    if (isExchange && !exchangeCli) {
      throw new OutboundConfigError(
        "TOPICS_MAIL_EDM_CLI",
        `the account "${entry.name}" is the Exchange mailbox (TOPICS_MAIL_EDM_FROM) but TOPICS_MAIL_EDM_CLI is not set: write it in ${ENV_FILE_HINT}`,
      );
    }
    return {
      name: entry.name,
      address: entry.address,
      transport: isExchange ? "exchange" : "default",
      cli: isExchange ? exchangeCli : cli,
    };
  });

  if (!accounts.some((a) => a.name === defaultAccount)) {
    throw new OutboundConfigError(
      "TOPICS_MAIL_ACCOUNT",
      `TOPICS_MAIL_ACCOUNT names "${defaultAccount}", which is not declared in TOPICS_MAIL_ACCOUNTS (declared: ${accounts.map((a) => a.name).join(", ")}). Fix it in ${ENV_FILE_HINT}`,
    );
  }

  return { accounts, defaultAccount };
}

/**
 * The account to send from, by name. `undefined` means "the default one".
 *
 * Refusing an unknown name is the whole point: the alternative, quietly using
 * the default, is how a message written for one recipient leaves from the
 * mailbox of another relationship.
 */
export function pickAccount(config: MailConfig, requested?: string): MailAccount {
  const wanted = typeof requested === "string" && requested.trim() ? requested.trim() : config.defaultAccount;
  const found = config.accounts.find((a) => a.name === wanted);
  if (!found) {
    throw new OutboundConfigError(
      "TOPICS_MAIL_ACCOUNTS",
      `unknown account "${wanted}": declared accounts are ${config.accounts.map((a) => a.name).join(", ")}`,
    );
  }
  return found;
}

/** Google needs the CLI plus the two paths its child process reads. */
export function readGoogleConfig(env: EnvMap): GoogleConfig {
  return {
    cli: required(env, "TOPICS_GOOGLE_CLI"),
    configDir: required(env, "TOPICS_GOOGLE_CONFIG_DIR"),
    clientSecretFile: required(env, "TOPICS_GOOGLE_CLIENT_SECRET"),
  };
}

/**
 * The OAuth client, read from the file the variable points at.
 *
 * MEASURED, not guessed (2026-09-16). The CLI has a variable that takes a FILE
 * (`GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`) and handing it this one is an
 * immediate `error[auth]: Failed to parse authorized user credentials ...
 * missing field client_id`: that variable wants an authorized-USER file, while
 * this is an installed-app CLIENT. The two values inside it are what the CLI
 * reads as `GOOGLE_WORKSPACE_CLI_CLIENT_ID` and `..._CLIENT_SECRET`, which is
 * also what the mail wrapper on this machine exports by hand.
 *
 * The values are returned, never logged: the errors name the FILE and the
 * missing FIELD, and nothing else.
 */
export function readGoogleClient(clientSecretFile: string, readFile: (path: string) => string): GoogleClient {
  let raw: string;
  try {
    raw = readFile(clientSecretFile);
  } catch {
    throw new OutboundConfigError(
      "TOPICS_GOOGLE_CLIENT_SECRET",
      `TOPICS_GOOGLE_CLIENT_SECRET points at "${clientSecretFile}", which cannot be read (${ENV_FILE_HINT})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OutboundConfigError(
      "TOPICS_GOOGLE_CLIENT_SECRET",
      `TOPICS_GOOGLE_CLIENT_SECRET points at "${clientSecretFile}", which is not JSON`,
    );
  }
  // `installed` is the shape a desktop OAuth client is downloaded in; `web` is
  // the other one Google hands out, and reading it here costs one line and
  // turns a confusing auth error into a working call.
  const holder = (parsed as { installed?: unknown; web?: unknown })?.installed
    ?? (parsed as { web?: unknown })?.web;
  const client = holder as { client_id?: unknown; client_secret?: unknown } | undefined;
  const clientId = typeof client?.client_id === "string" ? client.client_id : "";
  const clientSecret = typeof client?.client_secret === "string" ? client.client_secret : "";
  if (!clientId || !clientSecret) {
    throw new OutboundConfigError(
      "TOPICS_GOOGLE_CLIENT_SECRET",
      `the OAuth client at "${clientSecretFile}" has no installed/web client_id and client_secret: it is not the file Google hands out for a desktop client`,
    );
  }
  return { clientId, clientSecret };
}
