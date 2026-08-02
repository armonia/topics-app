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
import { useSessionActivity, useSubjectLastActivity } from '@/state/signals';
import { useSharedNow } from '@/state/useSharedNow';
import { deriveSubjectTime, formatElapsedShort, formatElapsedCompact, WORK_ELAPSED_AFTER_MS } from '@/state/workLongevity';
import { ON_FILL_TEXT, ON_FILL_TEXT_SOFT, TIER_DONE_BG, TIER_INPUT_BG } from '@/lib/selectionStyles';

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

interface SessionActivityProps {
  /** topicId (chat) or terminalSessionId (terminal) — the subject key. */
  subjectId: string | undefined;
  /** Sitting on an attention fill (amber/blue) → white text for legibility. */
  onFill?: boolean;
  className?: string;
}

export function SessionActivity({ subjectId, onFill, className = '' }: SessionActivityProps) {
  const activity = useSessionActivity(subjectId);
  const lastActivityAt = useSubjectLastActivity(subjectId);
  // Due orologi, per due granularità. Mentre LAVORA il tempo va al secondo, e
  // serve un tick da 1s: sta qui, locale, e parte solo se questa riga sta
  // davvero lavorando. Da FERMA la voce è «finito Xm fa», al minuto: lì basta il
  // tick condiviso da 10s di tutta l'app (UN timer per N righe), che è anche il
  // motivo per cui questa riga non ne apre uno suo.
  const [tick, setTick] = useState(() => Date.now());
  const sharedNow = useSharedNow();
  useEffect(() => {
    if (!activity?.working) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [activity]);

  const now = activity?.working ? tick : sharedNow;
  const time = deriveSubjectTime(activity, lastActivityAt, now);

  if (!activity) return null;

  // UNA sola voce di tempo, e sempre accanto alla descrizione dello stato: è la
  // regola che questa riga fa rispettare. Prima il tempo compariva anche in coda
  // alla riga (lo spinner "labeled" con «agg. Xm fa») e i due numeri dicevano
  // cose diverse — vedi deriveSubjectTime.
  const elapsed = time ? formatElapsedShort(time.ms) : '';
  let text: string;
  if (activity.working) {
    const verb = activity.tool ? toolVerb(activity.tool) : 'Sta lavorando';
    text = elapsed ? `${verb} · ${elapsed}` : verb;
  } else if (activity.tier === 'input') {
    const base = activity.approvalKind ? `Attende: ${activity.approvalKind}` : 'Attende una tua risposta';
    text = elapsed ? `${base} · da ${elapsed}` : base;
  } else {
    // done-unseen — the turn finished and you haven't looked yet.
    text = elapsed ? `Tocca a te · finito ${elapsed} fa` : 'Tocca a te';
  }
  const title = activity.working && time?.approx
    ? `${text}\n(il turno era già in corso all'ultimo riavvio del server: la durata è un minimo)`
    : text;

  // Full-strength inherited colour on a fill (NOT the dimmed soft tone): this is
  // the PRIMARY status line, and 70% white on the blue 'done' fill drops to
  // ~2.5:1. Inheriting at full strength keeps it legible (black on amber / white
  // on blue). Secondary glyphs (timestamp, cloud) keep the soft tone elsewhere.
  const tone = onFill ? ON_FILL_TEXT : 'text-app-text-tertiary';
  return (
    <span
      className={`truncate text-[11px] leading-none tabular-nums ${tone} ${className}`}
      title={title}
    >
      {text}
    </span>
  );
}

/**
 * SessionElapsed — la stessa voce di tempo di SessionActivity, ridotta al solo
 * numero, per le superfici che NON hanno una descrizione dello stato accanto a
 * cui metterla: le tab. Stessa regola (`deriveSubjectTime`), quindi una tab e la
 * riga di sidebar dello stesso soggetto non possono dire due tempi diversi.
 *
 * Si mostra solo dove il numero è un'informazione:
 *   · turno in corso e già lungo (oltre WORK_ELAPSED_AFTER_MS) → «12m»
 *   · turno finito che aspetta te (tier ≠ null)                → «5m»
 * Una tab ferma da tre giorni e già letta non prende nessun orologio: sarebbe
 * rumore su ogni tab aperta, che è esattamente ciò che la richiesta escludeva.
 */
export function SessionElapsed({ subjectId, onFill, className = '' }: SessionActivityProps) {
  const activity = useSessionActivity(subjectId);
  // Gate PRIMA dell'orologio: senza sessione notevole non si sottoscrive il tick
  // condiviso, così N tab inerti non si ri-renderizzano ogni 10s per non
  // mostrare niente.
  if (!activity || (!activity.working && activity.tier === null)) return null;
  return <SessionElapsedTicking subjectId={subjectId} onFill={onFill} className={className} />;
}

function SessionElapsedTicking({ subjectId, onFill, className = '' }: SessionActivityProps) {
  const activity = useSessionActivity(subjectId);
  const lastActivityAt = useSubjectLastActivity(subjectId);
  // Granularità al minuto: qui basta il tick condiviso da 10s. I secondi vivono
  // nella sidebar, dove c'è spazio per la frase intera.
  const now = useSharedNow();
  const time = deriveSubjectTime(activity, lastActivityAt, now);
  if (!time) return null;
  // Un turno appena partito non merita una cifra che balla su una tab stretta.
  if (time.kind === 'working' && time.ms < WORK_ELAPSED_AFTER_MS) return null;
  const label = formatElapsedCompact(time.ms);
  if (!label) return null;
  return (
    <span
      className={`ml-0.5 flex-shrink-0 text-[10px] leading-none tabular-nums ${
        onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-faint/70'
      } ${className}`}
      data-testid="tab-elapsed"
      title={
        time.kind === 'working'
          ? `In esecuzione da ${label}${time.approx ? ' (almeno: il turno era già in corso all\'ultimo riavvio del server)' : ''}`
          : `Ha finito ${label} fa`
      }
    >
      {label}
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
