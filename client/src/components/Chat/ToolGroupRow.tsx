import { memo, useMemo, useState } from 'react';
import { useT } from '@/hooks/useT';
import { ChevronDown, ChevronRight, Loader2, X, Workflow } from 'lucide-react';
import type { ToolCall } from '../../types';
import { ToolCallRow, ElapsedTimer } from './ToolCallRow';
import { useSettledMetricClass } from './settledMetrics';
import {
  GROUP_MIN,
  formatCostCents,
  formatDurationMs,
  formatTokensCompact,
  formatToolCounts,
  isActiveTool,
  isWhollyFailed,
  partitionToolGroup,
  summarizeToolGroup,
} from './toolGrouping';

/**
 * One collapsed summary row for a run of ≥GROUP_MIN consecutive tool calls
 * (CHAT-TOOL-02) — "N azioni · Read ×5 · Edit ×3 · 41s", click to expand
 * into the classic per-call <ToolCallRow> stack.
 *
 * While the run is still LIVE (some call pending/running) the container stays
 * mounted and shows the summary of settled work PLUS the active call(s) with
 * their auto-open body — one persistent "hot" panel that hands off from tool
 * to tool instead of N rows flashing open and closed. On settle it collapses
 * to the single summary row.
 */
function ToolGroupRow({ tools, sessionKey, messageId, onPlanDecision }: { tools: ToolCall[]; sessionKey?: string; messageId?: string; onPlanDecision?: (approved: boolean) => void }) {
  const tr = useT();
  const settledMetricClass = useSettledMetricClass('toolgroup');
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarizeToolGroup(tools), [tools]);
  const live = summary.running > 0;
  const whollyFailed = isWhollyFailed(summary);
  const settledCount = summary.total - summary.running;
  // Costo del gruppo: prezzo se noto, altrimenti i token sommati.
  const groupCost = typeof summary.costCents === 'number'
    ? formatCostCents(summary.costCents)
    : typeof summary.tokens === 'number' && summary.tokens > 0
      ? `${formatTokensCompact(summary.tokens)} tok`
      : '';

  // Il corpo è aperto anche mentre la corsa è VIVA: lì mostra le azioni in
  // corso, ed è il pannello caldo che passa di tool in tool. Il chevron deve
  // dire QUESTO, non lo stato di `open`: puntato a destra su un corpo aperto
  // era semplicemente falso, e il click sembrava non fare niente. Aperto, il
  // click continua a scegliere fra tutte le azioni e le sole attive.
  const expanded = open || live;

  return (
    <div data-testid="tool-group-row" data-group-id={tools[0]?.id} className="text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group/toolgroup w-full py-1 text-left text-app-text-secondary hover:text-app-text transition-colors"
        data-testid="tool-group-summary"
      >
        <span className="flex items-center gap-2">
          <span data-testid="tool-group-chevron" data-open={expanded ? 'true' : 'false'} className="flex-shrink-0 inline-flex">
            {expanded ? (
              <ChevronDown size={12} className="text-app-text-muted" />
            ) : (
              <ChevronRight size={12} className="text-app-text-muted" />
            )}
          </span>
          {/* `Workflow` e non un lampo: questa riga dice «una corsa di N
              azioni», non «veloce». Il lampo in questa app ha un significato
              solo — velocità — ed è del Fast Mode, che sta nel composer sotto
              questa stessa colonna. */}
          <Workflow size={13} className={`flex-shrink-0 ${live ? 'text-primary' : 'text-app-text-muted'}`} />
          {/* Il titolo conta le azioni, e il suo colore dice l'esito della
              CORSA, non l'esistenza di un incidente: rosso solo se non se ne
              è salvata nemmeno una (`isWhollyFailed`). Con `errors > 0` una
              fallita su cinque tingeva tutto, e il colore mentiva sulle
              quattro riuscite. Quante ne sono cadute lo dice il badge qui
              accanto, con il numero. */}
          <span
            data-testid="tool-group-title"
            className={`flex-shrink-0 font-medium ${live ? 'text-primary' : whollyFailed ? 'text-red-500' : 'text-app-text'}`}
          >
            {live
              ? `${settledCount}/${summary.total} azioni`
              : `${summary.total} azioni`}
          </span>
          {/* L'esito si dice SOLO quando è cattivo, e si dice qui, accanto al
              nome del gruppo — una volta sola, con il numero. Prima la ✗ era
              disegnata due volte (qui e a destra) e la spunta verde stava su
              ogni gruppo riuscito, cioè su quasi tutti: confermava la norma. */}
          {summary.errors > 0 && (
            <span
              data-testid="tool-group-errors"
              className="flex-shrink-0 inline-flex items-center gap-0.5 text-[11px] tabular-nums text-red-500"
            >
              <X size={11} /> {summary.errors} {summary.errors === 1 ? 'fallita' : 'fallite'}
            </span>
          )}
          <span className="min-w-0 flex-1 text-[11px] text-app-text-muted truncate">
            {formatToolCounts(summary.counts)}
          </span>
          {/* La colonna di destra è ormai di soli NUMERI: durata e costo, che si
              allineano a destra riga per riga. */}
          <span className="flex-shrink-0 inline-flex items-center justify-end gap-1.5">
            {/* Viva: da quanto va avanti. Finita: quanto ci ha messo. Prima, un
                gruppo in corso non mostrava NESSUN numero — mentre una riga
                singola in corso il suo cronometro ce l'ha sempre avuto. */}
            {live && summary.startedAt !== undefined && (
              <ElapsedTimer since={summary.startedAt} title={tr('toolgroup.elapsed')} />
            )}
            {summary.durationMs !== undefined && !live && (
              <span className={`text-[10px] tabular-nums text-app-text-muted ${settledMetricClass}`} data-testid="tool-group-duration">
                {formatDurationMs(summary.durationMs)}
              </span>
            )}
            {/* Costo sommato delle azioni del gruppo — la sua parte del turno. */}
            {groupCost && (
              <span className={`text-[10px] tabular-nums text-app-text-muted ${settledMetricClass}`} data-testid="tool-group-cost" title={tr('toolgroup.cost')}>
                {groupCost}
              </span>
            )}
            {/* Qui resta solo ciò che è VIVO. L'esito sta accanto al nome. */}
            {live && <Loader2 size={11} className="animate-spin text-primary" />}
          </span>
        </span>
      </button>
      {expanded && (
        // Rientro + filo a sinistra: è la timeline verticale che il commento di
        // MessageContent promette da sempre («connected by a left border line»)
        // e che non c'era. Senza, le azioni del gruppo stavano sulla stessa
        // colonna della riga che le contiene, e la gerarchia spariva.
        <div className="ml-[9px] pl-3 border-l border-app-border/50 space-y-px">
          {(open ? tools : tools.filter(isActiveTool)).map((tc) => (
            <ToolCallRow key={tc.id} toolCall={tc} sessionKey={sessionKey} messageId={messageId} onPlanDecision={onPlanDecision} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Renderer for one consecutive run of tool calls: partitions it into
 * aggregatable stretches and never-aggregated solos (waiting_for_input,
 * sub-agents), applies the GROUP_MIN threshold, and falls back to the plain
 * per-call rows below it. This is the single entry MessageContent (blocks
 * timeline + legacy bucket) uses for tool runs.
 */
export const GroupedToolRows = memo(function GroupedToolRows({ tools, sessionKey, messageId, onPlanDecision }: { tools: ToolCall[]; sessionKey?: string; messageId?: string; onPlanDecision?: (approved: boolean) => void }) {
  const segments = useMemo(() => partitionToolGroup(tools), [tools]);
  return (
    <>
      {segments.map((seg) =>
        seg.kind === 'solo' ? (
          <ToolCallRow key={seg.tool.id} toolCall={seg.tool} sessionKey={sessionKey} messageId={messageId} onPlanDecision={onPlanDecision} />
        ) : seg.tools.length >= GROUP_MIN ? (
          <ToolGroupRow key={`grp-${seg.tools[0].id}`} tools={seg.tools} sessionKey={sessionKey} messageId={messageId} onPlanDecision={onPlanDecision} />
        ) : (
          seg.tools.map((tc) => <ToolCallRow key={tc.id} toolCall={tc} sessionKey={sessionKey} messageId={messageId} onPlanDecision={onPlanDecision} />)
        ),
      )}
    </>
  );
});
