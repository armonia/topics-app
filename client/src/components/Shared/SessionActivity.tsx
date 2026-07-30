/**
 * SessionActivity — the "what is this Claude session doing right now" label.
 *
 * Reads the compact SessionActivitySignal the signals store derives from the
 * live session state (see deriveSessionActivity) and renders a single-line
 * status: the running tool as a friendly verb + a live elapsed counter while
 * working, or the awaiting reason when parked for the user. Renders NOTHING when
 * the session is idle, so it's safe to drop into any row/header — it only shows
 * up when there's something to say.
 *
 * Two consumers: the sidebar rows (desktop + the full-screen mobile sidebar) and
 * the mobile chat header, so "what it's doing" reads the same everywhere.
 */
import { useEffect, useState } from 'react';
import { useSessionActivity } from '@/state/signals';
import { ON_FILL_TEXT, TIER_DONE_BG, TIER_INPUT_BG } from '@/lib/selectionStyles';

/** Map a Claude Code tool name to a short human verb. Unknown tools fall back to
 *  the raw name (MCP tools like `mcp__foo__bar` are trimmed to their last leg). */
function toolVerb(tool: string): string {
  switch (tool) {
    case 'Bash': return 'Esegue un comando';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': return 'Scrive codice';
    case 'Read': return 'Legge un file';
    case 'Grep':
    case 'Glob': return 'Cerca nel codice';
    case 'WebFetch':
    case 'WebSearch': return 'Naviga il web';
    case 'Task': return 'Coordina un agente';
    case 'TodoWrite': return 'Aggiorna il piano';
    default: {
      if (tool.startsWith('mcp__')) {
        const leg = tool.split('__').pop();
        return leg ? `Usa ${leg}` : 'Usa uno strumento';
      }
      return tool;
    }
  }
}

/** Compact elapsed: "3s", "2m", "1h". */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

interface SessionActivityProps {
  /** topicId (chat) or terminalSessionId (terminal) — the subject key. */
  subjectId: string | undefined;
  /** Sitting on an attention fill (amber/blue) → white text for legibility. */
  onFill?: boolean;
  className?: string;
}

export function SessionActivity({ subjectId, onFill, className = '' }: SessionActivityProps) {
  const activity = useSessionActivity(subjectId);
  // Live elapsed tick — only while there's an active/awaiting session mounted
  // here (the component returns null otherwise, so no timer runs when idle).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Only tick while WORKING — `now` is read solely by the elapsed counter in
    // the working branch. Parked (awaiting) labels are static text, so ticking
    // them once a second would re-render for zero visual change.
    if (!activity?.working) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [activity]);

  if (!activity) return null;

  let text: string;
  if (activity.working) {
    const verb = activity.tool ? toolVerb(activity.tool) : 'Sta lavorando';
    text = `${verb} · ${fmtElapsed(now - activity.since)}`;
  } else if (activity.tier === 'input') {
    text = activity.approvalKind ? `Attende: ${activity.approvalKind}` : 'Attende una tua risposta';
  } else {
    // done-unseen — the turn finished and you haven't looked yet.
    text = 'Tocca a te';
  }

  // Full-strength inherited colour on a fill (NOT the dimmed soft tone): this is
  // the PRIMARY status line, and 70% white on the blue 'done' fill drops to
  // ~2.5:1. Inheriting at full strength keeps it legible (black on amber / white
  // on blue). Secondary glyphs (timestamp, cloud) keep the soft tone elsewhere.
  const tone = onFill ? ON_FILL_TEXT : 'text-app-text-tertiary';
  return (
    <span
      className={`truncate text-[11px] leading-none tabular-nums ${tone} ${className}`}
      title={text}
    >
      {text}
    </span>
  );
}

/**
 * SessionActivityBar — a full-width status strip: a colour-coded state dot
 * (green working / amber awaiting-input / blue done) + the SessionActivity text.
 * Used at the top of the mobile chat view so "what is this session doing" is
 * front-and-centre on the small screen, not only in the sidebar list. Renders
 * nothing when the session is idle.
 */
export function SessionActivityBar({ subjectId, className = '' }: { subjectId: string | undefined; className?: string }) {
  const activity = useSessionActivity(subjectId);
  if (!activity) return null;
  // Il blu qui era `bg-sky-500`, cioè una tinta DIVERSA da quella dei fill di
  // tab e riga: due superfici che dicono la stessa cosa con due blu. Ora vengono
  // entrambe dai token in selectionStyles.
  const dot = activity.working
    ? 'bg-emerald-500'
    : activity.tier === 'input'
      ? TIER_INPUT_BG
      : TIER_DONE_BG;
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 border-b border-app-border bg-surface flex-shrink-0 ${className}`}>
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot} ${activity.working || activity.tier === 'input' ? 'animate-pulse' : ''}`} />
      <SessionActivity subjectId={subjectId} className="!text-[12px]" />
    </div>
  );
}
