/**
 * A fake PTY bridge that plays the Claude CLI's part the way the CLI does
 * today, for the `spawn_agent` route tests: it writes the start-up transcript
 * the moment a child is created, draws a long prompt as a `[Pasted text]`
 * placeholder, and writes the user record only when an Enter lands. No
 * `claude` process is ever started.
 *
 * Two switches play the CLI a sub-agent really runs: `mintSessionIds` ignores
 * the pre-assigned `--session-id` and writes under an id of its own, and
 * `sessionsDir` gets the `<pid>.json` file in which the CLI says which
 * conversation that process is on (`~/.claude/sessions`).
 *
 * It also takes text the way the real composer does (measured on claude
 * 2.1.319 in a macOS PTY, 08/11): a plain write longer than 1022 bytes keeps
 * only its last piece, and a bracketed paste arrives whole, in a
 * `<pasted_content>` block when it is long. See `cliTakes` below.
 *
 * The transcripts live where the router reads them, `~/.claude/projects/<cwd>`:
 * `os.homedir()` is fixed per process under Bun, so every cwd must be inside a
 * throwaway test root, and only the folders this helper created are removed.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { claudeProjectDirName } from "../../../server/lib/claude-transcript-path";

export interface FakeChild {
  cwd: string; sessionId: string;
  /** What the composer holds as typed text. */
  typed: string;
  /** Long bracketed pastes, folded into a placeholder until Enter. */
  pasted: string[];
  promptWrites: number; enters: number; acceptFromEnter: number;
}

/**
 * macOS makes a PTY writer wait once 1022 bytes (TTYHOG - 2) sit unread in
 * the terminal's input queue, so the TUI reads a long write in pieces of 1022.
 */
const PTY_READ_PIECE = 1022;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * What the Claude composer keeps of one write. A plain write longer than
 * 1022 bytes keeps only its last piece: the CLI drops every full one (a
 * 2397-byte brief reached the transcript as its last 353 bytes; production
 * briefs lost exactly 1022, 2044, 3066, 4088 or 13286 bytes of their head). Between
 * bracketed-paste markers the whole text arrives, however it was cut; a long
 * one is folded (measured: 135 bytes stayed inline, 1305 were folded).
 */
function cliTakes(data: string): { typed: string } | { pasted: string } {
  if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
    const text = data.slice(PASTE_START.length, data.length - PASTE_END.length);
    return text.length > 800 || text.includes("\n") ? { pasted: text } : { typed: text };
  }
  const bytes = Buffer.from(data, "utf8");
  if (bytes.length <= PTY_READ_PIECE) return { typed: data };
  const lastPiece = Math.floor((bytes.length - 1) / PTY_READ_PIECE) * PTY_READ_PIECE;
  return { typed: bytes.subarray(lastPiece).toString("utf8") };
}

/** The user record the CLI writes: typed text, then each folded paste in its block. */
function promptRecord(child: FakeChild): string {
  return child.typed + child.pasted
    .map((text, i) => `\n\n<pasted_content id="p${i}">\n${text}\n</pasted_content id="p${i}">\n`)
    .join("");
}

/** The fake bridge, playing the CLI: what it received, and each child's state. */
export interface FakeBridge {
  received: Array<{ type?: string; id?: string; cwd?: string; args?: string[]; data?: string }>;
  children: Map<string, FakeChild>;
  /** Enter that makes the NEXT spawned child write its prompt record (1 = the first). */
  nextAcceptFromEnter: number;
  /** A fresh launch writes under an id it mints, not the `--session-id` it was given (a `--resume` id is kept). */
  mintSessionIds: boolean;
  /** Where each process writes `<pid>.json` with its conversation, as the CLI does; null = a CLI that writes none. */
  sessionsDir: string | null;
  /** Drop every connection and every PTY, as a bridge that died does; `list` then answers empty. */
  dropAll(): void;
  close(): Promise<void>;
  /** The transcript file of a child, or null when its cwd is outside the test root. */
  transcriptFile(cwd: string, sessionId: string): string | null;
  /** Append one record to a child's transcript. */
  append(child: FakeChild, o: unknown): void;
  /** Remove the transcript folders this bridge created. */
  cleanup(): void;
}

export function startFakeClaudeBridge(root: string, socketPath: string): Promise<FakeBridge> {
  /**
   * The transcript folders this bridge CREATED, and only those, are removed at
   * the end. A cwd outside the test root is refused outright: on the code
   * before the fix the child landed in `$HOME`, whose folder holds the owner's
   * real sessions and memory, and a cleanup that removed "the folder it wrote
   * in" deleted it (it happened once while proving a test red, 29/09).
   */
  const createdTranscriptDirs = new Set<string>();
  const insideTestRoot = (cwd: string) =>
    [root, fs.realpathSync(root)].some((r) => cwd === r || cwd.startsWith(`${r}/`));
  function transcriptFile(cwd: string, sessionId: string): string | null {
    if (!insideTestRoot(cwd)) return null;
    const dir = join(homedir(), ".claude", "projects", claudeProjectDirName(cwd));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      createdTranscriptDirs.add(dir);
    }
    return join(dir, `${sessionId}.jsonl`);
  }
  const record = (o: unknown) => JSON.stringify(o) + "\n";
  function append(child: FakeChild, o: unknown): void {
    const file = transcriptFile(child.cwd, child.sessionId);
    if (file) fs.appendFileSync(file, record(o));
  }

  try { fs.unlinkSync(socketPath); } catch { /* not there */ }
  const sockets = new Set<net.Socket>();
  /** The PTYs this bridge holds, as a real one does: `list` answers with them. */
  const alive = new Map<string, number>();
  let pid = 7000;
  const bridge: FakeBridge = {
    received: [],
    children: new Map(),
    nextAcceptFromEnter: 1,
    mintSessionIds: false,
    sessionsDir: null,
    dropAll() { for (const s of sockets) s.destroy(); alive.clear(); },
    close() {
      return new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); });
    },
    transcriptFile,
    append,
    cleanup() { for (const dir of createdTranscriptDirs) fs.rmSync(dir, { recursive: true, force: true }); },
  };
  const reply = (socket: net.Socket, o: unknown) => { try { socket.write(JSON.stringify(o) + "\n"); } catch { /* closed */ } };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => { /* the server closes when it wants */ });
    createInterface({ input: socket }).on("line", (line) => {
      let msg: FakeBridge["received"][number];
      try { msg = JSON.parse(line); } catch { return; }
      bridge.received.push(msg);
      const id = msg.id ?? "";
      if (msg.type === "list") reply(socket, { type: "list", sessions: [...alive].map(([sid, p]) => ({ id: sid, pid: p })) });
      else if (msg.type === "ping") reply(socket, { type: "pong" });
      else if (msg.type === "create") {
        const args = msg.args ?? [];
        const given = args.indexOf("--session-id");
        const resumed = args.indexOf("--resume");
        const sessionId = resumed >= 0 ? args[resumed + 1]!
          : given < 0 ? ""
          : bridge.mintSessionIds ? crypto.randomUUID() : args[given + 1]!;
        const child: FakeChild = {
          cwd: msg.cwd ?? "", sessionId, typed: "", pasted: [], promptWrites: 0, enters: 0,
          acceptFromEnter: bridge.nextAcceptFromEnter,
        };
        bridge.children.set(id, child);
        const file = transcriptFile(child.cwd, child.sessionId);
        // Today's CLI creates its transcript at start-up, before any prompt.
        if (file && !fs.existsSync(file)) {
          append(child, { type: "mode", mode: "default" });
          append(child, { type: "permission-mode", permissionMode: "bypassPermissions" });
          append(child, { type: "system", subtype: "informational", content: "AGENTS.md loaded" });
        }
        const childPid = pid++;
        alive.set(id, childPid);
        if (bridge.sessionsDir) {
          fs.writeFileSync(join(bridge.sessionsDir, `${childPid}.json`), JSON.stringify({ pid: childPid, sessionId: child.sessionId, cwd: child.cwd }));
        }
        reply(socket, { type: "created", id, pid: childPid });
        // The TUI draws its first screen: the terminal has been active once.
        setTimeout(() => reply(socket, { type: "data", id, data: "Welcome to Claude Code" }), 5);
      } else if (msg.type === "buffer") {
        const child = bridge.children.get(id);
        const screen = child && (child.typed || child.pasted.length > 0)
          ? "╭──────────╮\n│ > [Pasted text #1 +40 lines] │\n╰──────────╯"
          : "╭──────────╮\n│ >          │\n╰──────────╯\n Welcome to Claude Code";
        reply(socket, { type: "buffer", id, data: Buffer.from(screen).toString("base64") });
      } else if (msg.type === "write") {
        const child = bridge.children.get(id);
        if (!child) return;
        if (msg.data === "\r") {
          child.enters += 1;
          if ((child.typed || child.pasted.length > 0) && child.enters >= child.acceptFromEnter) {
            append(child, { type: "user", cwd: child.cwd, message: { role: "user", content: promptRecord(child) } });
            child.typed = "";
            child.pasted = [];
          }
        } else {
          const took = cliTakes(msg.data ?? "");
          if ("pasted" in took) child.pasted.push(took.pasted);
          else child.typed += took.typed;
          child.promptWrites += 1;
        }
      } else if (msg.type === "kill") {
        // The CLI removes its own file when it exits.
        const killed = alive.get(id);
        if (bridge.sessionsDir && killed !== undefined) fs.rmSync(join(bridge.sessionsDir, `${killed}.json`), { force: true });
        alive.delete(id);
        setTimeout(() => reply(socket, { type: "exit", id, exitCode: 0 }), 20);
      }
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(bridge)));
}
