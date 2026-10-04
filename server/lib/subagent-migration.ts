/**
 * Un figlio nato sulla CLI, richiamato dopo che si e' fermato, riparte sul
 * motore di Topics (subagent-nativi). Il `--resume` lo riaccendeva come Claude
 * Code: il 04/10 pop-demo continuava a parlare con «arte-tappa-1» via
 * `send_to_agent` e ogni ripresa riapriva una CLI. La storia della CLI non si
 * trasferisce nella chat nativa: passa il compito, l'ultimo resoconto e il
 * percorso del transcript, che il figlio puo' leggere se gli serve di piu'.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const TASK_MAX = 6_000;
const REPORT_MAX = 4_000;

/** Il transcript di una sessione della CLI, in qualunque cartella di progetto. */
export function findCliTranscript(claudeSessionId: string, projectsDir = join(homedir(), ".claude", "projects")): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(claudeSessionId) || !existsSync(projectsDir)) return null;
  for (const dir of readdirSync(projectsDir)) {
    const p = join(projectsDir, dir, `${claudeSessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text")
    .map((b) => b.text)
    .join("\n");
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n[…tagliato]` : s);

/** Il primo messaggio della persona (il compito) e l'ultimo testo dell'assistente. */
export function cliHandover(jsonl: string): { task: string | null; lastReport: string | null } {
  let task: string | null = null;
  let lastReport: string | null = null;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let row: { type?: string; message?: { content?: unknown } };
    try { row = JSON.parse(line); } catch { continue; }
    const text = textOf(row.message?.content).trim();
    if (!text) continue;
    if (row.type === "user" && task === null) task = text;
    else if (row.type === "assistant") lastReport = text;
  }
  return { task, lastReport };
}

/** Il primo turno del figlio migrato: chi era, cosa aveva fatto, cosa gli si chiede ora. */
export function migratedChildPrompt(input: {
  name: string;
  task: string | null;
  lastReport: string | null;
  transcriptPath: string | null;
  promptSnippet: string | null;
  newInput: string;
}): string {
  const task = input.task ?? input.promptSnippet;
  return [
    `Continui il lavoro del sotto-agente «${input.name}», che finora girava come Claude Code e ora gira sul motore di Topics.`,
    task ? `Il suo compito di partenza:\n<compito>\n${clip(task, TASK_MAX)}\n</compito>` : null,
    input.lastReport ? `Il suo ultimo resoconto:\n<resoconto>\n${clip(input.lastReport, REPORT_MAX)}\n</resoconto>` : null,
    input.transcriptPath ? `Tutta la sua storia, se ti serve un dettaglio: ${input.transcriptPath} (JSONL della CLI).` : null,
    `Il nuovo messaggio di chi ti ha delegato:\n${input.newInput}`,
  ].filter(Boolean).join("\n\n");
}

export function migratedChildPromptFor(row: { name: string; claudeSessionId: string | null; promptSnippet: string | null }, newInput: string): string {
  const transcriptPath = row.claudeSessionId ? findCliTranscript(row.claudeSessionId) : null;
  let handover: { task: string | null; lastReport: string | null } = { task: null, lastReport: null };
  if (transcriptPath) {
    try { handover = cliHandover(readFileSync(transcriptPath, "utf8")); } catch { /* resta il promptSnippet */ }
  }
  return migratedChildPrompt({ name: row.name, ...handover, transcriptPath, promptSnippet: row.promptSnippet, newInput });
}
