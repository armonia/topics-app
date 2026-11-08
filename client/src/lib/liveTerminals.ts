/**
 * Live terminals on the Mac, inside and outside Topics: the client for
 * `/api/live-terminals` (server/lib/live-terminals.ts) and the shape the
 * menu at the end of the tabs renders.
 */
import { apiFetch } from './shell/net';

import type { LiveTerminal, LiveTerminalSource } from '../../../shared/live-terminals';
export type { LiveTerminal, LiveTerminalSource };

export interface LiveTerminalGroup {
  source: LiveTerminalSource;
  rows: LiveTerminal[];
}

/** Topics first (opens in its tab), then outside terminals, written from here. */
const SOURCE_ORDER: LiveTerminalSource[] = ['topics', 'terminal', 'tmux'];

/** One branch per origin, in fixed order; an origin holding zero terminals gets no branch. */
export function groupLiveTerminals(rows: LiveTerminal[]): LiveTerminalGroup[] {
  return SOURCE_ORDER
    .map((source) => ({ source, rows: rows.filter((r) => r.source === source) }))
    .filter((g) => g.rows.length > 0);
}

/** A row title: title when set, then program, then id. */
export function liveTerminalLabel(t: LiveTerminal): string {
  return t.title.trim() || t.command || t.id;
}

/** The line under the title: program · folder. */
export function liveTerminalDetail(t: LiveTerminal): string {
  const dir = t.cwd ? t.cwd.split('/').filter(Boolean).pop() ?? '/' : '';
  return [t.command, dir].filter(Boolean).join(' · ');
}

export async function fetchLiveTerminals(): Promise<LiveTerminal[]> {
  const res = await apiFetch('/api/live-terminals');
  if (!res.ok) throw new Error(`live-terminals ${res.status}`);
  const body = (await res.json()) as { terminals?: LiveTerminal[] };
  return Array.isArray(body.terminals) ? body.terminals : [];
}

/** `null` = the terminal went away. */
export async function fetchLiveTerminalScreen(id: string): Promise<string | null> {
  const res = await apiFetch(`/api/live-terminals/${encodeURIComponent(id)}/screen`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`live-terminals screen ${res.status}`);
  const body = (await res.json()) as { text?: string };
  return body.text ?? '';
}

export async function sendToLiveTerminal(id: string, text: string, enter = true): Promise<boolean> {
  const res = await apiFetch(`/api/live-terminals/${encodeURIComponent(id)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, enter }),
  });
  return res.ok;
}
