/**
 * THE CLI IS CALLED BY ARGV, and its executable is found without trusting PATH.
 *
 * The fake executable is not a convenience: it is the only way to PROVE that
 * `; rm -rf`, `$(...)`, quotes and newlines reach the child process as ONE
 * argument. The script records NUL-separated `argv` and the environment it was
 * handed, and the tests read that file. Nothing is ever sent: the real CLI is
 * never touched.
 *
 * The regressions it watches:
 *   - a command line built as a string and handed to a shell (the shape in
 *     which a mail subject becomes a command);
 *   - an executable looked up through `PATH`, which under launchd carries
 *     neither `/usr/local/bin` nor `/opt/homebrew/bin`;
 *   - the server's whole environment handed to a process that talks to the
 *     outside world.
  * @covers OUTBOUND-02
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutboundConfigError } from "./outbound-config";
import { resolveCliPath, runCli } from "./outbound-cli";

const root = mkdtempSync(join(tmpdir(), "outbound-cli-"));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** A recorder, not a mailer: it writes down how it was called and exits. */
function fakeCli(name: string, extra = ""): { file: string; log: string } {
  const file = join(root, name);
  const log = join(root, `${name}.log`);
  writeFileSync(
    file,
    [
      "#!/bin/bash",
      `LOG="${log}"`,
      ': > "$LOG"',
      'for a in "$@"; do printf "%s\\0" "$a" >> "$LOG"; done',
      `printf "ENV:%s\\0" "$SECRET_OF_THE_SERVER" >> "$LOG"`,
      `printf "ENV_GOOGLE:%s\\0" "$GOOGLE_WORKSPACE_CLI_CONFIG_DIR" >> "$LOG"`,
      extra,
      "echo done",
      "exit 0",
    ].join("\n"),
    "utf8",
  );
  chmodSync(file, 0o755);
  return { file, log };
}

const recorded = (log: string): string[] => readFileSync(log, "utf8").split("\0").slice(0, -1);

describe("runCli", () => {
  test("ogni argomento resta UN argomento, anche quando sembra un comando", async () => {
    const { file, log } = fakeCli("recorder");
    const marker = join(root, "mai-eseguito");
    const injection = `vittima@esempio.test; rm -rf ${root}`;
    const subject = 'Oggetto con "virgolette"\ne un a capo';
    const body = `corpo con $(touch ${marker}) e \`backtick\``;
    const run = await runCli({
      file,
      argv: ["--to", injection, "--subject", subject, "--body", body],
      env: { PATH: "/usr/bin:/bin", HOME: root },
      timeoutMs: 10_000,
    });
    expect(run.exitCode).toBe(0);
    const args = recorded(log);
    expect(args.slice(0, 6)).toEqual(["--to", injection, "--subject", subject, "--body", body]);
    // The proof that nothing was interpreted: the command substitution in the
    // body would have created this file, and the directory would be gone.
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  test("il figlio riceve SOLO l'ambiente dichiarato", async () => {
    const { file, log } = fakeCli("env-recorder");
    process.env.SECRET_OF_THE_SERVER = "non-deve-uscire";
    try {
      await runCli({
        file,
        argv: [],
        env: { PATH: "/usr/bin:/bin", HOME: root, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: "/tmp/config" },
        timeoutMs: 10_000,
      });
    } finally {
      delete process.env.SECRET_OF_THE_SERVER;
    }
    const args = recorded(log);
    expect(args).toContain("ENV:");
    expect(args).toContain("ENV_GOOGLE:/tmp/config");
  });

  test("un figlio che non risponde entro il tetto e' un timeout, non un'attesa infinita", async () => {
    const file = join(root, "sleeper");
    writeFileSync(file, "#!/bin/bash\nsleep 30\n", "utf8");
    chmodSync(file, 0o755);
    const run = await runCli({ file, argv: [], env: { PATH: "/usr/bin:/bin" }, timeoutMs: 300 });
    expect(run.timedOut).toBe(true);
    expect(run.exitCode).toBeNull();
  });

  test("un'uscita non-zero porta indietro il codice e stderr", async () => {
    const file = join(root, "failer");
    writeFileSync(file, "#!/bin/bash\necho 'cosi no' >&2\nexit 3\n", "utf8");
    chmodSync(file, 0o755);
    const run = await runCli({ file, argv: [], env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
    expect(run.exitCode).toBe(3);
    expect(run.stderr).toContain("cosi no");
  });

  test("un eseguibile che non esiste non esplode: torna un errore leggibile", async () => {
    const run = await runCli({ file: join(root, "non-c-e"), argv: [], env: {}, timeoutMs: 1000 });
    expect(run.exitCode).toBeNull();
    expect(run.stderr.length).toBeGreaterThan(0);
  });
});

describe("resolveCliPath", () => {
  test("un nome nudo si trova nelle cartelle DICHIARATE, non in PATH", () => {
    const { file } = fakeCli("nudo");
    // An empty PATH on purpose: that is the situation under launchd, where the
    // directory the CLI is actually installed in does not appear.
    expect(resolveCliPath("nudo", "TOPICS_MAIL_CLI", { searchDirs: [root], pathEnv: "" })).toBe(file);
  });

  test("un nome che nessuna cartella contiene nomina la variabile", () => {
    let caught: unknown;
    try { resolveCliPath("assente", "TOPICS_MAIL_CLI", { searchDirs: [root], pathEnv: "" }); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(OutboundConfigError);
    expect((caught as OutboundConfigError).variable).toBe("TOPICS_MAIL_CLI");
    expect((caught as Error).message).toContain("assente");
  });

  test("un percorso assoluto che non c'e' e' un errore, non un tentativo", () => {
    let caught: unknown;
    try { resolveCliPath(join(root, "fantasma"), "TOPICS_GOOGLE_CLI"); } catch (err) { caught = err; }
    expect((caught as OutboundConfigError).variable).toBe("TOPICS_GOOGLE_CLI");
  });

  test("un percorso relativo si rifiuta: dipenderebbe dalla cwd del server", () => {
    expect(() => resolveCliPath("./bin/gws", "TOPICS_GOOGLE_CLI")).toThrow(/absolute/);
  });
});
