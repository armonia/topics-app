/**
 * The «Per te» summary of every card in Review.
 *
 * A periodic sweep, not a hook: it covers the cards already in Review, a card
 * that just entered it and a comment that just arrived with one rule, «the
 * material changed since the last summary». The material is a key (status,
 * question, comment count and last comment time); an unchanged card costs one
 * query and no model call. The summary is written by a cheap model from the
 * description, delivery, comments and question, never by the agent that
 * delivers, and it fails silently: no model, no summary, the card keeps its
 * other texts.
 */
import type { Database } from "bun:sqlite";
import type { AIProvider } from "../providers";
import { parseForYou, type ForYou } from "../../shared/for-you";

export const FOR_YOU_MODEL = "claude-haiku-5-5";
const MAX_PER_SWEEP = 3;

const PROMPT =
  "Sei l'assistente di una persona che deve decidere su una card di lavoro e non conosce il gergo interno. " +
  "Dal materiale ricava un riassunto in parole semplici, in italiano, in quattro righe sempre uguali. " +
  "Rispondi SOLO con JSON: {\"asked\":\"\",\"happened\":\"\",\"done\":\"\",\"remains\":\"\",\"options\":[]}.\n" +
  "asked: cosa ti chiede, in una riga; se non chiede niente scrivi «Niente: va solo chiusa.»\n" +
  "happened: cosa era successo e perche', in una o due frasi.\n" +
  "done: cosa e' stato fatto, in una o due frasi.\n" +
  "remains: cosa resta a te.\n" +
  "options: le scelte come bottoni brevi (max 4), la consigliata per prima; [] se non c'e' scelta.\n" +
  "Regole: parla a «tu»; frasi corte; NIENTE sigle di card, hash, percorsi, nomi di file, numeri di run o di PR; " +
  "niente gergo interno (coordinatore, giro, riservata, agente, worktree, branch): dillo con parole di tutti i giorni. " +
  "Non inventare: se il materiale non lo dice, non lo scrivere.\n\nMateriale:\n";

interface ReviewRow { id: string; project_id: string; text: string; description: string | null; human_ask: string | null; for_you_key: string | null; review_at: string | null }

/** What the summary was written from: when this changes, it is written again. */
function keyOf(db: Database, row: ReviewRow): string {
  const c = db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(created_at), '') AS last FROM task_comments WHERE task_id = ?").get(row.id) as { n: number; last: string };
  return `${row.review_at ?? ""}|${row.human_ask ?? ""}|${c.n}|${c.last}`;
}

function materialOf(db: Database, row: ReviewRow): string {
  const comments = db.prepare("SELECT author, content FROM task_comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 12").all(row.id) as { author: string; content: string }[];
  const thread = comments.reverse().map((c) => `- ${c.author}: ${c.content.slice(0, 700)}`).join("\n");
  return [
    `Titolo: ${row.text}`,
    row.description ? `Descrizione: ${row.description.slice(0, 1500)}` : "",
    row.human_ask ? `Domanda per la persona: ${row.human_ask.slice(0, 600)}` : "",
    `Conversazione (dal piu' vecchio):\n${thread}`,
  ].filter(Boolean).join("\n\n").slice(0, 6000);
}

export async function summarizeForYou(provider: AIProvider, material: string): Promise<ForYou | null> {
  try {
    const out = await provider.complete([{ role: "user", content: PROMPT + material }], { purpose: "card-summary", model: FOR_YOU_MODEL });
    return parseForYou(out.content ?? "");
  } catch {
    return null;
  }
}

/** One pass: summarises up to a few cards in Review whose material changed. Returns the ids written. */
export async function forYouSweep(
  db: Database,
  getProvider: () => AIProvider | null,
  onWritten: (taskId: string, projectId: string) => void,
): Promise<string[]> {
  const provider = getProvider();
  if (!provider) return [];
  const rows = db.prepare(
    "SELECT id, project_id, text, description, human_ask, for_you_key, review_at FROM tasks WHERE status = 'review' AND COALESCE(archived, 0) = 0",
  ).all() as ReviewRow[];
  const written: string[] = [];
  for (const row of rows) {
    if (written.length >= MAX_PER_SWEEP) break;
    const key = keyOf(db, row);
    if (key === row.for_you_key) continue;
    const summary = await summarizeForYou(provider, materialOf(db, row));
    // A failed read is retried on the next pass: the key stays as it was.
    if (!summary) continue;
    db.prepare("UPDATE tasks SET for_you = ?, for_you_key = ? WHERE id = ?").run(JSON.stringify(summary), key, row.id);
    written.push(row.id);
    onWritten(row.id, row.project_id);
  }
  return written;
}
