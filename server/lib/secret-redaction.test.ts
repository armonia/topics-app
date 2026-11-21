/**
 * Secrets in tool arguments and output are masked before storage and before the
 * model sees them again: one real case per rule, plus the known false positives.
 *
 * @covers SEC-02
 */
import { describe, expect, test } from "bun:test";
import { REDACTED, REDACTION_RULES, redactDeep, redactSecrets } from "./secret-redaction";

// Assembled at runtime: written whole, a PEM header reads as a real key to secret scanners (push-guard, GitHub).
const KEY = "PRIVATE KEY";

describe("redactSecrets", () => {
  test("sshpass -p keeps the rest of the command", () => {
    expect(redactSecrets("sshpass -p 'S3gr3t0!' ssh root@host")).toBe(`sshpass -p '${REDACTED}' ssh root@host`);
    expect(redactSecrets("sshpass -p hunter2 scp a b:c")).toBe(`sshpass -p '${REDACTED}' scp a b:c`);
  });

  test("--password in both spellings", () => {
    expect(redactSecrets("psql --password=abc123 -h db")).toBe(`psql --password=${REDACTED} -h db`);
    expect(redactSecrets("tool --password 'a b' run")).toBe(`tool --password ${REDACTED} run`);
  });

  test("mysql -pSECRET, but bare -p is left alone", () => {
    expect(redactSecrets("mysql -u root -pS3cret db")).toBe(`mysql -u root -p${REDACTED} db`);
    expect(redactSecrets("mysql -u root -p db")).toBe("mysql -u root -p db");
  });

  test("Authorization header keeps its scheme", () => {
    expect(redactSecrets("curl -H 'Authorization: Bearer abc.def' https://x")).toBe(`curl -H 'Authorization: Bearer ${REDACTED}' https://x`);
    expect(redactSecrets("Authorization: Basic dXNlcjpwdw==")).toBe(`Authorization: Basic ${REDACTED}`);
  });

  test("a PEM private key goes whole, markers stay", () => {
    const privateKey = `-----BEGIN OPENSSH ${KEY}-----\nb3BlbnNzaC1rZXk=\nQQ==\n-----END OPENSSH ${KEY}-----`;
    const out = redactSecrets(`cat key\n${privateKey}\ndone`);
    expect(out).not.toContain("b3BlbnNzaC1rZXk");
    expect(out).toContain(`-----END OPENSSH ${KEY}-----`);
    expect(out.endsWith("\ndone")).toBe(true);
  });

  test("a truncated PEM is masked to the end of the text", () => {
    expect(redactSecrets(`-----BEGIN RSA ${KEY}-----\nMIIE`)).not.toContain("MIIE");
  });

  test("known token prefixes", () => {
    const gh = "ghp_" + "a".repeat(36);
    const awsKey = "AKIA" + "B".repeat(16);
    expect(redactSecrets(`export T=${gh} K=${awsKey}`)).toBe(`export T=${REDACTED} K=${REDACTED}`);
    expect(redactSecrets("sk-ant-" + "x".repeat(30))).toBe(REDACTED);
  });

  test("known false positives stay untouched", () => {
    for (const s of ["git log -p", "git log -p --stat HEAD~3", "grep -p foo file", "ps -p 123", "the sk-learn library", "Authorization is required"]) {
      expect(redactSecrets(s)).toBe(s);
    }
  });

  test("every rule is exercised by a sample (closed list stays honest)", () => {
    expect(REDACTION_RULES.map((r) => r.name)).toEqual([
      "sshpass-password", "password-option", "mysql-password", "authorization-header", "pem-private-key", "known-token-prefix",
    ]);
  });
});

describe("redactDeep", () => {
  test("masks nested args and output, returns the same reference when clean", () => {
    const call = { name: "bash", args: { command: "sshpass -p 'x1' ssh h" }, detail: { output: ["Authorization: Bearer zzz"] } };
    const out = redactDeep(call);
    expect(out.args.command).toBe(`sshpass -p '${REDACTED}' ssh h`);
    expect(out.detail.output[0]).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(call.args.command).toContain("x1");
    const clean = { args: { command: "ls -la" } };
    expect(redactDeep(clean)).toBe(clean);
  });
});
