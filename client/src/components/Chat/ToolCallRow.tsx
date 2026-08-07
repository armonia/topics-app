import { createElement, memo, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, HelpCircle, Loader2, X } from 'lucide-react';
import type { ToolCall, ToolUserResponse } from '../../types';
import { resolveToolDetail, buildToolDisplayLabel } from './toolDetail';
import { ToolCardBody } from './ToolCards';
import { toolCardHasBody } from './toolCardBody';
import { iconForDetail } from './toolIcons';
import { ToolInputForm } from './ToolInputForm';
import { ToolPermissionRow } from './ToolPermissionRow';
import { formatDurationMs, formatCostCents, formatTokensCompact } from './toolGrouping';
import { chatApi } from '../../lib/api';
import { planDecisionFrom } from '../../../../shared/plan-decision';
import { SETTLED_METRIC_CLASS } from './settledMetrics';
import { isAwaitingHuman } from '../../../../shared/types';

/**
 * Live elapsed readout for a call that hasn't settled — ticks every second
 * from `since`. The "hot" signal that time is really passing inside this
 * tool. Hidden for the first ~second so instant tools don't blink a "0.9s"
 * in and out.
 *
 * It also runs while the tool is `waiting_for_input`: there the clock is
 * measuring the HUMAN, and that number is the most useful thing in the row
 * ("this agent has been blocked on me for 4m"). `tone` recolours it so the
 * two readings aren't confused.
 */
export function ElapsedTimer({ since, tone, title }: { since: number; tone?: string; title?: string }) {
  // Elapsed lives in state and is advanced by the interval — render stays
  // pure (no Date.now() during render, react-hooks/purity).
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const update = () => setMs(Date.now() - since);
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [since]);
  if (ms < 900) return null;
  return (
    <span
      className={`text-[10px] tabular-nums ${tone ?? 'text-app-text-muted'}`}
      data-testid="tool-elapsed"
      title={title}
    >
      {formatDurationMs(ms)}
    </span>
  );
}

/** Running must persist this long before the body auto-opens — instant tools
 *  (a sub-250ms Read) never flash a panel open and closed (CHAT-TOOL-03). */
const AUTO_OPEN_DELAY_MS = 250;
/** Once auto-opened, the body stays visible at least this long even if the
 *  tool finishes earlier, so short tools remain readable. */
const AUTO_OPEN_MIN_DWELL_MS = 1500;

interface Props {
  toolCall: ToolCall;
  /**
   * Optional override for the row label. Defaults to the canonical
   * display name from `buildToolDisplayLabel(detail)` (e.g. "Read",
   * "Shell"). Provider-specific renderers can pass a richer label.
   */
  label?: string;
  /**
   * Session key the tool belongs to — required to submit the user's
   * answer when `toolCall.status === 'waiting_for_input'`. Absent
   * disables the input form (the row still renders, with a hint).
   */
  sessionKey?: string;
  /**
   * La decisione presa su un piano proposto.
   *
   * Il pannello è quello di sempre (`ToolInputForm`), e la risposta si registra
   * come tutte le altre — ma qui non c'è nessun tool sospeso da sbloccare: il
   * turno è già finito, e a farlo ripartire è un messaggio nuovo con
   * l'autonomia giusta. Quel messaggio lo manda chi possiede la sessione, non
   * questa riga: la riga si limita a dire che cosa hai scelto.
   */
  onPlanDecision?: (approved: boolean) => void;
}

/**
 * One inline tool-call row. Borderless, single-line header (chevron, icon,
 * name + summary, status); click to reveal a typed body card matching the
 * tool kind (shell terminal, read content, edit diff, sub-agent log, etc.).
 *
 * The detail comes from `tc.detail` when the server's normalizer set it; the
 * client falls back to `deriveToolDetail` for legacy messages persisted
 * before the normalization layer existed. Both paths land in the same
 * `<ToolCardBody>` dispatcher so a Bash tool from 6 months ago and one
 * streaming right now render identically.
 */
/**
 * `memo` perché durante lo streaming il ramo `blocks` di `MessageContent` si
 * ri-renderizza a ogni token, e senza confronto ogni riga di tool già conclusa
 * si ridisegnava insieme all'ultima. L'invariante che lo rende CORRETTO esiste
 * già ed è deliberata: `useChat.ts` costruisce sempre un `newTc` nuovo quando un
 * tool cambia — testualmente "so React.memo sees a real prop change" — quindi
 * una riga aggiornata ha davvero una prop diversa e non resta indietro.
 */
export const ToolCallRow = memo(function ToolCallRow({ toolCall, label, sessionKey, onPlanDecision }: Props) {
  const [open, setOpen] = useState(false);

  // Resolve the detail (server-provided or fallback derivation) and the
  // user-facing display name + summary. Sub-agent rows are auto-expanded
  // because their action log IS the primary signal — collapsed they'd hide
  // the entire reason for showing the row.
  const detail = resolveToolDetail(toolCall);
  const display = buildToolDisplayLabel(detail, toolCall.name);
  const Icon = iconForDetail(detail);
  const status = toolCall.status ?? 'pending';
  const isRunning = status === 'pending' || status === 'running';
  const isWaiting = status === 'waiting_for_input';
  // Un PERMESSO non è una domanda: stato suo, pannello suo, decisione
  // tipizzata. Ma per tutto ciò che chiede «la palla è dell'umano?» — la
  // riga aperta, niente cronometro che scorre, il cerchietto ambra — sono
  // lo stesso fatto, quindi condividono `isHumanTurn`.
  const isAwaitingPermission = status === 'awaiting_permission';
  const isHumanTurn = isAwaitingHuman(status);
  const isError = status === 'error';

  // True when the whole point of the call is the question — the SDK's
  // `AskUserQuestion` or its Topics MCP bridge twin (see
  // server/providers/ask-user-detector.ts, which matches the same two names).
  // For those the args and the form are the same content, so the row shows
  // the form alone; every other suspended tool keeps its card too.
  const askIsTheWholeCall =
    toolCall.userInputSchema?.kind === 'questions' &&
    (toolCall.name === 'AskUserQuestion' || toolCall.name.endsWith('__ask_user_question'));

  // Auto-open rows that NEED to be open: sub-agent (action log is the
  // primary signal), waiting_for_input (the form is the row's whole
  // reason for showing), and RUNNING tools — the open body is the live
  // preview of what the agent is doing right now; it collapses back on
  // completion so finished rows stay compact. Honor user toggles afterwards.
  //
  // CHAT-TOOL-03 anti-flash gating: the running auto-open engages only after
  // AUTO_OPEN_DELAY_MS of sustained running (instant tools never flash), and
  // once engaged it lingers AUTO_OPEN_MIN_DWELL_MS past completion so a
  // sub-second tool stays readable instead of blinking.
  const [userToggled, setUserToggled] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const autoOpenedAtRef = useRef(0);
  useEffect(() => {
    if (isRunning) {
      const t = setTimeout(() => {
        autoOpenedAtRef.current = Date.now();
        setAutoOpen(true);
      }, AUTO_OPEN_DELAY_MS);
      return () => clearTimeout(t);
    }
    if (autoOpen) {
      const residual = Math.max(0, AUTO_OPEN_MIN_DWELL_MS - (Date.now() - autoOpenedAtRef.current));
      const t = setTimeout(() => setAutoOpen(false), residual);
      return () => clearTimeout(t);
    }
  }, [isRunning, autoOpen]);
  const effectiveOpen = userToggled
    ? open
    : (open || detail.type === 'sub_agent' || isHumanTurn || autoOpen);

  const onToggle = () => {
    setUserToggled(true);
    setOpen((v) => !v);
  };

  // C'è davvero qualcosa da aprire? Una `Skill` senza istruzioni — cioè ogni
  // riga scritta prima che il provider imparasse a raccoglierle — apriva un
  // riquadro vuoto: il chevron prometteva un corpo che non esisteva. Senza
  // corpo la riga non offre il gesto (e non ne finge nemmeno lo spazio: il
  // posto del chevron resta, o le righe non si allineerebbero più).
  const hasBody =
    toolCardHasBody(detail) || isHumanTurn || isError || !!toolCall.error || !!toolCall.userResponse
    // Una decisione presa su un permesso è la traccia che si va a rileggere:
    // la riga si richiude (la palla non è più tua) ma deve restare APRIBILE,
    // come già fa una domanda a cui hai risposto.
    || !!toolCall.permissionOutcome;

  // Una riga che non si apre e non dice perché si legge come una riga ROTTA —
  // tanto più dopo che si apriva (su un riquadro vuoto, ma si apriva). Il
  // motivo vero è che non c'è niente da mostrare, e vale la pena dirlo: sulle
  // `Skill` è quasi sempre perché la chiamata è anteriore alla correzione che
  // ha insegnato al provider a raccogliere le istruzioni caricate.
  const emptyReason = hasBody
    ? undefined
    : detail.type === 'skill'
      ? 'Nessuna istruzione registrata per questa skill: la chiamata è anteriore alla correzione che le raccoglie. Dalla prossima si apre.'
      : 'Niente da mostrare: questa azione non ha né argomenti né risultato.';

  // Costo/token dell'azione: preferisci il prezzo (modello noto), altrimenti i
  // token come fallback. Il title esplicita cos'è, così non si confonde con la
  // durata accanto.
  const costFromCents = typeof toolCall.costCents === 'number' ? formatCostCents(toolCall.costCents) : '';
  const costFromTokens = typeof toolCall.tokens === 'number' ? formatTokensCompact(toolCall.tokens) : '';
  const costLabel = costFromCents || (costFromTokens ? `${costFromTokens} tok` : '');
  const costTitle = costFromCents
    ? `Costo di questa azione${costFromTokens ? ` · ${costFromTokens} token` : ''} — la chiamata che l'ha decisa`
    : costFromTokens
      ? `${costFromTokens} token attribuiti a questa azione`
      : undefined;

  return (
    <div
      data-testid={`tool-call-row-${toolCall.id}`}
      // Lo stato sta sulla RIGA, non su una colonna a destra. Ci stava finché
      // quella colonna portava la spunta: tolta la spunta — che confermava la
      // norma su ogni riga riuscita — quello span resta vuoto ogni volta che
      // l'azione non ha nemmeno durata o costo, e un contenitore vuoto non è
      // «visibile» per nessuno, test compresi. Lo stato è una proprietà della
      // riga, e adesso è scritto dove vive davvero.
      data-status={status}
      className={`text-[12px] rounded-md transition-colors ${
        // "In use" state must be unmissable: the active tool gets a soft
        // primary tint + hairline ring (negative margin keeps the text
        // column aligned with settled rows). Settled rows stay flat.
        // `ring-inset`: il margine negativo porta la riga 6px oltre la colonna
        // del messaggio, che è `overflow-hidden` — un anello disegnato FUORI dal
        // bordo veniva tagliato a metà proprio sui due lati lunghi.
        isRunning ? 'bg-primary/5 ring-1 ring-inset ring-primary/10 -mx-1.5 px-1.5' : ''
      }`}
    >
      {/* Un bottone SOLO se c'è qualcosa da aprire. Renderlo comunque e poi
          disabilitarlo sarebbe una promessa fatta e ritirata: chi naviga da
          tastiera ci si ferma sopra, il lettore di schermo annuncia un comando,
          e il click non fa niente. Senza corpo la riga è una riga e basta. */}
      {createElement(
        hasBody ? 'button' : 'div',
        hasBody
          ? {
              type: 'button' as const,
              onClick: onToggle,
              className: 'group/tool w-full flex items-center gap-2 py-1 text-left text-app-text-secondary hover:text-app-text transition-colors',
            }
          : {
              className: 'group/tool w-full flex items-center gap-2 py-1 text-left text-app-text-secondary',
              title: emptyReason,
              'data-empty': 'true',
            },
        <>
        {/* Il posto del chevron c'è sempre — occupato o vuoto — o le righe con
            corpo e quelle senza partirebbero da due colonne diverse. */}
        {hasBody ? (
          effectiveOpen ? <ChevronDown size={12} className="text-app-text-muted flex-shrink-0" /> : <ChevronRight size={12} className="text-app-text-muted flex-shrink-0" />
        ) : (
          <span className="w-3 flex-shrink-0" aria-hidden="true" />
        )}
        {/* `Icon` is a stable Lucide component from iconForDetail()'s static
            lookup, not one defined during render; createElement is the
            lint-clean equivalent of `<Icon/>` (react-hooks/static-components). */}
        {createElement(Icon, { size: 13, className: `flex-shrink-0 ${isRunning ? 'text-primary' : 'text-app-text-muted'}` })}
        {/* Claude Code-style header: `Shell(bun test)` / `Read(App.tsx)` — la
            COSA sta dentro le parentesi a pieno contrasto, non come ripensamento
            smorto accanto.
            Il gruppo nome+argomento è l'UNICA parte che si restringe: prima il
            nome era `flex-shrink-0` e in una pane stretta a essere tagliati
            erano durata, costo ed esito — cioè la colonna di destra, che è
            larga uguale per tutte le righe e non avrebbe mai dovuto cedere.
            Le parentesi stanno FUORI dal troncamento: dentro, quella di
            chiusura spariva su ogni argomento lungo, cioè quasi sempre. */}
        <span className="flex-1 min-w-0 flex items-baseline gap-1">
          {/* L'esito si dice SOLO quando è cattivo, e si dice qui, accanto al
              nome. Una spunta verde su ogni riga conclusa confermava la norma —
              cioè non diceva niente — e teneva occupata una colonna a destra
              per tutte le righe pur di servirne una su cento. */}
          {isError && <X size={11} className="flex-shrink-0 text-red-500 self-center" aria-label="fallita" />}
          <span
            data-testid="tool-call-name"
            className={`flex-shrink-0 max-w-[55%] truncate font-medium ${isRunning ? 'text-primary' : isError ? 'text-red-500' : 'text-app-text'}`}
          >
            {label ?? display.name}
          </span>
          {display.summary && (
            <span className="min-w-0 flex items-baseline text-[11px] text-app-text-secondary font-mono">
              <span className="flex-shrink-0">(</span>
              <span className="truncate">{display.summary}</span>
              <span className="flex-shrink-0">)</span>
            </span>
          )}
        </span>
        <span className="flex-shrink-0 inline-flex items-center gap-1.5">
          {/* Cronometro vivo SOLO mentre l'agente è davvero dentro al tool.
              In `waiting_for_input` non gira niente: la palla è dell'umano, e
              un contatore che scorre mentre si legge una domanda mette fretta
              senza dire niente di nuovo (l'attesa la annuncia già il cerchietto
              ambra qui accanto, col suo titolo). Stessa scelta del cronometro
              del turno, che durante l'attesa mostra il lavoro e sta fermo.
              Durata definitiva una volta che il risultato è arrivato; le righe
              vecchie senza timestamp non mostrano niente. */}
          {isRunning && typeof toolCall.startedAt === 'number' && (
            <ElapsedTimer since={toolCall.startedAt} />
          )}
          {!isRunning && !isHumanTurn && typeof toolCall.startedAt === 'number' && typeof toolCall.endedAt === 'number' && toolCall.endedAt >= toolCall.startedAt && (
            <span className={`text-[10px] tabular-nums text-app-text-muted ${SETTLED_METRIC_CLASS}`} data-testid="tool-duration">
              {formatDurationMs(toolCall.endedAt - toolCall.startedAt)}
            </span>
          )}
          {/* Costo di QUESTA azione, accanto alla durata: la chiamata che l'ha
              decisa, non il totale del turno. Prezzo se il modello è noto,
              altrimenti i token. Assente sui messaggi vecchi. */}
          {costLabel && (
            <span className={`text-[10px] tabular-nums text-app-text-muted ${SETTLED_METRIC_CLASS}`} data-testid="tool-cost" title={costTitle}>
              {costLabel}
            </span>
          )}
          {/* `waiting_for_input` is the new state: spinner is misleading
              ("we're working on it") because we're actually blocked on
              the user. Show a help-circle accent instead, matching the
              banner inside the form. Falls back to spinner for the
              pending/running cases that still mean the agent is busy. */}
          {isHumanTurn && (
            <HelpCircle
              size={11}
              className="text-amber-500"
              // Niente durata qui: senza un tick la si scriverebbe una volta e
              // resterebbe ferma su un valore vecchio — un numero sbagliato è
              // peggio di nessun numero. Da quanto aspetta lo dice il titolo del
              // cronometro del turno, che un tick ce l'ha.
              aria-label="In attesa della tua risposta"
            />
          )}
          {/* Qui resta solo ciò che è VIVO: la rotella mentre l'agente è dentro
              al tool, il cerchietto ambra mentre la palla è tua. L'esito, buono
              o cattivo, sta accanto al nome. */}
          {isRunning && <Loader2 size={11} className="animate-spin text-primary" />}
        </span>
        </>,
      )}
      {effectiveOpen && (
        <div className="ml-5 pb-1.5">
          {/* Pending input form takes precedence: when the agent is asking
              the user, the regular ToolCardBody (args/result preview) is
              not the primary signal — the form is. But it isn't a REPLACEMENT
              either: a tool that suspends mid-work (an MCP elicitation raised
              from inside a real call) still needs its usual card, because
              those args are the context you answer FROM. The single exception
              is the ask tool itself — its args *are* the questions, so echoing
              them above the radios would just say everything twice. */}
          {/* La riga resta anche DOPO la decisione: `permissionOutcome` la fa
              collassare in una riga sola che dice chi ha detto cosa. Senza,
              premuto il bottone il pannello spariva e della decisione non
              restava traccia — e una decisione sui permessi è esattamente ciò
              che si va a rileggere sei mesi dopo. */}
          {toolCall.permissionRequest && (isAwaitingPermission || toolCall.permissionOutcome) && sessionKey ? (
            <>
            <ToolCardBody detail={detail} isError={isError} isRunning={false} />
            <ToolPermissionRow
              request={toolCall.permissionRequest}
              outcome={toolCall.permissionOutcome}
              toolCallId={toolCall.id}
              onDecide={async (decision) => { await chatApi.permissionResponse(sessionKey, toolCall.id, decision); }}
            />
            </>
          ) : isWaiting && toolCall.userInputSchema && sessionKey ? (
            <>
            {!askIsTheWholeCall && <ToolCardBody detail={detail} isError={isError} isRunning={false} />}
            <ToolInputForm
              schema={toolCall.userInputSchema}
              toolCallId={toolCall.id}
              onSubmit={async (response: ToolUserResponse) => {
                const decision = planDecisionFrom(response);
                // The WS broadcast that follows will flip status →
                // 'running' and persist `userResponse`; we don't need
                // to update local state here. If the server rejects
                // (404/502/503) the chatApi throws an ApiError with the
                // message attached, which `ToolInputForm` surfaces inline.
                await chatApi.toolResponse(sessionKey, toolCall.id, response);
                // Registrata la scelta, il lavoro riparte: la route ha solo
                // preso nota, perché di tool sospesi qui non ce n'è.
                if (decision !== null) onPlanDecision?.(decision);
              }}
            />
            </>
          ) : isWaiting && !sessionKey ? (
            <div className="text-[11px] text-amber-600 bg-amber-500/10 rounded px-2 py-1">
              The agent is asking for input but this view has no session context. Reload to answer.
            </div>
          ) : (
            <ToolCardBody detail={detail} isError={isError} isRunning={isRunning} />
          )}
          {toolCall.userResponse && status !== 'waiting_for_input' && (
            <div className="mt-1.5 text-[11px] text-app-text-muted">
              <span className="uppercase tracking-wide">Answered</span>
              <span className="ml-1 font-mono">
                {toolCall.userResponse.kind === 'questions'
                  ? Object.values(toolCall.userResponse.answers).join(' · ')
                  : toolCall.userResponse.kind === 'raw'
                    ? toolCall.userResponse.text
                    : JSON.stringify(toolCall.userResponse.value)}
              </span>
            </div>
          )}
          {toolCall.error && status === 'error' && detail.type !== 'shell' && (
            <div className="mt-1.5">
              <div className="text-[11px] uppercase tracking-wide text-red-500 mb-0.5">Error</div>
              <pre data-testid="tool-call-error" className="text-[11px] font-mono text-red-500 whitespace-pre-wrap overflow-auto max-h-40 bg-red-500/5 rounded px-2 py-1.5">
                {toolCall.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
