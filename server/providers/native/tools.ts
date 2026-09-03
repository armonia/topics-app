/**
 * The trades an agent must know how to practise on a machine.
 *
 * WHY THEY WERE MISSING. Topics has 39 MCP tools of its own (tasks, browser,
 * agents), but none for WORKING: read a file, write it, search, run a command.
 * They were not needed, because the CLI did those things — `claude` arrives with
 * its own tools built in, and we watched the results go by. Take the CLI away
 * and this is the hole left behind, and the real cost of the native runtime.
 *
 * THE SHAPE IS ANTHROPIC'S. Every tool has a name, a description and a JSON
 * schema: that is what ends up in `tools` on the request, and the model chooses
 * on the DESCRIPTION. They are written for the model, not for us: a vague
 * description is a tool used badly.
 *
 * THE PERIMETER IS THE WORKSPACE, and it is the constraint that makes this file
 * something other than a wrapper over `fs`. An agent that gets a path wrong must
 * not be able to read `~/.ssh` or write outside the project: every path is
 * resolved and checked against the session root BEFORE touching the disk. It is
 * not a sandbox — a shell command can always step out — but it is the difference
 * between a mistake and an incident.
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "fs";
import { resolve, relative, isAbsolute, dirname } from "path";
import { spawn } from "child_process";
import { killProcessTree } from "../../lib/process-tree";
import { readSlashCommandSource } from "../../lib/slash-command-source";
import { htmlToMarkdown } from "../../lib/html-to-markdown";

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface ToolContext {
  /** La radice entro cui questo agente può operare. */
  workspace: string;
  /** Timeout dei comandi shell, in millisecondi. */
  bashTimeoutMs?: number;
  /**
   * LA FINE DEL TURNO DEVE ARRIVARE FIN QUI DENTRO.
   *
   * Il ciclo dell'agente guarda `signal.aborted` in cima a ogni giro, ma un
   * turno passa la maggior parte del tempo FERMO dentro un tool: da lì il
   * controllo in cima non si raggiunge più. Il 20/08 su topic:9f9e9629 lo
   * spegnimento del server ha annullato un turno bloccato in un `bash` con un
   * `sleep 100`; nessuno ascoltava, il processo è uscito prima, e la chat è
   * rimasta con una risposta troncata a metà frase e nessuna spiegazione — il
   * cartello che l'avrebbe scritta si accende dopo `onAborted`, che su quel
   * cammino non è mai arrivato.
   *
   * Chi esegue un comando lungo lo passa a `runCommand`, che ci attacca
   * l'uccisione dell'albero. Assente = comportamento di prima, invariato.
   */
  signal?: AbortSignal;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/**
 * How much of a file one call reads, without `limit`. It was 400k: two such
 * reads in the same round were enough on their own to blow a 200k window,
 * and the 400 they produced stayed in the session for good. Now it is of the
 * order of the CLI's 2000 lines: past that, the tool says to page.
 */
const MAX_READ_BYTES = 120_000;
/** Quanto output di un comando si rimanda al modello. */
const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
/** How long the last output still in the pipe gets, after the leader has exited. */
const DRAIN_AFTER_EXIT_MS = 250;
/** How long a kill gets before the answer goes out anyway, event or no event. */
const GRACE_AFTER_KILL_MS = 2_000;
/** How long a URL gets to answer. A page that needs longer is not documentation. */
const WEB_FETCH_TIMEOUT_MS = 30_000;
/** Cosa legge l'agente — e l'utente — quando il turno muore sotto un comando. */
const MOTIVO_ANNULLATO = "[comando interrotto: il turno è stato annullato mentre girava]";

/**
 * Risolve un percorso DENTRO la workspace, o spiega perché no.
 *
 * Il controllo è su `relative()` e non su `startsWith()`: `/tmp/progetto-altro`
 * comincia per `/tmp/progetto` ma non ci sta dentro, e un confronto di stringhe
 * lo lascerebbe passare. `relative()` risponde con `..` quando si esce, che è
 * la domanda vera.
 */
function safePath(ctx: ToolContext, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(ctx.workspace, p);
  const rel = relative(resolve(ctx.workspace), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`percorso fuori dalla workspace: ${p}`);
  }
  return abs;
}

function truncate(s: string, max = MAX_OUTPUT_CHARS): string {
  if (s.length <= max) return s;
  const cut = s.length - max;
  return `${s.slice(0, max)}\n\n[...troncato: altri ${cut} caratteri]`;
}

export const CODING_TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    description:
      "Read a file from the workspace. Returns the content with 1-based line numbers, which is what you need to then edit it precisely. Use `offset`/`limit` for large files. Prefer this over `bash cat`: the line numbers make edits reliable.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path, absolute or relative to the workspace root." },
        offset: { type: "number", description: "First line to read (1-based). Omit to start from the top." },
        limit: { type: "number", description: "How many lines to read. Omit for the whole file." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write a file, creating parent directories as needed. OVERWRITES the whole file: to change part of an existing file use `edit_file` instead, which cannot silently discard content you did not read.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path, absolute or relative to the workspace root." },
        content: { type: "string", description: "The full new content of the file." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact string in a file. `old` must appear EXACTLY ONCE. If it appears zero times or many, the edit fails and nothing is written, so include enough surrounding context to make it unique. This is the safe way to change part of a file you have read.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path, absolute or relative to the workspace root." },
        old: { type: "string", description: "Exact text to find. Must be unique in the file." },
        new: { type: "string", description: "Text to put in its place." },
      },
      required: ["path", "old", "new"],
    },
  },
  {
    name: "bash",
    description:
      "Run a shell command in the workspace. Use it for git, builds, tests, and any tool the machine already has. Output is captured (stdout+stderr) and truncated if huge. Non-interactive only: a command that waits for input will hit the timeout.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run." },
        cwd: { type: "string", description: "Working directory, relative to the workspace. Defaults to the workspace root." },
      },
      required: ["command"],
    },
  },
  {
    name: "grep",
    description:
      "Search file CONTENTS for a regular expression, recursively. Returns matching lines with file and line number. This is how you find where something is defined or used, before reading whole files.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "Directory or file to search. Defaults to the workspace root." },
        glob: { type: "string", description: "Only search files matching this glob, e.g. '*.ts'." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description:
      "Find files by NAME pattern, e.g. '**/*.test.ts'. Use this when you know what a file is called; use `grep` when you know what is inside it.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, relative to the search root." },
        path: { type: "string", description: "Directory to search from. Defaults to the workspace root." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "todo_write",
    description:
      "Write or update the task list for the work you are doing right now. Use it for any job with three or more steps, or when the user gives you several things at once: send the whole list every time (it REPLACES the previous one), marking each item pending, in_progress or completed. Keep exactly one item in_progress, and mark it completed as soon as it is done rather than in a batch at the end. The list is shown to the user while you work, so it is also how they see what you understood and where you are.",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The complete list, in order. It replaces the previous one.",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "The step, imperative and short: 'Add the endpoint'." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Where this step stands." },
              activeForm: { type: "string", description: "The same step in the present continuous, shown while it runs: 'Adding the endpoint'." },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a URL and read it as text: HTML comes back as markdown (headings, lists, links and code kept), JSON pretty-printed, plain text as it is. Use it for documentation, release notes, an API response, a raw file on the web. It does NOT run JavaScript, so a page that builds its content in the browser comes back nearly empty. Only http and https, and it never sends a body: this is reading, not calling.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL." },
        max_chars: { type: "number", description: "Cap on the text returned. Default 30000." },
      },
      required: ["url"],
    },
  },
  {
    name: "skill",
    description:
      "Load a skill: a procedure already written for a recurring task (deploys, reviews, repo-specific workflows). The available skills are listed in your system prompt with one-line descriptions. Call this BEFORE improvising when the task matches one of them. What comes back are instructions to follow in place of your default approach. If the user types /<name>, that is an explicit request to invoke it.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact skill name from the list in your system prompt, no leading slash." },
      },
      required: ["name"],
    },
  },
];

/**
 * The tools that do not need a project on disk.
 *
 * A conversation with no workspace is offered NO tool, and the reason is sound
 * for every tool that resolves a path: an agent handed `read_file` with no root
 * guesses where the project is, and guessing means touching files at random.
 * These two resolve nothing. The plan lives in the transcript and the fetch goes
 * to the network, so withholding them buys no safety and costs the obvious
 * thing: a plain chat asked to read a URL could not, and had to explain why to
 * someone who can see the browser pane two panes away.
 */
const WORKSPACE_FREE = new Set(["todo_write", "web_fetch"]);
export const WORKSPACE_FREE_TOOLS: ToolSpec[] = CODING_TOOLS.filter((t) => WORKSPACE_FREE.has(t.name));

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ out: string; code: number | null; annullato?: boolean }> {
  // Già annullato: far partire il comando vorrebbe dire spendere secondi per
  // un risultato che nessuno leggerà, sul cammino di uno spegnimento che ha
  // fretta. Si risponde subito, e con la ragione.
  if (signal?.aborted) return { out: MOTIVO_ANNULLATO, code: null, annullato: true };
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let annullato = false;
    const cap = (d: Buffer) => {
      // Si tronca MENTRE arriva, non alla fine: un comando che sputa un giga
      // non deve riempire la memoria del server prima di essere tagliato.
      if (out.length < MAX_OUTPUT_CHARS * 2) out += d.toString();
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const abbatti = () => {
      // TUTTO L'ALBERO, non il solo figlio. Il comando gira in una shell, e chi
      // lavora davvero (il compilatore, il server, il test runner) e' un suo
      // discendente: un segnale al solo wrapper lasciava vivo il lavoro che il
      // timeout doveva fermare, con la sua porta e la sua CPU.
      killProcessTree(child.pid ?? 0).catch(() => { /* nessuno da uccidere */ });
    };
    let closed = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const chiudi = (r: { out: string; code: number | null }) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      signal?.removeEventListener("abort", suAbort);
      res({ ...r, ...(annullato ? { annullato: true } : {}) });
    };
    // The answer goes out after the grace EVEN IF no event arrives: killing is a
    // request, not a guarantee. The leader may already be gone (its children
    // reparented to init, out of reach of a tree computed from its pid) or may
    // ignore the signal. A timeout that does not answer is worse than the
    // command it was there to bound.
    const giveUp = () => {
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(() => chiudi({ out, code: null }), GRACE_AFTER_KILL_MS);
      drainTimer.unref?.();
    };
    const timer = setTimeout(() => {
      abbatti();
      out += `\n[comando ucciso dopo ${timeoutMs}ms]`;
      giveUp();
    }, timeoutMs);
    timer.unref?.();
    // IL TURNO È FINITO MENTRE IL COMANDO GIRAVA. Non è il timeout del comando:
    // è lo spegnimento del server o uno stop dell'utente, e la differenza va
    // detta — `[exit null]` nudo manda a cercare un guasto che non c'è stato.
    function suAbort() {
      annullato = true;
      abbatti();
      out += `\n${MOTIVO_ANNULLATO}`;
      giveUp();
    }
    signal?.addEventListener("abort", suAbort, { once: true });
    // IT WAITS FOR `exit`, NOT `close`. `close` arrives when the process has
    // exited AND every pipe we gave it is closed — and those pipes are inherited
    // by anything descending from it. `cd x && nohup <daemon> > log 2>&1 &`
    // redirects the daemon, but the subshell waiting on it keeps OUR stdout and
    // stderr open: `close` never comes. On 2026-09-02 two turns sat on
    // `bash:running` for hours that way, with the tool promise never resolved,
    // the agent loop stuck inside its await, and every watchdog above convinced
    // it was working.
    // `exit` looks at the leader alone. What is still in the pipe is collected in
    // a short drain window, then the answer goes out.
    child.on("exit", (code) => {
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(() => chiudi({ out, code }), DRAIN_AFTER_EXIT_MS);
      drainTimer.unref?.();
    });
    child.on("close", (code) => chiudi({ out, code }));
    child.on("error", (err) => chiudi({ out: String(err), code: null }));
  });
}

/**
 * A URL, downloaded and turned into something worth spending tokens on.
 *
 * THE BODY IS READ WITH A CAP WHILE IT ARRIVES, exactly like a shell command's
 * output and for the same reason: a URL is whatever the model typed, and a
 * mistyped one can be a release tarball or a database dump. Waiting for
 * `res.text()` on that means the server holds the whole thing in memory before
 * discovering it had to throw it away.
 *
 * THE CONTENT TYPE DECIDES, not the extension: a `.php` that answers JSON is
 * JSON, and a URL ending in `.md` that answers a login page is HTML. What is
 * not text at all comes back as a NAMED refusal ("image/png, 240 kB") rather
 * than as mojibake the model would try to read.
 */
async function fetchAsText(u: URL, cap: number, signal?: AbortSignal): Promise<ToolResult> {
  // Already cancelled: opening the connection would spend seconds of a shutdown
  // that has none for an answer nobody will read. Same rule as `runCommand`, and
  // it has to be a CHECK, not a listener: `abort` has already fired.
  if (signal?.aborted) return { content: MOTIVO_ANNULLATO, isError: true };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WEB_FETCH_TIMEOUT_MS);
  timer.unref?.();
  // The turn's end reaches in here too: a fetch on a host that never answers
  // would otherwise hold a shutdown for its full timeout.
  const forwardAbort = () => ac.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const res = await fetch(u.toString(), {
      redirect: "follow",
      signal: ac.signal,
      headers: {
        // A default-less fetch is refused by a fair number of sites, and the
        // honest answer to "who is asking" is a name, not a browser costume.
        "user-agent": "topics-agent/1.0 (+https://armonia.io)",
        accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
        "accept-language": "en,it;q=0.9",
      },
    });

    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const body = res.body ? await readCapped(res.body, cap * 4) : "";

    if (!res.ok) {
      // The status alone sends the model guessing. The first lines of the body
      // are usually the API's own explanation of what it disliked.
      const head = plainish(type, body, u).slice(0, 2_000);
      return { content: `[HTTP ${res.status} ${res.statusText}] ${u.toString()}\n${head}`, isError: true };
    }
    if (!isTextual(type)) {
      const size = res.headers.get("content-length");
      return {
        content: `not a text resource: ${type || "unknown content type"}${size ? `, ${size} bytes` : ""}. `
          + `Download it with bash if you need the file itself.`,
        isError: true,
      };
    }

    const finale = res.url && res.url !== u.toString() ? `\n(redirected to ${res.url})` : "";
    if (type.includes("json")) {
      let pretty = body;
      try { pretty = JSON.stringify(JSON.parse(body), null, 2); } catch { /* not valid JSON: it stays as it came */ }
      return { content: truncate(`# ${u.toString()}${finale}\n\n${pretty.trim()}`, cap) };
    }
    if (type.includes("html") || type.includes("xhtml")) {
      const page = htmlToMarkdown(body, res.url || u.toString());
      const head = `# ${page.title ?? u.hostname}\n${u.toString()}${finale}`;
      const text = page.markdown.trim();
      return {
        content: truncate(
          text
            ? `${head}\n\n${text}`
            // An empty extraction is a RESULT, and saying which one saves the
            // model a second identical fetch: the page paints itself in the
            // browser, and no regex will ever find text that is not in the HTML.
            : `${head}\n\n(no readable text in the HTML: the page probably builds its content with JavaScript, `
              + `which this tool does not run)`,
          cap,
        ),
      };
    }
    return { content: truncate(`# ${u.toString()}${finale}\n\n${body.trim()}`, cap) };
  } catch (err) {
    if (signal?.aborted) return { content: MOTIVO_ANNULLATO, isError: true };
    if (ac.signal.aborted) return { content: `${u.toString()} did not answer within ${WEB_FETCH_TIMEOUT_MS}ms`, isError: true };
    // DNS, TLS, connection refused: the message is the useful part.
    return { content: `could not fetch ${u.toString()}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

/** Is this something a model can read, or a blob to be downloaded? */
function isTextual(contentType: string): boolean {
  if (!contentType) return true; // no header at all: try, the worst case is noise
  return /^text\//.test(contentType)
    || /(json|xml|javascript|ecmascript|x-yaml|yaml|csv|markdown|x-sh|urlencoded)/.test(contentType);
}

/** The body when it is only going into an error line: readable, not pretty. */
function plainish(type: string, body: string, u: URL): string {
  return type.includes("html") ? htmlToMarkdown(body, u.toString()).markdown : body.trim();
}

/** Read a stream up to `maxBytes` and stop pulling: the rest is never downloaded. */
async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => { /* the other end is already gone */ });
  }
  return out + decoder.decode();
}

/**
 * Esegue un tool e restituisce ciò che il modello leggerà.
 *
 * Gli errori NON vengono sollevati: tornano come `isError: true` con il testo
 * del problema. È il patto di Anthropic per i tool, e ha una ragione — un
 * agente che riceve «il file non esiste» corregge il tiro da solo, mentre
 * un'eccezione gli fa sparire il turno sotto i piedi.
 */
export async function executeTool(
  name: string,
  input: Record<string, any>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "read_file": {
        const p = safePath(ctx, String(input.path));
        if (!existsSync(p)) return { content: `file non trovato: ${input.path}`, isError: true };
        const st = statSync(p);
        if (st.isDirectory()) return { content: `${input.path} è una directory, non un file`, isError: true };
        const raw = readFileSync(p, "utf-8");
        const lines = raw.split("\n");
        const start = Math.max(0, (Number(input.offset) || 1) - 1);
        const end = input.limit ? start + Number(input.limit) : lines.length;
        const slice = lines.slice(start, end);
        if (slice.join("\n").length > MAX_READ_BYTES) {
          return { content: `file troppo grande: usa offset/limit (${st.size} byte)`, isError: true };
        }
        const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`).join("\n");
        return { content: numbered || "(file vuoto)" };
      }

      case "write_file": {
        const p = safePath(ctx, String(input.path));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(input.content ?? ""));
        return { content: `scritto ${input.path} (${String(input.content ?? "").length} byte)` };
      }

      case "edit_file": {
        const p = safePath(ctx, String(input.path));
        if (!existsSync(p)) return { content: `file non trovato: ${input.path}`, isError: true };
        const raw = readFileSync(p, "utf-8");
        const old = String(input.old ?? "");
        if (!old) return { content: "`old` non può essere vuoto", isError: true };
        const n = raw.split(old).length - 1;
        // Zero e molti sono due errori diversi, e dirlo aiuta il modello a
        // correggersi: nel primo caso ha sbagliato il testo, nel secondo deve
        // allargare il contesto.
        if (n === 0) return { content: `\`old\` non trovato in ${input.path}`, isError: true };
        if (n > 1) return { content: `\`old\` compare ${n} volte in ${input.path}: aggiungi contesto per renderlo unico`, isError: true };
        writeFileSync(p, raw.replace(old, String(input.new ?? "")));
        return { content: `modificato ${input.path}` };
      }

      case "bash": {
        const cwd = input.cwd ? safePath(ctx, String(input.cwd)) : resolve(ctx.workspace);
        const { out, code, annullato } = await runCommand(
          "/bin/bash", ["-lc", String(input.command)],
          cwd, ctx.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS, ctx.signal,
        );
        const body = truncate(out.trim() || "(nessun output)");
        // Annullato non è fallito: `[exit null]` racconterebbe un comando
        // andato male, e manderebbe a cercare un guasto che non c'è stato.
        if (annullato) return { content: body, isError: true };
        // Il codice d'uscita si riporta SEMPRE quando non è zero: senza, un
        // test fallito e un test passato hanno lo stesso aspetto.
        return code === 0 ? { content: body } : { content: `[exit ${code}]\n${body}`, isError: code !== 0 };
      }

      case "grep": {
        const root = input.path ? safePath(ctx, String(input.path)) : resolve(ctx.workspace);
        const args = ["-rn", "--color=never"];
        if (input.glob) args.push(`--include=${String(input.glob)}`);
        args.push(String(input.pattern), root);
        const { out, code } = await runCommand("/usr/bin/grep", args, resolve(ctx.workspace), 30_000);
        // grep esce 1 quando non trova niente: è una risposta, non un errore.
        if (code === 1 && !out.trim()) return { content: "nessuna corrispondenza" };
        return { content: truncate(out.trim() || "nessuna corrispondenza") };
      }

      case "glob": {
        const root = input.path ? safePath(ctx, String(input.path)) : resolve(ctx.workspace);
        const { out } = await runCommand(
          "/bin/bash",
          ["-lc", `shopt -s globstar nullglob dotglob; cd ${JSON.stringify(root)} && printf '%s\\n' ${String(input.pattern)}`],
          resolve(ctx.workspace), 30_000,
        );
        return { content: truncate(out.trim() || "nessun file") };
      }

      // THE PLAN IS THE RESULT: this tool writes nothing and runs nothing.
      //
      // Its whole job is to put the list in the transcript, where the client
      // already renders it (a call named `todo_write` carrying `todos` becomes
      // the todo card and the sticky strip above the composer, via
      // `deriveToolDetail`). So the only work here is refusing a shape that
      // would render as an empty card, and answering with a tally the model can
      // check itself against.
      case "todo_write": {
        const raw = input.todos;
        if (!Array.isArray(raw) || raw.length === 0) {
          return { content: "`todos` must be a non-empty array of {content, status}", isError: true };
        }
        const items: Array<{ content: string; status: string }> = [];
        for (const t of raw) {
          const content = String((t as Record<string, unknown>)?.content ?? "").trim();
          const status = String((t as Record<string, unknown>)?.status ?? "");
          if (!content) return { content: "every todo needs a non-empty `content`", isError: true };
          if (status !== "pending" && status !== "in_progress" && status !== "completed") {
            return { content: `unknown status "${status}" for "${content}": use pending, in_progress or completed`, isError: true };
          }
          items.push({ content, status });
        }
        const n = (s: string) => items.filter((t) => t.status === s).length;
        const running = n("in_progress");
        // MORE THAN ONE STEP IN PROGRESS IS SAID, NOT REFUSED. It costs the
        // model a round to fix a list that is already on screen and already
        // readable, and the point of the rule is focus, not validity.
        const note = running > 1 ? ` (${running} at once: keep one)` : "";
        return { content: `plan updated: ${n("completed")} done, ${running} in progress${note}, ${n("pending")} pending, ${items.length} total` };
      }

      // READING THE WEB IS NOT RUNNING IT, and the scheme check is where that
      // sentence is enforced. `file://` here would be a way to read anything on
      // the disk through a tool that stays open in «ask» mode, walking straight
      // around the workspace perimeter every other file tool respects; the same
      // goes for `data:` and the rest. Two lines, one real hole closed.
      case "web_fetch": {
        let u: URL;
        try { u = new URL(String(input.url ?? "")); }
        catch { return { content: `not a valid URL: ${input.url}`, isError: true }; }
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          return { content: `only http and https: ${u.protocol} is not fetched (to read a local file use read_file)`, isError: true };
        }
        const cap = Math.min(Math.max(Number(input.max_chars) || MAX_OUTPUT_CHARS, 1_000), 200_000);
        return await fetchAsText(u, cap, ctx.signal);
      }

      // Il corpo di una skill NON passa da `read_file`: quella è murata dentro
      // la workspace, e le skill stanno in casa dell'utente (`~/.agents/skills`).
      // Il cancello sui nomi è in `slash-command-source.ts` e non si riscrive qui.
      case "skill": {
        const src = readSlashCommandSource(String(input.name ?? ""));
        if (!src || src.kind !== "skill") {
          return { content: `skill sconosciuta: ${input.name}. Usa solo i nomi elencati nel prompt di sistema.`, isError: true };
        }
        return { content: truncate(src.body, 60_000) };
      }

      default:
        return { content: `tool sconosciuto: ${name}`, isError: true };
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}
