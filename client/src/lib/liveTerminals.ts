/**
 * I terminali vivi sul Mac, dentro e fuori Topics: il client di
 * `/api/live-terminals` (server/lib/live-terminals.ts) e la forma in cui la
 * tendina in fondo alle tab li mostra.
 */
import { apiFetch } from './shell/net';

export type LiveTerminalSource = 'topics' | 'tmux' | 'terminal';

export interface LiveTerminal {
  id: string;
  source: LiveTerminalSource;
  title: string;
  command: string | null;
  cwd: string | null;
  tty: string | null;
  busy: boolean | null;
  sessionId?: string;
}

export interface LiveTerminalGroup {
  source: LiveTerminalSource;
  rows: LiveTerminal[];
}

/** Topics prima (si apre nella sua tab), poi i terminali fuori, a cui si scrive da qui. */
const SOURCE_ORDER: LiveTerminalSource[] = ['topics', 'terminal', 'tmux'];

/** Un ramo per origine, nell'ordine fisso; un'origine senza terminali non ha ramo. */
export function groupLiveTerminals(rows: LiveTerminal[]): LiveTerminalGroup[] {
  return SOURCE_ORDER
    .map((source) => ({ source, rows: rows.filter((r) => r.source === source) }))
    .filter((g) => g.rows.length > 0);
}

/** Il nome di una riga: il titolo se c'è, poi il programma, poi l'id. */
export function liveTerminalLabel(t: LiveTerminal): string {
  return t.title.trim() || t.command || t.id;
}

/** La riga sotto il nome: programma · cartella. */
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

/** `null` = il terminale non c'è più. */
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
