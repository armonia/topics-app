/**
 * Apple's on-device Translation framework, behind `ReasoningTranslator`.
 *
 * The framework is Swift-only, so a small helper process does the work and this
 * file talks to it over NDJSON on stdin/stdout. The helper is compiled on first
 * use with the machine's own `swiftc` and cached under the app data folder: no
 * binary is shipped, and a machine without the Swift compiler, without macOS 26
 * or without the language pair installed simply reports "not available" and the
 * reasoning stays in its original language.
 *
 * Two traps this avoids on purpose:
 *  - `/usr/bin/swiftc` exists on every Mac as a shim that opens the "install
 *    the command line tools" dialog when they are missing, so the compiler is
 *    only run after `xcode-select -p` says the tools are there;
 *  - a helper that dies mid-request must not hang the chat, so every request
 *    has a deadline and a dead process rejects all that waited on it.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { APPLE_HELPER_SOURCE } from "./apple-helper-source";
import type { DetectedLanguage, ReasoningTranslator } from "./translator";

/** Darwin 25 is macOS 26, the first release where `TranslationSession` can be built without a view. */
const MIN_DARWIN_MAJOR = 25;
const COMPILE_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** The helper holds the translation model in memory: let it go when nobody asks for a while. */
const IDLE_EXIT_MS = 5 * 60_000;
/** After a failed build the adapter stays off for this long, so a broken compiler is not retried per sentence. */
const BUILD_RETRY_MS = 10 * 60_000;

interface AppleAdapterOptions {
  /** Folder for the compiled helper (created when needed). */
  cacheDir: string;
  /** A ready-made helper executable, used instead of compiling: tests and e2e put a fake here. */
  helperPath?: string;
}

interface Pending {
  resolve: (reply: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Are the command line tools installed? `xcode-select -p` is silent and never
 * opens the install dialog that the `/usr/bin/swiftc` shim would.
 */
function commandLineToolsInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    // runtime-dep-ok: macOS only (the caller checked the platform), a read-only probe with a deadline.
    const probe = spawn("xcode-select", ["-p"], { stdio: "ignore", timeout: 5_000 });
    probe.on("exit", (code) => resolve(code === 0));
    probe.on("error", () => resolve(false));
  });
}

export class AppleReasoningTranslator implements ReasoningTranslator {
  readonly name = "apple";
  private helper: Promise<string | null> | null = null;
  private failedAt = 0;
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: AppleAdapterOptions) {}

  async available(): Promise<boolean> {
    return (await this.ensureHelper()) !== null;
  }

  async detect(text: string): Promise<DetectedLanguage | null> {
    const reply = await this.request({ op: "detect", text });
    if (!reply || typeof reply.lang !== "string") return null;
    return { language: reply.lang, confidence: Number(reply.confidence) || 0 };
  }

  async pairReady(from: string, to: string): Promise<boolean> {
    const reply = await this.request({ op: "status", from, to });
    return reply?.status === "installed";
  }

  async translate(text: string, from: string, to: string): Promise<string> {
    const reply = await this.request({ op: "translate", text, from, to });
    if (!reply || typeof reply.text !== "string") throw new Error(String(reply?.error ?? "translation failed"));
    return reply.text;
  }

  /** Stops the helper. The next request starts a new one. */
  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    this.child = null;
    if (child) child.kill();
  }

  private async request(payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const path = await this.ensureHelper();
    if (!path) return null;
    const child = this.ensureChild(path);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("translation helper timed out"));
        // A helper that stopped answering is replaced, not waited on.
        this.stop();
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      this.touchIdle();
    });
  }

  private ensureChild(path: string): ChildProcessByStdio<Writable, Readable, null> {
    if (this.child) return this.child;
    const child = spawn(path, [], { stdio: ["pipe", "pipe", "ignore"] });
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    // Writing to a helper that already died raises EPIPE on stdin: the exit handler below rejects the waiters.
    child.stdin.on("error", () => {});
    const gone = () => {
      if (this.child === child) this.child = null;
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("translation helper exited"));
        this.pending.delete(id);
      }
    };
    child.on("exit", gone);
    child.on("error", gone);
    return child;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let lineEnd = this.buffer.indexOf("\n");
    while (lineEnd >= 0) {
      const line = this.buffer.slice(0, lineEnd);
      this.buffer = this.buffer.slice(lineEnd + 1);
      lineEnd = this.buffer.indexOf("\n");
      let reply: Record<string, unknown>;
      try {
        reply = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = typeof reply.id === "number" ? reply.id : null;
      const entry = id === null ? undefined : this.pending.get(id);
      if (!entry || id === null) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve(reply);
    }
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_EXIT_MS);
    // An idle timer must never keep the server process alive on its own.
    this.idleTimer.unref?.();
  }

  /** The path of a working helper, or null. The answer is memoised, a failure for BUILD_RETRY_MS. */
  private ensureHelper(): Promise<string | null> {
    // Still building, built, or failed recently: the same answer.
    if (this.helper && (this.failedAt === 0 || Date.now() - this.failedAt < BUILD_RETRY_MS)) return this.helper;
    const attempt = this.buildHelper().then((path) => {
      this.failedAt = path ? 0 : Date.now();
      return path;
    });
    this.failedAt = 0;
    this.helper = attempt;
    return attempt;
  }

  private async buildHelper(): Promise<string | null> {
    const { helperPath } = this.options;
    if (helperPath) return existsSync(helperPath) ? helperPath : null;
    if (process.platform !== "darwin") return null;
    if (Number.parseInt(release(), 10) < MIN_DARWIN_MAJOR) return null;
    if (!(await commandLineToolsInstalled())) return null;

    // The binary is named after the source it was built from: a new app version with a new
    // helper compiles a new file and never runs a stale one.
    const hash = createHash("sha256").update(APPLE_HELPER_SOURCE).digest("hex").slice(0, 12);
    const dir = join(this.options.cacheDir, "reasoning-translate");
    const binary = join(dir, `helper-${hash}`);
    if (existsSync(binary)) return binary;

    try {
      mkdirSync(dir, { recursive: true });
      const source = join(dir, `helper-${hash}.swift`);
      writeFileSync(source, APPLE_HELPER_SOURCE);
      // Built beside the final name and renamed, so two servers starting together never run a half-written binary.
      const partial = `${binary}.${process.pid}.tmp`;
      const built = await new Promise<boolean>((resolve) => {
        // runtime-dep-ok: macOS 26 only (checked above), and only when `xcode-select -p` found the command line tools; any failure leaves the reasoning in its original language.
        const compiler = spawn("swiftc", ["-O", source, "-o", partial], { stdio: "ignore", timeout: COMPILE_TIMEOUT_MS });
        compiler.on("exit", (code) => resolve(code === 0));
        compiler.on("error", () => resolve(false));
      });
      if (!built || !existsSync(partial)) return null;
      chmodSync(partial, 0o755);
      renameSync(partial, binary);
      return binary;
    } catch {
      return null;
    }
  }
}
