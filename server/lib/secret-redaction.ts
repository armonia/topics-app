/**
 * SEC-02: secrets in tool arguments and tool output are masked before they are
 * stored and before they are sent back to the model.
 *
 * The rule list is CLOSED on purpose: each rule names one shape that carries a
 * secret in practice. Anything outside it is left alone, so that a diff or a
 * grep that merely mentions `-p` is never rewritten (`git log -p`, `grep -p`).
 * The value becomes `[oscurato]`; the rest of the command stays as it was.
 */

/** What replaces a secret value. Part of the spec (SEC-02), do not translate. */
export const REDACTED = "[oscurato]"; // allow-italian: literal marker fixed by the SEC-02 spec

interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** Receives the match groups and returns the text that replaces the match. */
  replace: (...groups: string[]) => string;
}

export const REDACTION_RULES: readonly RedactionRule[] = [
  {
    // sshpass -p 'secret' ssh host
    name: "sshpass-password",
    pattern: /(\bsshpass\s+-p\s*)(?:'[^']*'|"[^"]*"|[^\s'"]+)/g,
    replace: (_m, head) => `${head}'${REDACTED}'`,
  },
  {
    // --password=x, --password x, --passwd, --pass (long options only: `-p` is too common)
    name: "password-option",
    pattern: /(--(?:password|passwd|pass)(?:=|\s+))(?:'[^']*'|"[^"]*"|[^\s'"]+)/g,
    replace: (_m, head) => `${head}${REDACTED}`,
  },
  {
    // mysql -pSECRET (the value is glued to the flag; `-p` alone prompts and holds no secret)
    name: "mysql-password",
    pattern: /(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]*?\s-p)(?!\s)(?:'[^']*'|"[^"]*"|[^\s'"]+)/g,
    replace: (_m, head) => `${head}${REDACTED}`,
  },
  {
    // Authorization: Bearer xyz  ->  Authorization: Bearer [oscurato]
    name: "authorization-header",
    pattern: /(\bAuthorization\s*[:=]\s*["']?(?:(?:Bearer|Basic|Token|Digest)\s+)?)[^\s"'\\]+/gi,
    replace: (_m, head) => `${head}${REDACTED}`,
  },
  {
    // A whole private key, from BEGIN to END (or to the end of a truncated text).
    name: "pem-private-key",
    pattern: /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(?:(-----END [A-Z ]*PRIVATE KEY-----)|$)/g,
    replace: (_m, begin, end) => `${begin}\n${REDACTED}\n${end ?? ""}`,
  },
  {
    // Tokens with a vendor prefix that cannot be mistaken for prose.
    name: "known-token-prefix",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20}|npm_[A-Za-z0-9]{36})\b/g,
    replace: () => REDACTED,
  },
];

/** Masks every secret in a string. Returns the same string when nothing matches. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of REDACTION_RULES) {
    out = out.replace(rule.pattern, (...m) => rule.replace(...(m as string[])));
  }
  return out;
}

const MAX_DEPTH = 16;

/**
 * Masks the strings found anywhere inside a JSON-like value (tool args, a
 * result, a block timeline). Returns the SAME reference when nothing changed,
 * so rows without secrets are not copied.
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let next: unknown[] | null = null;
    value.forEach((item, i) => {
      const r = redactDeep(item, depth + 1);
      if (r !== item) (next ??= value.slice())[i] = r;
    });
    return (next ?? value) as unknown as T;
  }
  let next: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const r = redactDeep(v, depth + 1);
    if (r !== v) (next ??= { ...(value as Record<string, unknown>) })[k] = r;
  }
  return (next ?? value) as T;
}
