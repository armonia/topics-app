/**
 * WHAT THE INSTALLED APP IS ALLOWED TO FIND ON SOMEBODY ELSE'S MACHINE.
 *
 * Topics ships a compiled server, a compiled PTY bridge and a compiled WebRTC
 * bridge precisely so that installing it does not become "first install Bun".
 * That promise is not kept by intention: it is kept one spawn site at a time,
 * and a single `Bun.spawn(["bun", …])` added months later breaks it silently on
 * every machine except the one it was written on.
 *
 * So the promise is written down here as a list, and the list is checked against
 * the source. Three families, and the difference between them is the whole
 * point:
 *
 *   INCLUDED IN THE BUNDLE  the sidecars. They are never string literals in
 *                           this code (the shell hands their absolute path over
 *                           in an env var), so they cannot appear below.
 *   REQUIRED BY THE CHOSEN   `git`, and the agent CLIs `claude` / `codex`. Topics
 *   TECHNOLOGY               drives them by design; removing them is a different
 *                            product, and the card that opened this gate put
 *                            them explicitly out of scope.
 *   PART OF THE OS           `/bin/sh`, `ps`, `lsof`, `pkill`, `grep`, `open`,
 *                            `vm_stat`, `scutil`, `getconf`, `security`, `cmd`.
 *                            Present on the system that can run the app at all.
 *
 * Everything else is a dependency on the author's machine. In particular
 * `node`, `bun`, `npx`, `bunx`, `deno`, `python` are NEVER acceptable as a
 * command: the whole reason the desktop shell was ported to Rust and the server
 * compiled to a single file was to stop asking for them.
 *
 * THE ESCAPE HATCH IS A SENTENCE, NOT A LIST. A site that genuinely needs
 * something else ends its line (or the line above) with
 *
 *     // runtime-dep-ok: <why, and what happens when it is missing>
 *
 * which keeps the reason next to the code instead of in a table nobody opens.
 *
 * @covers RUNTIME-18
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");

/** The annotation that exempts a single line, with its reason attached. */
const ANNOTATION = /runtime-dep-ok:\s*\S/;

/** Required by the chosen technology, or part of any OS that runs the app. */
const ALLOWED_COMMANDS = new Set([
  // the chosen technology
  "git", "claude", "codex",
  // the OS
  "/bin/sh", "sh", "bash", "cmd",
  "ps", "pkill", "grep", "open", "lsof", "/usr/sbin/lsof", "/bin/true",
  "/usr/sbin/scutil", "/usr/bin/getconf", "vm_stat", "security",
]);

/** Never a command: asking for these is asking the user to install a runtime. */
const FORBIDDEN_RUNTIMES = ["node", "bun", "npx", "bunx", "deno", "python", "python3", "npm", "pnpm", "yarn"];

interface Finding { file: string; line: number; what: string; text: string }

/** Source files that run INSIDE the shipped server. Tests and fixtures do not. */
async function serverSources(): Promise<string[]> {
  const out = ["server.ts"];
  const glob = new Glob("**/*.{ts,mjs}");
  for await (const rel of glob.scan({ cwd: join(REPO_ROOT, "server") })) {
    if (/\.(test|fixture)\.[tm]?[jt]s$/.test(rel)) continue;
    if (/-harness\.ts$|\.integration\.test\.ts$/.test(rel)) continue;
    out.push(join("server", rel));
  }
  return out.sort();
}

/** A line stripped of what it is not: comments do not spawn anything. */
function isCode(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
}

/**
 * The annotation counts on the line itself or anywhere in the comment block
 * immediately above it: a reason worth writing rarely fits on one line, and a
 * gate that forces it to is a gate answered with three words.
 */
function exempt(lines: string[], index: number): boolean {
  if (ANNOTATION.test(lines[index] ?? "")) return true;
  for (let i = index - 1; i >= 0; i--) {
    const t = (lines[i] ?? "").trim();
    if (!t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")) return false;
    if (ANNOTATION.test(t)) return true;
  }
  return false;
}

/** Every literal command handed to a spawn/exec call in the shipped server. */
function scan(file: string, src: string): Finding[] {
  const found: Finding[] = [];
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    if (!isCode(line) || exempt(lines, i)) return;

    // 1. the literal in command position: spawn("x", …) or spawn(["x", …])
    const call = /\b(?:Bun\.)?(?:spawnSync|spawn|execFileSync|execFile)\s*\(\s*\[?\s*(?:"([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    while ((m = call.exec(line)) !== null) {
      const cmd = m[1] ?? m[2] ?? "";
      if (!ALLOWED_COMMANDS.has(cmd)) {
        found.push({ file, line: i + 1, what: `spawns "${cmd}"`, text: line.trim() });
      }
    }

    // 2. a runtime as the DEFAULT of a resolved command: `bundled?.cmd ?? "node"`
    const fallback = new RegExp(`(?:\\?\\?|\\|\\|)\\s*["'](${FORBIDDEN_RUNTIMES.join("|")})["']`, "g");
    while ((m = fallback.exec(line)) !== null) {
      found.push({ file, line: i + 1, what: `falls back to "${m[1]}"`, text: line.trim() });
    }

    // 3. a loose script file: something has to interpret it, and that something
    //    is a runtime we did not ship.
    const script = /["'][^"']*\.(mjs|cjs)["']/g;
    while ((m = script.exec(line)) !== null) {
      found.push({ file, line: i + 1, what: `names the script ${m[0]}`, text: line.trim() });
    }
  });
  return found;
}

function render(findings: Finding[]): string {
  return findings.map((f) => `  ${f.file}:${f.line} ${f.what}\n    ${f.text}`).join("\n");
}

describe("the installed app does not depend on the machine it lands on", () => {
  test("no spawn site reaches for a binary outside the allowlist", async () => {
    const findings: Finding[] = [];
    for (const file of await serverSources()) {
      findings.push(...scan(file, readFileSync(join(REPO_ROOT, file), "utf-8")));
    }
    expect(render(findings)).toBe("");
  });

  test("the allowlist itself never gains a runtime", () => {
    // A gate that can be made green by widening its own list is decoration.
    // Nobody adds `bun` to ALLOWED_COMMANDS without this failing first.
    for (const runtime of FORBIDDEN_RUNTIMES) {
      expect(ALLOWED_COMMANDS.has(runtime)).toBe(false);
    }
  });
});
