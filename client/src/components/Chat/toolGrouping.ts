/**
 * Pure grouping logic for runs of consecutive tool calls (CHAT-TOOL-02).
 *
 * A run of settled calls collapses into ONE summary row with per-tool counts
 * ("Read ×5 · Edit ×3 · Bash ×4") — the drill-down re-uses the existing
 * per-call <ToolCallRow>. Kept free of React so it unit-tests under bun:test.
 */

import type { ToolCall } from '../../types';
import { resolveToolDetail, buildToolDisplayLabel } from './toolDetail';
import { formatTokens as sharedFormatTokens } from '../../lib/formatTokens';
import { isAwaitingHuman } from '../../../../shared/types';

/** Runs shorter than this render as plain per-call rows (no group chrome). */
export const GROUP_MIN = 3;

export type ToolGroupSegment =
  | { kind: 'aggregate'; tools: ToolCall[] }
  | { kind: 'solo'; tool: ToolCall };

/**
 * Calls that must NEVER fold into an aggregate:
 *  - `waiting_for_input` — the inline form is the row's whole reason to exist;
 *  - sub-agents (Task) — the live action log is the primary signal.
 * Errors stay IN the aggregate; the summary surfaces their count instead.
 */
export function isSoloTool(tc: ToolCall): boolean {
  if (isAwaitingHuman(tc.status)) return true;
  return resolveToolDetail(tc).type === 'sub_agent';
}

/** A call the agent is still on (spinner territory). */
export function isActiveTool(tc: ToolCall): boolean {
  const status = tc.status ?? 'pending';
  return status === 'pending' || status === 'running';
}

/** Split a consecutive run into aggregatable stretches and solo rows, in order. */
export function partitionToolGroup(tools: ToolCall[]): ToolGroupSegment[] {
  const segments: ToolGroupSegment[] = [];
  for (const tc of tools) {
    if (isSoloTool(tc)) {
      segments.push({ kind: 'solo', tool: tc });
      continue;
    }
    const last = segments[segments.length - 1];
    if (last && last.kind === 'aggregate') last.tools.push(tc);
    else segments.push({ kind: 'aggregate', tools: [tc] });
  }
  return segments;
}

export interface ToolGroupSummary {
  total: number;
  /** Canonical display names (Read/Edit/Shell/…) with occurrence counts,
   *  sorted by count desc then name. */
  counts: Array<{ name: string; count: number }>;
  errors: number;
  /** pending + running */
  running: number;
  /** Wall-clock span of the run — first startedAt → last endedAt — when both
   *  bounds exist. Absent for legacy rows without timestamps. */
  durationMs?: number;
  /** Quando è cominciata la corsa. Serve al gruppo ANCORA VIVO, che di durata
   *  non ne ha una (manca l'ultimo `endedAt`) e restava senza nessun numero
   *  mentre una riga singola in corso il suo cronometro ce l'ha: il momento in
   *  cui si vorrebbe sapere da quanto va avanti è proprio quello. */
  startedAt?: number;
  /** Somma del costo delle azioni del gruppo, in centesimi. Presente solo se
   *  almeno una riga porta un costo (messaggi vecchi non ne hanno). */
  costCents?: number;
  /** Somma dei token attribuiti, fallback quando il prezzo manca. */
  tokens?: number;
}

export function summarizeToolGroup(tools: ToolCall[]): ToolGroupSummary {
  const byName = new Map<string, number>();
  let errors = 0;
  let running = 0;
  let firstStart: number | undefined;
  let lastEnd: number | undefined;
  let costCents: number | undefined;
  let tokens: number | undefined;
  for (const tc of tools) {
    const name = buildToolDisplayLabel(resolveToolDetail(tc), tc.name).name;
    byName.set(name, (byName.get(name) ?? 0) + 1);
    if (tc.status === 'error') errors++;
    else if (isActiveTool(tc)) running++;
    if (typeof tc.startedAt === 'number') {
      firstStart = firstStart === undefined ? tc.startedAt : Math.min(firstStart, tc.startedAt);
    }
    if (typeof tc.endedAt === 'number') {
      lastEnd = lastEnd === undefined ? tc.endedAt : Math.max(lastEnd, tc.endedAt);
    }
    // Somma i costi/token delle azioni: il gruppo mostra il totale della sua
    // parte del turno, non la ripete riga per riga.
    if (typeof tc.costCents === 'number') costCents = (costCents ?? 0) + tc.costCents;
    if (typeof tc.tokens === 'number') tokens = (tokens ?? 0) + tc.tokens;
  }
  const counts = [...byName.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const durationMs =
    firstStart !== undefined && lastEnd !== undefined && lastEnd >= firstStart
      ? lastEnd - firstStart
      : undefined;
  return {
    total: tools.length,
    counts,
    errors,
    running,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(firstStart !== undefined ? { startedAt: firstStart } : {}),
    ...(costCents !== undefined ? { costCents } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
  };
}

/**
 * La corsa è fallita per INTERO: nessuna azione si è salvata.
 *
 * È l'unica condizione che autorizza il rosso sul titolo del gruppo. Prima
 * bastava `errors > 0`: una `Read` andata male su cinque tingeva di rosso la
 * riga intera, e il colore diceva «qui non è successo niente di buono» dove
 * quattro azioni su cinque erano invece riuscite. Quanti fallimenti ci sono
 * stati lo dice già il badge accanto al titolo, con il numero; il colore è
 * l'ultimo gradino, e si accende solo quando non c'è più niente da salvare.
 *
 * Un gruppo vuoto non è «tutto fallito»: senza azioni non c'è esito.
 */
export function isWhollyFailed(summary: Pick<ToolGroupSummary, 'errors' | 'total'>): boolean {
  return summary.total > 0 && summary.errors === summary.total;
}

/** Costo in centesimi → stringa breve per la riga del tool: `$0.0012` sotto un
 *  dollaro (quattro decimali, un'azione costa poco), `$1.20` sopra. Torna ''
 *  per zero/non-finito così il chiamante può ometterlo. */
export function formatCostCents(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return '';
  const usd = cents / 100;
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/** Token → stringa compatta: `1.2k`, `340`, `1.5M`. Il fallback quando il
 *  prezzo del modello non è noto. */
export function formatTokensCompact(tokens: number): string {
  // Variante compatta: il vuoto (non "0") quando non c'e' niente da mostrare,
  // e un decimale solo sotto i 10k. Il resto — incluso il confine con i
  // milioni, che qui stampava "1000k" a 999.600 — e' lib/formatTokens.
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  return sharedFormatTokens(tokens, { decimals: tokens < 10_000 ? 1 : 0, millionDecimals: 1 });
}

/** "Read ×5 · Edit ×3" — the counts joined for the summary header. */
export function formatToolCounts(counts: ToolGroupSummary['counts']): string {
  return counts.map((c) => (c.count > 1 ? `${c.name} ×${c.count}` : c.name)).join(' · ');
}

/** Human duration: "0.8s" under 10s, "41s" under a minute, "1m 05s" under an
 *  hour, "1h 02m" above (seconds dropped at the hour scale). */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalS = Math.round(ms / 1000);
  if (totalS < 60) return `${totalS}s`;
  const totalM = Math.floor(totalS / 60);
  if (totalM < 60) return `${totalM}m ${String(totalS % 60).padStart(2, '0')}s`;
  const h = Math.floor(totalM / 60);
  return `${h}h ${String(totalM % 60).padStart(2, '0')}m`;
}
