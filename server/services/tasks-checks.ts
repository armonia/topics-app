/** Parsers for the `checks_json` column of a task, split out of tasks.ts (move only). */
import type { CheckRun } from "./review-checks";

/**
 * `tasks.checks_json` → `CheckRun[]`. Tollerante come il parser delle impostazioni:
 * un JSON storto (riga scritta a mano, formato di una versione precedente) vale
 * "nessuna evidenza", non un'eccezione che fa esplodere OGNI lettura del task.
 */
export function parseChecksJson(raw: unknown): CheckRun[] | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.length ? (parsed as CheckRun[]) : null;
    // FORMA NUOVA: `{ progress, runs }`, scritta mentre la corsa e' in volo.
    // I `runs` parziali sono comunque risultati veri (i comandi gia' finiti),
    // e chi legge questa funzione li vuole uguale.
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { runs?: unknown }).runs)) {
      const runs = (parsed as { runs: CheckRun[] }).runs;
      return runs.length ? runs : null;
    }
    return null;
  } catch { return null; }
}

/**
 * A che punto e' la corsa dei controlli: `{ done, total }`, o `null`.
 *
 * Vive in `checks_json` accanto ai run parziali (vedi `recordChecks`). Esiste
 * perche' la card diceva «check in corso» e basta — segnalato: «se c'e'
 * qualcosa in corso, dovrebbe esserci un progress».
 */
export function parseChecksProgress(raw: unknown): { done: number; total: number } | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) || !parsed || typeof parsed !== "object") return null;
    const p = (parsed as { progress?: unknown }).progress;
    if (!p || typeof p !== "object") return null;
    const { done, total } = p as { done?: unknown; total?: unknown };
    // Numeri veri e coerenti, o niente: un «3 su 0» a schermo e' peggio del
    // silenzio, e un NaN attraversa tutto fino alla card.
    if (typeof done !== "number" || typeof total !== "number") return null;
    if (!Number.isFinite(done) || !Number.isFinite(total)) return null;
    if (total <= 0 || done < 0 || done > total) return null;
    return { done, total };
  } catch { return null; }
}

/**
 * The pull request and the CI run a delivery is waiting on, or `null`.
 *
 * Same lodging as the progress, and for the same reason: it is worth something
 * for the minutes of the wait and nothing after it, so a column and a migration
 * would be out of proportion. Only `https://` links are kept — the value is
 * rendered as a link on the card, and the only writer is the CI reader, but a
 * check on the shape costs one line and closes the question.
 */
export function parseChecksCi(raw: unknown): { prUrl: string; runUrl?: string } | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) || !parsed || typeof parsed !== "object") return null;
    const ci = (parsed as { ci?: unknown }).ci;
    if (!ci || typeof ci !== "object") return null;
    const { prUrl, runUrl } = ci as { prUrl?: unknown; runUrl?: unknown };
    const link = (v: unknown): string | null => (typeof v === "string" && v.startsWith("https://") ? v : null);
    const pr = link(prUrl);
    if (!pr) return null;
    const runLink = link(runUrl);
    return runLink ? { prUrl: pr, runUrl: runLink } : { prUrl: pr };
  } catch { return null; }
}

