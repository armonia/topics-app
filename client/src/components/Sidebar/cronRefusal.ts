/**
 * The refusal, in the words the server used.
 *
 * `/api/cron/*` answers a rejection with `{ error }`, and the job list with
 * `{ jobs: [], warning }` and a 502 when the gateway is down or failed (see
 * `server/routes/cron.ts`), so there is a sentence to show and the panel does
 * not have to invent one. The status code is the fallback for a body that is
 * not JSON: a number is thin, but it still tells a person the click was
 * refused rather than ignored.
 *
 * Its own module: `CronJobsPanel.tsx` exports a component, and a second export
 * there would cost Fast Refresh on every edit of the panel.
 */
export async function refusal(res: Response, what: string): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown; warning?: unknown } | null;
  const said = typeof body?.error === 'string' ? body.error : typeof body?.warning === 'string' ? body.warning : '';
  const detail = said.trim();
  return detail ? `${what}: ${detail}` : `${what}: HTTP ${res.status}`;
}
