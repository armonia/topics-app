/**
 * The doors of the scheduled review that read meaning and history
 * (`scheduled-review.ts`): the reviewer model, and the git proof that a claim of
 * "already on main" is true. Each model session judges ONE card and has no tools:
 * the diff and the thread go in the prompt, so reading code it was not shown is
 * impossible and nothing it prints can act on the machine.
 */
import { execFile } from "node:child_process";
import { SPAWN_TIMEOUT } from "../lib/bounded-spawn";
import { runGit } from "../lib/run-git";
import type { SenseVerdict } from "./scheduled-review";

/** The reviewer is never the model that wrote the delivery: when they match, the other one answers. */
export const SENSE_MODEL = "claude-haiku-5-5";
export const SENSE_FALLBACK_MODEL = "claude-sonnet-5-5";
const SENSE_TIMEOUT_MS = 10 * 60_000;
const MAX_DIFF_CHARS = 60_000;
const MAX_THREAD_CHARS = 12_000;

export function senseModelFor(writerModel: string | null | undefined): string {
  return /haiku/i.test(writerModel ?? "") ? SENSE_FALLBACK_MODEL : SENSE_MODEL;
}

export interface SenseInput {
  title: string;
  description: string;
  /** The thread as `author: text` lines, oldest first. */
  thread: string;
  /** What the agent asked a person, when it did. */
  humanAsk: string;
  diff: string;
}

export function buildSensePrompt(input: SenseInput): string {
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[...tagliato]` : text);
  return [
    "Sei il revisore di una consegna di codice. Rispondi SOLO con un oggetto JSON, nessun altro testo.",
    "Domanda unica: il diff fa ciò che chiede la card, e contraddice una decisione scritta nel thread?",
    "Un test verde non basta: i test possono essere scritti sulla stessa idea sbagliata. Controlla che l'effetto sia quello voluto dallo scopo della card, non solo che il codice giri.",
    'Esiti: {"verdict":"ok","note":"una riga"} se fa ciò che chiede e non contraddice nulla; {"verdict":"reject","why":"cosa è sbagliato, con file e correzione concreta"} se difetta o contraddice;',
    '{"verdict":"answer","text":"la risposta tecnica"} se l\'agente ha fatto una domanda tecnica che un ingegnere sa decidere; {"verdict":"person","why":"..."} solo per spesa, cose pubbliche, irreversibili, dati di persone vere, UI da guardare.',
    "",
    `# Card\n${input.title}\n${input.description}`,
    input.humanAsk ? `\n# Domanda dell'agente alla persona\n${input.humanAsk}` : "",
    `\n# Thread\n${clip(input.thread, MAX_THREAD_CHARS)}`,
    `\n# Diff dal merge-base\n${clip(input.diff, MAX_DIFF_CHARS)}`,
  ].join("\n");
}

/** The verdict out of what `claude -p --output-format json` printed; anything unreadable is "unmeasured", never "ok". */
export function parseSense(raw: string): SenseVerdict {
  let text = raw;
  try {
    const envelope = JSON.parse(raw) as { result?: unknown };
    if (typeof envelope.result === "string") text = envelope.result;
  } catch { /* not an envelope: read the text as it is */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { kind: "unmeasured", why: "no JSON in the reviewer's answer" };
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as { verdict?: unknown; note?: unknown; why?: unknown; text?: unknown };
    const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");
    if (v.verdict === "ok") return { kind: "ok", note: str(v.note) || "il diff fa ciò che chiede la card" };
    if (v.verdict === "reject" && str(v.why)) return { kind: "reject", why: str(v.why) };
    if (v.verdict === "answer" && str(v.text)) return { kind: "answer", text: str(v.text) };
    if (v.verdict === "person") return { kind: "person", why: str(v.why) || "serve una persona" };
  } catch { /* falls through */ }
  return { kind: "unmeasured", why: "the reviewer's answer is not a verdict" };
}

/** Runs one reviewer session on `prompt`; `cwd` is an empty folder, the session has no tools. */
export function runSense(prompt: string, model: string, cwd: string): Promise<SenseVerdict> {
  return new Promise((resolve) => {
    // `--allowedTools ""` and the default permission mode leave a headless run with nothing it may execute.
    execFile("claude", ["-p", prompt, "--model", model, "--output-format", "json", "--allowedTools", ""], {
      cwd, timeout: SENSE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
    }, (err, stdout, stderr) => {
      if (err) resolve({ kind: "unmeasured", why: `claude: ${(stderr || err.message).trim().slice(0, 200)}` });
      else resolve(parseSense(stdout));
    });
  });
}

/** The diff of the delivery from its merge-base with origin/main. */
export async function deliveryDiff(repoPath: string, commit: string): Promise<string | null> {
  const base = await runGit(repoPath, ["merge-base", "origin/main", commit], { timeoutMs: SPAWN_TIMEOUT.query });
  if (base.code !== 0) return null;
  const diff = await runGit(repoPath, ["diff", `${base.stdout.trim()}..${commit}`], { timeoutMs: SPAWN_TIMEOUT.long });
  return diff.code === 0 ? diff.stdout : null;
}

/** Is `commit` already inside origin/main? `null` = git could not say (a missing commit is a clean `false`). */
export async function isOnMain(repoPath: string, commit: string): Promise<boolean | null> {
  const r = await runGit(repoPath, ["merge-base", "--is-ancestor", commit, "origin/main"], { timeoutMs: SPAWN_TIMEOUT.query });
  if (r.code === 0) return true;
  return r.code === 1 ? false : null;
}

const ON_MAIN_CLAIM = /(gi[aà] (su|in) main|already (on|in) main)/i;
const SHA = /\b[0-9a-f]{7,40}\b/g;

/** Shas named in the same sentence as an "already on main" claim: pure, the text is the agent's last word. */
export function claimedMainShas(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    if (!ON_MAIN_CLAIM.test(sentence)) continue;
    for (const m of sentence.matchAll(SHA)) if (/\d/.test(m[0])) out.push(m[0]);
  }
  return [...new Set(out)];
}

/** Claimed shas that origin/main does not contain: the claim is checked against the remote branch, not believed. */
export async function falseMainClaims(repoPath: string, text: string): Promise<string[]> {
  const bad: string[] = [];
  for (const sha of claimedMainShas(text).slice(0, 10)) {
    const on = await isOnMain(repoPath, sha);
    if (on !== true) bad.push(sha);
  }
  return bad;
}
