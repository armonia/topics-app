/**
 * I mestieri che un agente deve saper fare su una macchina.
 *
 * PERCHÉ NON C'ERANO. Topics ha 39 tool MCP suoi (task, browser, agenti), ma
 * nessuno per LAVORARE: leggere un file, scriverlo, cercare, eseguire un
 * comando. Non serviva, perché quelle cose le faceva la CLI — `claude` arriva
 * con i suoi tool già dentro, e noi guardavamo passare i risultati. Togliendo
 * la CLI, questo è il buco che resta, ed è il vero costo del runtime nativo.
 *
 * LA FORMA È QUELLA DI ANTHROPIC. Ogni tool ha un nome, una descrizione e uno
 * schema JSON: è ciò che finisce in `tools` nella richiesta, e il modello
 * sceglie in base alla DESCRIZIONE. Sono scritte per il modello, non per noi:
 * una descrizione vaga è un tool usato male.
 *
 * IL PERIMETRO È LA WORKSPACE, ed è il vincolo che rende questo file diverso da
 * un wrapper su `fs`. Un agente che sbaglia percorso non deve poter leggere
 * `~/.ssh` o scrivere fuori dal progetto: ogni percorso viene risolto e
 * verificato contro la radice della sessione PRIMA di toccare il disco. Non è
 * una sandbox — un comando shell può sempre uscirne — ma è la differenza fra un
 * errore e un incidente.
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "fs";
import { resolve, relative, isAbsolute, dirname } from "path";
import { spawn } from "child_process";

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
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** Quanto di un file si legge in una volta, senza `limit`. */
const MAX_READ_BYTES = 400_000;
/** Quanto output di un comando si rimanda al modello. */
const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;

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
      "Replace an exact string in a file. `old` must appear EXACTLY ONCE — if it appears zero times or many, the edit fails and nothing is written, so include enough surrounding context to make it unique. This is the safe way to change part of a file you have read.",
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
];

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ out: string; code: number | null }> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const cap = (d: Buffer) => {
      // Si tronca MENTRE arriva, non alla fine: un comando che sputa un giga
      // non deve riempire la memoria del server prima di essere tagliato.
      if (out.length < MAX_OUTPUT_CHARS * 2) out += d.toString();
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* già morto */ }
      out += `\n[comando ucciso dopo ${timeoutMs}ms]`;
    }, timeoutMs);
    timer.unref?.();
    child.on("close", (code) => { clearTimeout(timer); res({ out, code }); });
    child.on("error", (err) => { clearTimeout(timer); res({ out: String(err), code: null }); });
  });
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
        const { out, code } = await runCommand(
          "/bin/bash", ["-lc", String(input.command)],
          cwd, ctx.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS,
        );
        const body = truncate(out.trim() || "(nessun output)");
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

      default:
        return { content: `tool sconosciuto: ${name}`, isError: true };
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}
