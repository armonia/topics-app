/**
 * Starts the periodic opener of project pauses (USAGE-29/30) and fans a
 * transition out to everyone who has to see it: the `project:quota` frame to
 * every window, one bell row per pause, and the owner's own channel outside
 * the app (silent unless `TOPICS_OWNER_ALERT_COMMAND` is configured).
 */
import { recordSystemNotice } from "../attention/system-notices";
import { sendOwnerAlert, parseOwnerAlertCommand, pauseAlertText } from "../services/project-pause-alerts";
import { projectPauseInfo } from "../services/project-pause";
import { runProjectQuotaPauseSweep } from "../services/project-quota-sweep";
import { fireProjectResumed } from "../services/turn-gate";
import type { AppContext } from "../types";

const SWEEP_EVERY_MS = 60_000;
const SWEEP_DELAY_MS = 45_000;

export function startProjectQuotaSweep(ctx: AppContext, baseUrl: string): void {
  const nameOf = (projectId: string): string => {
    try {
      return (ctx.db.query("SELECT name FROM projects WHERE id = ?").get(projectId) as { name?: string } | null)?.name || projectId;
    } catch { return projectId; }
  };
  const broadcast = (projectId: string, points24h: number | null): void => {
    const info = projectPauseInfo(ctx.db, projectId, points24h);
    ctx.broadcastToAll({ type: "project:quota", projectId, paused: info.paused, reason: info.reason, limit: info.limit, points24h: info.points24h });
  };

  function run(): void {
    try {
      runProjectQuotaPauseSweep(ctx.db, {
        onPauseOpened: (projectId, points24h) => {
          broadcast(projectId, points24h);
          const info = projectPauseInfo(ctx.db, projectId, points24h);
          const name = nameOf(projectId);
          const link = `${baseUrl}/?project=${encodeURIComponent(projectId)}`;
          recordSystemNotice({
            key: `project-pause:${projectId}`,
            cycle: String(Date.now()),
            title: `${name}: paused at its daily limit`,
            body: `${points24h !== null ? points24h.toFixed(1) : "?"} points in 24 hours, limit ${info.limit ?? "?"}. Continue or pause until tomorrow from the project.`,
          });
          sendOwnerAlert(parseOwnerAlertCommand(), pauseAlertText({ projectName: name, points24h, limit: info.limit, link }));
        },
        onPauseClosed: (projectId, points24h) => {
          broadcast(projectId, points24h);
          fireProjectResumed(projectId);
        },
      });
    } catch (err) {
      console.warn("[project-quota] sweep round skipped:", (err as Error).message);
    }
  }

  setTimeout(() => {
    run();
    setInterval(run, SWEEP_EVERY_MS).unref?.();
  }, SWEEP_DELAY_MS).unref?.();
}
