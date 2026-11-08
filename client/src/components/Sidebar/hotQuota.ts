/**
 * THE HOTTEST QUOTA, on the card with your name and in the tail of the row
 * that opens «Account e quote» (hub-smistamento, HUBBR-10).
 *
 * A module of its own because the card is in the first paint of every window:
 * next to the form tails it would pull their imports into the entry chunk.
 * Pure: the hub's `pace` in, the words out.
 */
import type { Translate } from '../../../../shared/queue-reason-text';

/** From here a quota is worth a signal on the user card: under it the card says nothing. */
export const HOT_QUOTA_AT = 80;

const PLAN_PROVIDER_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', muse: 'Muse' };

/**
 * THE HOTTEST QUOTA, on the card with your name (hub-smistamento): the plan in
 * use whose week or five hours is highest, only from `HOT_QUOTA_AT`. An account
 * that is not in use is left out: two spent accounts waiting for their reset
 * would keep the card at 100% all week and teach nobody anything. Read from the
 * hub's `pace`; null without the hub or below the threshold.
 */
export function highestQuota(pace: unknown, tr: Translate): { text: string; title: string; pct: number } | null {
  if (!Array.isArray(pace)) return null;
  let best: { pct: number; week: boolean; who: string } | null = null;
  for (const r of pace) {
    if (typeof r !== 'object' || r === null) continue;
    const row = r as { provider?: unknown; account?: unknown; active?: unknown; used?: unknown; fiveHour?: { used?: unknown } | null };
    if (row.active !== true) continue;
    const who = `${PLAN_PROVIDER_NAME[String(row.provider)] ?? String(row.provider)} ${typeof row.account === 'string' ? row.account : ''}`.trim();
    const week = typeof row.used === 'number' ? row.used : -1;
    const five = typeof row.fiveHour?.used === 'number' ? row.fiveHour.used : -1;
    const pick = week >= five ? { pct: week, week: true } : { pct: five, week: false };
    if (!best || pick.pct > best.pct) best = { ...pick, who };
  }
  if (!best || best.pct < HOT_QUOTA_AT) return null;
  const pct = Math.round(best.pct);
  return {
    pct,
    text: tr(best.week ? 'accounts.hot.week' : 'accounts.hot.fiveH', { pct }),
    title: tr('accounts.hot.title', { who: best.who, window: tr(best.week ? 'accounts.window.week' : 'accounts.window.fiveH'), pct }),
  };
}

/**
 * THE PROFILE DOOR OF THE PHONE'S BOTTOM ROW, with the same hottest quota the
 * desktop card carries. The slot is a fifth of a phone wide: the chip holds the
 * figure alone («86%»), and the window and the account move to the door's
 * name and tooltip, which is also what a screen reader hears: the figure is
 * only drawn, so the name has to say it.
 */
export function profileDoor(nome: string | null, pace: unknown, tr: Translate): { title: string; chip: string | null } {
  const base = nome ? tr('sidebar.profileDoorTitleNamed', { nome }) : tr('sidebar.profileDoorTitle');
  const hot = highestQuota(pace, tr);
  if (!hot) return { title: base, chip: null };
  return { title: `${base}. ${hot.title}`, chip: `${hot.pct}%` };
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
