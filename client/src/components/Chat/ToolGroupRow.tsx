import { memo, useContext, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { useT } from '../../hooks/useT';
import { ChevronDown, ChevronRight, Loader2, X, Workflow } from 'lucide-react';
import type { ToolCall } from '../../types';
import type { PlanDecisionHandler } from './planDetection';
import { ToolCallRow, ElapsedTimer } from './ToolCallRow';
import { BrowserOpenMarker } from './BrowserOpenMarker';
import { useSettledMetricClass } from './settledMetrics';
import { useDisclosureToggle } from './transcriptDisclosure';
import { DisclosureBody } from './DisclosureBody';
import { TranscriptRowResizeContext } from './transcriptRowResize';
import { useFindFocusToolIn } from '../../state/chatFindFocus';
import {
  GROUP_MIN,
  firstFailedTool,
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
function ToolGroupRow({ tools, sessionKey, messageId, onPlanDecision }: { tools: ToolCall[]; sessionKey?: string; messageId?: string; onPlanDecision?: PlanDecisionHandler }) {
  const tr = useT();
  const settledMetricClass = useSettledMetricClass('toolgroup');
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarizeToolGroup(tools), [tools]);
  const firstFailure = useMemo(() => (summary.errors > 0 ? firstFailedTool(tools) : null), [summary.errors, tools]);
  // The failed row the badge opened the group on: ringed and scrolled into
  // view, then the ring fades by itself (it is a "here it is", not a state).
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusId) return;
    const t = setTimeout(() => setFocusId(null), 2400);
    return () => clearTimeout(t);
  }, [focusId]);
  // The chat find bar landed inside one of these calls (CHAT-FIND-02): the
  // group opens on that edge and stays open; the call itself opens through
  // its own subscription.
  const toolIds = useMemo(() => tools.map((t) => t.id), [tools]);
  const findFocus = useFindFocusToolIn(toolIds);
  const [seenFindSeq, setSeenFindSeq] = useState(0);
  if (findFocus.seq !== 0 && findFocus.seq !== seenFindSeq) {
    setSeenFindSeq(findFocus.seq);
    setOpen(true);
  }
  // Live while any call is unsettled, queued ones included: the run is not
  // over. Its stopwatch counts from the first call that really started.
  const live = summary.running + summary.queued > 0;
  const whollyFailed = isWhollyFailed(summary);
  const settledCount = summary.total - summary.running - summary.queued;
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

  // A click on the row holds it where it is while the body unrolls under it
  // (`transcriptDisclosure.ts`). The failure badge does not: it is a jump to
  // the failed row, and that row is scrolled into view on purpose.
  const disclose = useDisclosureToggle();
  const onRowResize = useContext(TranscriptRowResizeContext);
  const toggle = (e: MouseEvent<HTMLElement>) => {
    disclose(e.currentTarget);
    setOpen((v) => !v);
  };

  return (
    <div data-testid="tool-group-row" data-group-id={tools[0]?.id} className="text-compact">
      {/* The summary is no longer one big button: the failure badge inside it
          is a command of its own, and a button inside a button is invalid
          HTML. A click anywhere on the row still toggles (it bubbles up to
          here); the keyboard uses the real toggle button. */}
      <div
        onClick={toggle}
        className="group/toolgroup w-full py-0.5 text-left text-app-text-secondary hover:text-app-text transition-colors cursor-pointer coarse:py-0"
        data-testid="tool-group-summary"
      >
        <span className="flex items-center gap-2">
          <button
            type="button"
            data-testid="tool-group-toggle"
            aria-expanded={expanded}
            // 24 tall with the mouse, 44 under a finger (WCAG 2.5.8 and the
            // phone floor; usability audit 04/10 measured 20). The row's own
            // padding shrank by the same amount, so the transcript keeps its
            // rhythm on desktop.
            className="flex-shrink-0 inline-flex min-h-6 items-center gap-2 text-left coarse:min-h-11"
          >
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
          </button>
          {/* L'esito si dice SOLO quando è cattivo, e si dice qui, accanto al
              nome del gruppo — una volta sola, con il numero. Prima la ✗ era
              disegnata due volte (qui e a destra) e la spunta verde stava su
              ogni gruppo riuscito, cioè su quasi tutti: confermava la norma. */}
          {/* A BUTTON: with the group closed the error was buried, and finding
              it meant opening the group and hunting among N rows. The click
              opens the group on the first failure; the title quotes the first
              line of its error. */}
          {summary.errors > 0 && (
            <button
              type="button"
              data-testid="tool-group-errors"
              title={firstFailure?.firstLine || tr('toolgroup.jumpToFailure')}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(true);
                if (firstFailure) setFocusId(firstFailure.id);
              }}
              className="flex-shrink-0 inline-flex items-center gap-0.5 text-mini tabular-nums text-red-500 rounded px-0.5 -mx-0.5 hover:bg-red-500/10 hover:underline"
            >
              <X size={11} /> {summary.errors} {summary.errors === 1 ? 'fallita' : 'fallite'}
            </button>
          )}
          <span className="min-w-0 flex-1 text-mini text-app-text-muted truncate">
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
              <span className={`text-mini tabular-nums text-app-text-muted ${settledMetricClass}`} data-testid="tool-group-duration">
                {formatDurationMs(summary.durationMs)}
              </span>
            )}
            {/* Costo sommato delle azioni del gruppo — la sua parte del turno. */}
            {groupCost && (
              <span className={`text-mini tabular-nums text-app-text-muted ${settledMetricClass}`} data-testid="tool-group-cost" title={tr('toolgroup.cost')}>
                {groupCost}
              </span>
            )}
            {/* Qui resta solo ciò che è VIVO. L'esito sta accanto al nome. */}
            {live && <Loader2 size={11} className="animate-spin text-primary" />}
          </span>
        </span>
      </div>
      {/* Rientro + filo a sinistra: è la timeline verticale che il commento di
          MessageContent promette da sempre («connected by a left border line»)
          e che non c'era. Senza, le azioni del gruppo stavano sulla stessa
          colonna della riga che le contiene, e la gerarchia spariva. */}
      <DisclosureBody open={expanded} className="ml-[9px] pl-3 border-l border-app-border/50 space-y-px" onMotion={onRowResize ?? undefined}>
        {(open ? tools : tools.filter(isActiveTool)).map((tc) => (
          <ToolCallRow key={tc.id} toolCall={tc} sessionKey={sessionKey} messageId={messageId} onPlanDecision={onPlanDecision} highlighted={tc.id === focusId} />
        ))}
      </DisclosureBody>
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
export const GroupedToolRows = memo(function GroupedToolRows({ tools, sessionKey, messageId, onPlanDecision }: { tools: ToolCall[]; sessionKey?: string; messageId?: string; onPlanDecision?: PlanDecisionHandler }) {
  const segments = useMemo(() => partitionToolGroup(tools), [tools]);
  return (
    <>
      {segments.map((seg) =>
        seg.kind === 'browser' ? (
          <BrowserOpenMarker key={`br-${seg.marker.id}`} marker={seg.marker} />
        ) : seg.kind === 'solo' ? (
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
