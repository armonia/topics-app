/**
 * Where a new card is born: the readable title in the background and the board it lands on.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { titoloMigliore } from "../services/task-title";
import { AUTO_PROJECT_ID, projectIdForPath, UNASSIGNED_PROJECT_ID } from "../services/tasks";
import type { TasksCore } from "./tasks-scope";

export function createTasksIntake(core: TasksCore) {
  const { opts, svc, db, broadcastToAll } = core;

  /**
   * UN TITOLO LEGGIBILE, in sottofondo, per una card appena nata.
   *
   * VIVE QUI e non dentro una delle due rotte perche' i creatori sono DUE e
   * il difetto e' lo stesso per entrambi: la board (una persona che scrive o
   * detta) e `create_task` via MCP (un agente). La prima versione lo cablava
   * solo sulla rotta della board, e sul database vivo quella scelta lasciava
   * scoperti 267 titoli oltre gli 80 caratteri creati da agenti — il difetto
   * c'era, era solo meno visibile perche' lo schema MCP chiede «Task title /
   * one-line description» e di solito viene rispettato.
   *
   * In background per costruzione: la `create` risponde subito con la card e
   * il titolo migliore arriva un istante dopo via `task:updated`. Se il modello
   * non c'e' o risponde storto, non succede niente e resta il titolo di
   * partenza — un titolo e' una comodita', non puo' far fallire una card.
   */
  function titoloInSottofondo(task: { id: string; text: string; description: string | null }, projectId: string): void {
    void (async () => {
      try {
        const prov = opts?.namingProvider?.();
        if (!prov) return;
        const migliore = await titoloMigliore(prov, { text: task.text, description: task.description });
        if (!migliore) return;
        // Riletta PRIMA di scrivere: fra la chiamata al modello e qui (secondi)
        // qualcuno puo' aver rinominato la card a mano, e quella e' una scelta
        // esplicita che non si sovrascrive.
        const fresca = svc.get(task.id)?.task;
        if (!fresca || fresca.text !== task.text) return;
        const aggiornata = svc.update({
          taskId: task.id, actor: "agent", by: "system",
          projectId, patch: { text: migliore },
        });
        if (aggiornata) broadcastToAll({ type: "task:updated", projectId, task: aggiornata });
      } catch { /* un titolo e' una comodita': non fallisce mai la card */ }
    })();
  }

  /**
   * `tasks.project_id` is a BOARD id (`projectIdForPath(path)`), NOT the
   * `projects.id` record key, which is a UUID. A caller that passes the UUID
   * read from `GET /api/projects` — a reasonable and wrong choice — gives
   * birth to the task on a board nobody reads: the kanban grows a second
   * column showing the raw UUID beside the real one, and nothing errors
   * anywhere. Translate the UUID to the board it actually belongs to.
   *
   * Only a UUID that really exists in `projects` is translated; any other id
   * passes through untouched, so legacy boards whose id happened to equal
   * `projects.id` keep working (see `server/lib/tab-resolver.ts`).
   */
  function boardIdFromProjectRowId(projectId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) return projectId;
    try {
      const row = db.query("SELECT path FROM projects WHERE id = ?").get(projectId) as { path?: string } | null;
      if (row?.path) return projectIdForPath(row.path);
    } catch { /* best-effort: an untranslatable id stays as it is */ }
    return projectId;
  }

  /**
   * Project "Auto" → the REAL board. Resolve a known project name mentioned in
   * the task text. Exactly one distinct hit → that board (auto-assigned).
   * None/ambiguous → the catch-all workspace so the task STILL RUNS standalone
   * — a project-less task MUST dispatch (by request). The dispatcher only ticks
   * real boards, so the catch-all is a real (scaffolded, non-git, in-place)
   * board; its "generale" label is hidden client-side (the card treats it as
   * "no project"). Only a host with no workspace at all degrades to UNASSIGNED.
   *
   * Shared by create AND by the intake suggester: the proposal has to look at
   * the SAME board the task would be born on, or it would offer to link a
   * landing-feedback card to whatever sits on the wrong board.
   */
  function resolveBoardId(projectId: string, text: unknown, description: unknown): string {
    if (projectId !== AUTO_PROJECT_ID) return boardIdFromProjectRowId(projectId);
    const haystack = `${typeof text === "string" ? text : ""}\n${typeof description === "string" ? description : ""}`.toLowerCase();
    const hits = new Set<string>();
    let dirs: string[] = [];
    try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
    for (const raw of dirs) {
      if (typeof raw !== "string" || !raw.startsWith("/")) continue;
      const path = raw.replace(/\/+$/, "");
      const name = basename(path).toLowerCase();
      if (name.length < 3) continue; // too generic to be a mention
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(haystack)) hits.add(projectIdForPath(path));
    }
    if (hits.size === 1) return [...hits][0];
    if (!opts?.workspaceDir) return UNASSIGNED_PROJECT_ID; // degraded host (no workspace)
    const dir = join(opts.workspaceDir, "generale");
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "CLAUDE.md"), "# generale\n\nWorkspace catch-all: i task senza progetto girano qui, in-place (non-git).\n");
        // Non-git → dispatch in-place (no worktree). Nothing else to set: a
        // fresh board defaults autoDispatch on, so a project-less task starts
        // without any manual setup.
        svc.updateBoardSettings(projectIdForPath(dir), { dispatchUseWorktree: false });
      } catch { /* fall through to unassigned below */ }
    }
    return existsSync(dir) ? projectIdForPath(dir) : UNASSIGNED_PROJECT_ID;
  }

  return { titoloInSottofondo, boardIdFromProjectRowId, resolveBoardId };
}
