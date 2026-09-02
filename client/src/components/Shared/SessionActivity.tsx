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
// Import RELATIVI e non `@/`: `bun test` non risolve l'alias (lo dice anche
// l'intestazione di `Board/GlobalCapControl.test.tsx`), e questo modulo ha un
// test unitario che lo monta — `SessionActivity.test.ts`.
import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useSessionActivity, useSubjectLastActivity, useProjectWorkStart } from '../../state/signals';
import { useSharedNow } from '../../state/useSharedNow';
import { deriveSubjectTime, formatElapsedShort, formatElapsedCompact, WORK_ELAPSED_AFTER_MS } from '../../state/workLongevity';
import { useTopicPreview } from '../../state/topicPreviews';
import { timeToneClass, timeVoice } from './timeTone';
import { ON_FILL_TEXT, ON_FILL_TEXT_SOFT, TIER_DONE_BG, TIER_INPUT_BG } from '../../lib/selectionStyles';

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
  // Gate PRIMA di qualunque orologio. `deriveSessionActivity` scarta le sessioni
  // idle, quindi la maggior parte delle righe di sidebar arriva qui e rende
  // `null` — e se l'orologio si sottoscrivesse comunque, quelle righe si
  // ri-renderizzerebbero ogni 10 secondi per non mostrare niente. È la
  // regressione che `useSharedNow` avverte di evitare, in tutte lettere.
  const activity = useSessionActivity(subjectId);
  if (!activity) return null;
  return <SessionActivityText subjectId={subjectId} onFill={onFill} className={className} />;
}

function SessionActivityText({ subjectId, onFill, className = '' }: SessionActivityProps) {
  const activity = useSessionActivity(subjectId);
  const lastActivityAt = useSubjectLastActivity(subjectId);
  // Due orologi, per due granularità. Mentre LAVORA il tempo va al secondo, e
  // serve un tick da 1s: sta qui, locale, e parte solo se questa riga sta
  // davvero lavorando. Da FERMA la voce è «finito Xm fa», al minuto: lì basta il
  // tick condiviso da 10s di tutta l'app (UN timer per N righe), che è anche il
  // motivo per cui questa riga non ne apre uno suo.
  const [tick, setTick] = useState(() => Date.now());
  const sharedNow = useSharedNow();
  // LA DIPENDENZA È IL BOOLEANO, non l'oggetto. `useSessionActivity` passa da
  // `useShallow`: il descrittore è ri-identificato a ogni cambio di campo, e il
  // campo che cambia più spesso è `tool`. Con `[activity]` l'effetto si
  // smontava e rimontava a ogni cambio di strumento, quindi l'intervallo da 1s
  // veniva azzerato PRIMA di scattare: un agente che cambia tool più di una
  // volta al secondo — cioè il caso normale — lasciava il contatore inchiodato
  // sul valore iniziale. Il gemello a fondo file (`SessionElapsedTicking`) non
  // ne soffriva perché legge il tick condiviso.
  const working = activity?.working ?? false;
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);

  // Il PIÙ RECENTE dei due campioni, non il locale e basta. Sono due letture
  // dello stesso orologio, quindi il massimo è sempre quello buono — e serve
  // perché `tick` nasce col `Date.now()` del MOUNT: una riga rimasta ferma
  // mezz'ora prima di mettersi a lavorare lo avrebbe vecchio di mezz'ora, e per
  // un secondo (fino al primo scatto dell'intervallo) mostrerebbe il numero
  // sbagliato. `sharedNow` si ri-basa a ogni nuovo iscritto e batte ogni 10s,
  // quindi lo scarto scende da «illimitato» a «al più un tick condiviso». Non
  // si può ri-basare `tick` all'armo dell'effetto: `Date.now()` nel corpo di un
  // render è impuro e un `setState` sincrono in un effetto innesca render a
  // cascata — entrambi sono errori del linter, ed entrambe le regole hanno
  // ragione.
  const now = activity?.working ? Math.max(tick, sharedNow) : sharedNow;
  const time = deriveSubjectTime(activity, lastActivityAt, now);

  if (!activity) return null;

  // UNA sola voce di tempo, e sempre accanto alla descrizione dello stato: è la
  // regola che questa riga fa rispettare. Prima il tempo compariva anche in coda
  // alla riga (lo spinner "labeled" con «agg. Xm fa») e i due numeri dicevano
  // cose diverse — vedi deriveSubjectTime.
  const elapsed = time ? formatElapsedShort(time.ms) : '';
  // The sentence is split around the NUMBER, because the number is the only
  // part with a tone of its own (see timeTone): a duration that is still
  // growing wears the loader's colour and the loader's motion, a duration that
  // has stopped does not. `text` stays whole for the tooltip.
  let lead: string;
  let trail = '';
  if (activity.working) {
    const verb = activity.tool ? toolVerb(activity.tool) : 'Sta lavorando';
    lead = elapsed ? `${verb} · ` : verb;
  } else if (activity.tier === 'input') {
    const base = activity.approvalKind ? `Attende: ${activity.approvalKind}` : 'Attende una tua risposta';
    lead = elapsed ? `${base} · da ` : base;
  } else {
    // done-unseen — the turn finished and you haven't looked yet.
    lead = elapsed ? 'Tocca a te · finito ' : 'Tocca a te';
    trail = elapsed ? ' fa' : '';
  }
  const text = `${lead}${elapsed}${trail}`;
  const timeClass = timeToneClass(timeVoice(activity.working, activity.tier === 'input'), onFill);
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
      className={`truncate-tight text-[11px] tabular-nums ${tone} ${className}`}
      title={title}
    >
      {lead}
      {elapsed ? <span className={timeClass ?? ''} data-testid="activity-elapsed">{elapsed}</span> : null}
      {trail}
    </span>
  );
}

/**
 * TopicSubline — la riga sotto il nome di una chat, che deve dire SEMPRE
 * qualcosa.
 *
 * Sotto al nome c'è UNA riga da 11px, e finora la riempiva solo
 * `SessionActivity` — che rende `null` appena la sessione è ferma
 * (`starting/completed/error/dormant`, o nessuno `ClaudeSessionState` affatto),
 * cioè quasi sempre. Una chat a riposo non diceva niente: per sapere di cosa
 * parlasse bisognava aprirla. Le due voci non convivono, si ALTERNANO — c'è
 * spazio per una riga sola:
 *   · sessione viva  → lo stato live, com'era.
 *   · sessione ferma → l'ultimo messaggio, potato (vedi state/topicPreviews).
 *
 * Il gate resta a costo zero per le righe mute, com'era: `useSessionActivity` è
 * una lettura dello store dei segnali, non un orologio, e l'anteprima si
 * sottoscrive PER TOPIC — una riga si sveglia solo per il proprio messaggio, mai
 * per quello di un'altra chat. È la regressione contro cui avverte il commento
 * in cima a `SessionActivity`, e vale per entrambi i rami.
 */
export function TopicSubline({ topicId, onFill, className = '' }: {
  topicId: string | undefined;
  onFill?: boolean;
  className?: string;
}) {
  const activity = useSessionActivity(topicId);
  if (activity) return <SessionActivityText subjectId={topicId} onFill={onFill} className={className} />;
  return <TopicPreviewLine topicId={topicId} onFill={onFill} className={className} />;
}

function TopicPreviewLine({ topicId, onFill, className = '' }: {
  topicId: string | undefined;
  onFill?: boolean;
  className?: string;
}) {
  const preview = useTopicPreview(topicId);
  // NIENTE DA DIRE ≠ NIENTE SPAZIO. Rendendo `null` il blocco nome+subline si
  // accorciava da 31px a 17, e il nome si ri-centrava: al boot ogni riga della
  // sidebar muoveva il proprio nome di 7px nell'istante in cui l'anteprima
  // atterrava — un layout che dipendeva dall'arrivo di un dato. La riga da 11px
  // ora c'è sempre, piena o vuota: l'altezza è la stessa prima e dopo.
  // (Con la copia locale delle anteprime questo caso resta solo al PRIMO avvio
  // vero, quando non c'è ancora niente in cache — vedi state/topicPreviews.)
  // The empty line is as tall as a full one: `truncate-tight` rounds its line
  // box up to an even number of pixels (12 at 11px, see `index.css`), and its
  // negative margin gives back the padding, so a subline that SAYS something
  // occupies exactly 12px of margin box. A placeholder of any other height
  // would move the name above it by the difference, which is the very jump the
  // paragraph above exists to prevent.
  if (!preview) return <span aria-hidden="true" className="block h-3" />;
  // Il marcatore dei messaggi TUOI. Senza, un «ok, procedi» sotto al nome si
  // legge come una risposta dell'agente, ed è il contrario: è la convenzione
  // delle app di messaggistica («Tu: …»), due lettere e i due punti. Non
  // un'icona — su una riga da 11px un glifo in più è rumore — e non un colore,
  // perché il colore da solo non dice chi ha parlato.
  const tone = onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary';
  return (
    <span
      className={`truncate-tight text-[11px] ${tone} ${className}`}
      title={preview.text}
      // Ancora per l'e2e: il testo dell'anteprima è quello dell'ultimo
      // messaggio, quindi non è cercabile per stringa senza inseguire il seed.
      data-testid="topic-preview"
    >
      {preview.role === 'user' && <span className="opacity-70">Tu: </span>}
      {preview.text}
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
  const tr = useT();
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
  // A tab has no sentence around the number, so the tone IS the sentence: the
  // primary sweep of the loader while the turn runs, amber while it waits for
  // you, the quiet grey once it is only a receipt. See timeTone.
  const voice = timeVoice(time.kind === 'working', activity?.tier === 'input');
  const tone = timeToneClass(voice, onFill);
  return (
    <span
      className={`ml-0.5 flex-shrink-0 text-[10px] leading-none tabular-nums ${
        tone ?? (onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-faint/70')
      } ${className}`}
      data-time-voice={voice}
      data-testid="tab-elapsed"
      title={
        time.kind === 'working'
          ? tr('activity.runningFor', { label, approx: time.approx ? tr('activity.atLeast') : '' })
          : `Ha finito ${label} fa`
      }
    >
      {label}
    </span>
  );
}

/**
 * ProjectElapsed — the same time voice, for a FOLDER.
 *
 * A project has no session of its own: its number is the roll-up, "the oldest
 * turn still running in here" (useProjectWorkStart). It exists for exactly the
 * case the child numbers cannot cover — the folder is CLOSED, so none of the
 * children that own a clock is on screen — which is why both call sites gate it
 * on the folder being collapsed, exactly like the project loader next to it.
 *
 * Only the LIVE branch: when nothing is running there is no aggregate worth a
 * digit (the sidebar row already carries its "agg. X fa" receipt), and a folder
 * that has been quiet for three days would just add noise to every tab.
 */
export function ProjectElapsed({ projectPath, onFill, className = '' }: {
  projectPath: string | undefined;
  onFill?: boolean;
  className?: string;
}) {
  // Gate BEFORE the clock, like SessionElapsed: a quiet project must not
  // subscribe to the shared tick just to render nothing every 10s.
  const startedAt = useProjectWorkStart(projectPath);
  if (!startedAt) return null;
  return <ProjectElapsedTicking startedAt={startedAt} onFill={onFill} className={className} />;
}

function ProjectElapsedTicking({ startedAt, onFill, className = '' }: {
  startedAt: number;
  onFill?: boolean;
  className?: string;
}) {
  const tr = useT();
  const now = useSharedNow();
  const ms = Math.max(0, now - startedAt);
  // Same threshold as a tab: a turn that just started does not deserve a digit
  // dancing on a narrow surface.
  if (ms < WORK_ELAPSED_AFTER_MS) return null;
  const label = formatElapsedCompact(ms);
  if (!label) return null;
  const tone = timeToneClass('live', onFill);
  return (
    <span
      className={`ml-0.5 flex-shrink-0 text-[10px] leading-none tabular-nums ${
        tone ?? (onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-faint/70')
      } ${className}`}
      data-time-voice="live"
      data-testid="project-elapsed"
      title={tr('activity.runningFor', { label, approx: '' })}
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
