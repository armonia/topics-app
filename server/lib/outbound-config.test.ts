/**
 * The mail and Google configuration, read from an INJECTED environment.
 *
 * Why it is injected: this repo is public, and GATE-07
 * (`tests/unit/no-third-party-emails.test.ts`) fails on a personal address in a
 * tracked file. A test reading the real `process.env` would carry two defects
 * at once: it would only pass on the owner's machine, and anyone printing its
 * values would read the mailboxes. Here the addresses are on a placeholder
 * domain and the SHAPE under test is exactly the one written in
 * `~/.topics-server-env`.
 *
 * The regressions it watches:
 *   - a missing variable that turns into a silent fallback onto another
 *     account: a message sent from the wrong mailbox cannot be recalled;
 *   - an error that does not say WHICH variable is missing, i.e. one that sends
 *     the reader into the source to find out;
 *   - an address printed inside an error message.
  * @covers OUTBOUND-01
 */
import { describe, expect, test } from "bun:test";
import { OutboundConfigError, pickAccount, readGoogleClient, readGoogleConfig, readMailConfig } from "./outbound-config";

const EXCHANGE_ADDRESS = "ufficio@esempio.test";

const baseEnv = (): Record<string, string> => ({
  TOPICS_MAIL_CLI: "gws-mail",
  TOPICS_MAIL_ACCOUNT: "primo",
  TOPICS_MAIL_FROM: "primo@esempio.test",
  TOPICS_MAIL_ACCOUNTS: "primo:primo@esempio.test,secondo:secondo@esempio.test",
  TOPICS_MAIL_EDM_CLI: "/tmp/edm",
  TOPICS_MAIL_EDM_FROM: EXCHANGE_ADDRESS,
  TOPICS_GOOGLE_CLI: "gws",
  TOPICS_GOOGLE_CONFIG_DIR: "/tmp/gws-config",
  TOPICS_GOOGLE_CLIENT_SECRET: "/tmp/client_secret.json",
});

describe("readMailConfig", () => {
  test("legge il roster nell'ordine dichiarato", () => {
    const config = readMailConfig(baseEnv());
    expect(config.accounts.map((a) => a.name)).toEqual(["primo", "secondo"]);
    expect(config.defaultAccount).toBe("primo");
    expect(config.accounts.every((a) => a.transport === "default")).toBe(true);
    expect(config.accounts[0].cli).toBe("gws-mail");
  });

  test("una variabile mancante nomina SE STESSA e il file dove si scrive", () => {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>).TOPICS_MAIL_CLI;
    let caught: unknown;
    try { readMailConfig(env); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(OutboundConfigError);
    expect((caught as OutboundConfigError).variable).toBe("TOPICS_MAIL_CLI");
    expect((caught as Error).message).toContain("TOPICS_MAIL_CLI");
    expect((caught as Error).message).toContain(".topics-server-env");
  });

  test("una lista senza i due punti e' un errore, non una lista vuota", () => {
    const env = { ...baseEnv(), TOPICS_MAIL_ACCOUNTS: "primo primo@esempio.test" };
    let caught: unknown;
    try { readMailConfig(env); } catch (err) { caught = err; }
    expect((caught as OutboundConfigError).variable).toBe("TOPICS_MAIL_ACCOUNTS");
    expect((caught as Error).message).toContain("name:address");
  });

  test("lo stesso nome due volte e' un errore: un nome, una casella", () => {
    const env = { ...baseEnv(), TOPICS_MAIL_ACCOUNTS: "primo:a@esempio.test,primo:b@esempio.test" };
    expect(() => readMailConfig(env)).toThrow(/twice/);
  });

  test("un default che nessuno ha dichiarato e' un errore, non un ripiego", () => {
    const env = { ...baseEnv(), TOPICS_MAIL_ACCOUNT: "terzo" };
    let caught: unknown;
    try { readMailConfig(env); } catch (err) { caught = err; }
    expect((caught as OutboundConfigError).variable).toBe("TOPICS_MAIL_ACCOUNT");
    expect((caught as Error).message).toContain("terzo");
  });

  test("la casella Exchange si riconosce per INDIRIZZO e prende la CLI sua", () => {
    const env = {
      ...baseEnv(),
      TOPICS_MAIL_ACCOUNTS: `primo:primo@esempio.test,lavoro:${EXCHANGE_ADDRESS}`,
    };
    const config = readMailConfig(env);
    const exchange = config.accounts.find((a) => a.name === "lavoro");
    expect(exchange?.transport).toBe("exchange");
    expect(exchange?.cli).toBe("/tmp/edm");
    // And the others stay on the ordinary CLI: the match is by address, not
    // "the last one in the list".
    expect(config.accounts.find((a) => a.name === "primo")?.transport).toBe("default");
  });

  test("la casella Exchange senza la sua CLI si ferma, e dice quale variabile manca", () => {
    const env = {
      ...baseEnv(),
      TOPICS_MAIL_ACCOUNTS: `primo:primo@esempio.test,lavoro:${EXCHANGE_ADDRESS}`,
      TOPICS_MAIL_EDM_CLI: "",
    };
    let caught: unknown;
    try { readMailConfig(env); } catch (err) { caught = err; }
    expect((caught as OutboundConfigError).variable).toBe("TOPICS_MAIL_EDM_CLI");
  });
});

describe("pickAccount", () => {
  test("un account non dichiarato e' RIFIUTATO, e l'errore elenca i NOMI", () => {
    const config = readMailConfig(baseEnv());
    let caught: unknown;
    try { pickAccount(config, "terzo"); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(OutboundConfigError);
    const message = (caught as Error).message;
    expect(message).toContain("primo, secondo");
    // No address in the error: names are enough to choose with, mailboxes are not.
    expect(message).not.toContain("@");
  });

  test("senza nome si usa il default dichiarato, mai il primo della lista", () => {
    const config = readMailConfig({ ...baseEnv(), TOPICS_MAIL_ACCOUNT: "secondo" });
    expect(pickAccount(config).name).toBe("secondo");
  });
});

describe("readGoogleConfig", () => {
  test("le tre variabili, e un errore che nomina quella che manca", () => {
    const env = baseEnv();
    expect(readGoogleConfig(env).configDir).toBe("/tmp/gws-config");
    delete (env as Record<string, string | undefined>).TOPICS_GOOGLE_CONFIG_DIR;
    let caught: unknown;
    try { readGoogleConfig(env); } catch (err) { caught = err; }
    expect((caught as OutboundConfigError).variable).toBe("TOPICS_GOOGLE_CONFIG_DIR");
  });
});

describe("readGoogleClient", () => {
  const installedClient = JSON.stringify({
    installed: { client_id: "finto-client-id", client_secret: "finto-client-secret", redirect_uris: ["http://localhost"] },
  });

  test("legge i due campi dalla forma `installed` che Google consegna", () => {
    const client = readGoogleClient("/tmp/client_secret.json", () => installedClient);
    expect(client).toEqual({ clientId: "finto-client-id", clientSecret: "finto-client-secret" });
  });

  test("anche la forma `web`, che e' l'altra che Google consegna", () => {
    const client = readGoogleClient("/tmp/client_secret.json", () =>
      JSON.stringify({ web: { client_id: "finto-web-id", client_secret: "finto-web-secret" } }));
    expect(client.clientId).toBe("finto-web-id");
  });

  test("un file che non si legge nomina la variabile, non il contenuto", () => {
    let caught: unknown;
    try {
      readGoogleClient("/tmp/manca.json", () => { throw new Error("ENOENT"); });
    } catch (err) { caught = err; }
    expect((caught as OutboundConfigError).variable).toBe("TOPICS_GOOGLE_CLIENT_SECRET");
  });

  test("un file dell'altra forma (credenziali di UTENTE) e' un errore che dice cosa manca", () => {
    // It is the mistake that produced this function: the CLI variable that
    // takes a file wants an authorized-user file, and handing it a desktop
    // client fails at auth time with a message about `client_id`.
    let caught: unknown;
    try {
      readGoogleClient("/tmp/user.json", () => JSON.stringify({ refresh_token: "finto", type: "authorized_user" }));
    } catch (err) { caught = err; }
    expect((caught as Error).message).toContain("desktop client");
  });

  test("un file che non e' JSON non esplode", () => {
    expect(() => readGoogleClient("/tmp/rotto.json", () => "non json")).toThrow(/not JSON/);
  });
});
