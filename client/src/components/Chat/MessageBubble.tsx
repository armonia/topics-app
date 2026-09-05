import { memo, useState, useCallback, useEffect, useRef } from 'react';
import { useT } from '../../hooks/useT';
import { Copy, Check, Pin, Brain, Pencil, ChevronLeft, ChevronRight, RotateCw, Target, Trash2 } from 'lucide-react';
import type { Topic, ChatMessage, WSMessage } from '../../types';
import { MessageMetaFooter } from './MessageMetaFooter';
import { isWorkOnlyAssistant } from './coalesceToolRun';
import { MessageContent } from '../MessageContent';
import { turnIsOnlyError } from './turnError';
import { goalLoopRowOf } from './goalLoopRow';
import { isDispatchedEnvelope } from './dispatchedEnvelope';
import { DispatchEnvelopeRow } from './DispatchEnvelopeRow';
import { useMobile } from '../../hooks/useMobile';
import { hoverRevealClass } from '../../lib/hoverReveal';
import { useLongPress } from '../../hooks/useLongPress';
import { useDismissable } from '../../hooks/useDismissable';

// «Sono su un dispositivo touch?» si chiede a `useMobile`, e basta. Qui c'era
// una costante di MODULO valutata una volta sola all'import: un valore che non
// reagisce mai (né a un cambio di puntatore, né a un'apertura in un'altra
// finestra) e che era anche una seconda definizione di un fatto che l'app già
// conosce — cioè un modo per farle divergere.
//
// Ma la costante di modulo leggeva `(hover: none)`, e sostituirla con `isTouch`
// ha cambiato la DOMANDA, non solo la fonte: «si può toccare» non è «non c'è
// hover». Su un portatile con schermo touch sono vere entrambe, e la barra
// azioni + la riga di servizio sono rimaste inchiodate a opacity-40/60 invece
// di apparire al passaggio del mouse. Qui si legge `hasHover` per ciò che si
// NASCONDE dietro l'hover e `isTouch` per ciò che si AGGIUNGE al dito, e sullo
// stesso device possono convivere. Vedi il blocco in testa a `useMobile`.

// Detect emoji-only messages (1-5 emojis/symbols with no other text).
// ZWJ (\u200d) and VS16 (\ufe0f) are intentional allow-listed *filler*
// codepoints so emoji ZWJ sequences (\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67) and variation-selector emoji (\u270c\ufe0f)
// still pass \u2014 they are matched per-codepoint inside the quantified class, not
// as a single grapheme. The lint flag is a false positive for this usage.
// eslint-disable-next-line no-misleading-character-class
const EMOJI_REGEX = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f\u2713\u2714\u2715\u2716\u2718\u2022\s]{1,10}$/u;
const isEmojiOnly = (content: string): boolean => {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > 20) return false;
  return EMOJI_REGEX.test(trimmed) && !/[a-zA-Z0-9]/.test(trimmed);
};

const formatTimestamp = (ts: string): string => {
  try {
    const date = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
};

const getDateSeparator = (ts: string, prevTs?: string): string | null => {
  try {
    const date = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (prevTs) {
      const prevDate = new Date(prevTs);
      const prevMsgDate = new Date(prevDate.getFullYear(), prevDate.getMonth(), prevDate.getDate());
      if (msgDate.getTime() === prevMsgDate.getTime()) return null;
    }

    if (msgDate.getTime() === today.getTime()) return 'Today';
    if (msgDate.getTime() === yesterday.getTime()) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  } catch {
    return null;
  }
};

interface MessageBubbleProps {
  msg: ChatMessage;
  prev?: ChatMessage;
  idx: number;
  topic: Topic;
  copiedMsgId: string | null;
  isCompact: boolean;
  fontSize: number;
  isMobile: boolean;
  onReply: (msg: ChatMessage) => void;
  onCopy: (msg: ChatMessage) => void;
  onTogglePin: (msg: ChatMessage) => void;
  /** La decisione presa su un piano proposto — arriva fino a <ToolCallRow>. */
  onPlanDecision?: (approved: boolean) => void;
  onRemember?: (msg: ChatMessage) => void;
  onEdit?: (msg: ChatMessage) => void;
  /** Regenerate this assistant reply as a sibling branch (host gates it off
   *  while the session is streaming). */
  onRegenerate?: (msg: ChatMessage) => void;
  /** Delete this message + its descendant branches. Two-click confirm is
   *  handled locally (the button arms, then fires). */
  onDeleteMessage?: (msg: ChatMessage) => void;
  onSwitchBranch?: (messageId: string, branchIndex: number) => void;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  onRetry?: () => void;
  /** True only for the last row in the list. The live turn-activity indicator
   *  is gated on this so a stale partial left earlier in the transcript (a
   *  ghost from a lost stream:end) can never paint a SECOND running indicator
   *  under the real, current turn. */
  isLast?: boolean;
}

export const MessageBubble = memo(function MessageBubble({
  msg,
  prev,
  idx,
  topic,
  copiedMsgId,
  isCompact,
  fontSize,
  isMobile,
  onReply,
  onCopy,
  onTogglePin,
  onPlanDecision,
  onRemember,
  onEdit,
  onRegenerate,
  onDeleteMessage,
  onSwitchBranch,
  onMessage,
  onRetry,
  isLast,
}: MessageBubbleProps) {
  const tr = useT();
  // I numeri del turno: se non ce n'è nemmeno uno, la riga dei metadati non ha
  // niente da dire oltre all'ora.
  const hasTurnMetrics =
    (msg.latencyMs ?? 0) > 0 ||
    (msg.usagePromptTokens ?? 0) > 0 ||
    (msg.usageCompletionTokens ?? 0) > 0 ||
    (msg.costCents ?? 0) > 0;

  const grouped = idx > 0 && prev && prev.role === msg.role && msg.timestamp && prev.timestamp && (new Date(msg.timestamp).getTime() - new Date(prev.timestamp).getTime() < 120000);
  const dateSep = getDateSeparator(msg.timestamp, prev?.timestamp);
  const emojiMsg = isEmojiOnly(msg.content);
  const { isTouch, hasHover } = useMobile();

  // Long-press state for touch devices
  const [showActions, setShowActions] = useState(false);

  // Collapsed by default: the envelope is three hundred lines of instructions,
  // and it is machinery. Open on demand because a resume envelope quotes the
  // human's own message inside it.
  
  // Two-click delete confirm: first click arms (button turns red "Delete?"),
  // second click within the window fires. Auto-disarms after 3s so a stray
  // click can't linger as a loaded gun.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (disarmTimer.current) clearTimeout(disarmTimer.current); }, []);
  const handleDeleteClick = useCallback(() => {
    if (deleteArmed) {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
      setDeleteArmed(false);
      onDeleteMessage?.(msg);
      return;
    }
    setDeleteArmed(true);
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = setTimeout(() => setDeleteArmed(false), 3000);
  }, [deleteArmed, onDeleteMessage, msg]);

  // «Tieni premuto» = la primitiva condivisa (hooks/useLongPress). Qui c'era la
  // SECONDA copia dello stesso timer da 500ms che viveva anche in `PaneTabBar`,
  // con gli stessi due buchi: tolleranza zero sul movimento (un pixel di
  // tremolio e il gesto moriva, quindi con un dito vero spesso non partiva) e
  // nessun `touchcancel`, cioè un timer che restava armato quando il sistema si
  // prendeva il tocco. La barra si scopriva da sola qualche istante dopo.
  const longPress = useLongPress(() => setShowActions(true), { enabled: isTouch });
  // ...e si RICHIUDE. `showActions` non tornava mai false: una volta scoperta,
  // la barra di quel messaggio restava accesa fino allo smontaggio della riga, e
  // scorrendo se ne accumulavano quante ne avevi toccate. `useDismissable` la
  // chiude al primo tocco fuori e la iscrive al registro «un popover alla volta»
  // (lib/popoverRegistry), quindi tenere premuto un ALTRO messaggio spegne
  // questo — che e' come si comporta ogni altra superficie dell'app.
  const bubbleRef = useRef<HTMLDivElement>(null);
  useDismissable({ open: showActions, onClose: () => setShowActions(false), refs: [bubbleRef], restoreFocus: false });

  // Visibilità della barra azioni, in TRE rami e in quest'ordine — perché i due
  // fatti non sono esclusivi e su un ibrido valgono insieme:
  //  1. long-press andato a segno → piena, sempre (è la richiesta esplicita del
  //     dito, e deve vincere anche dove il mouse c'è);
  //  2. c'è un puntatore che fa hover → nascosta e rivelata dal gruppo, come su
  //     qualunque desktop;
  //  3. nessun hover → semi-visibile a riposo, altrimenti su un telefono la
  //     barra non esisterebbe finché non indovini il «tieni premuto».
  // Il ramo (2) era gated su `!isTouch`: su un portatile touch cadeva nel (3) e
  // la barra restava a opacity-40 anche col mouse sopra.
  // Un messaggio A RIPOSO non mostra niente, e il gesto e' lo stesso di tutta
  // l'app. Il ramo (3) era `opacity-40`, cioe' la barra azioni restava
  // semi-visibile su OGNI bolla: su un telefono e' un velo di icone ripetuto
  // decine di volte in una schermata, e il commento che lo giustificava diceva
  // «altrimenti la barra non esisterebbe finche' non indovini il tieni-premuto».
  // Quell'argomento e' caduto: da questa sessione «tieni premuto» e' il gesto
  // STANDARD dell'app — apre il menu di una riga di sidebar, di una tab, di un
  // gruppo, di una tessera — quindi si impara una volta e vale ovunque. Un gesto
  // che si conosce non ha bisogno di un promemoria stampato su ogni messaggio.
  // La coppia giusta (hover → si scopre; niente puntatore → sparisce DAVVERO,
  // hit-test compreso) arriva dalla regola condivisa: `lib/hoverReveal`. Il
  // percorso col dito c'e' gia' — «tieni premuto» apre la barra.
  const actionsVisibility = showActions ? 'opacity-100' : hoverRevealClass(hasHover);

  const actionBtnClass = "w-7 h-7 flex items-center justify-center text-app-text-muted hover:text-primary rounded";

  // THE GOAL LOOP TALKS, IT DOES NOT IMPERSONATE.
  //
  // A continuation the server sent to keep an objective alive is a `user` row
  // (the only role a provider answers), so without this branch the transcript
  // would show the person saying "Objective still open: ... continue". One
  // compact line, no bubble, no hover toolbar: it is machinery, and it reads as
  // machinery. Same for the line that says the loop stopped by itself.
  // See `goalLoopRow.ts` and server/services/goal-loop.ts.
  const goalRow = goalLoopRowOf(msg.blocks);
  if (goalRow) {
    return (
      <div
        data-testid="goal-loop-row"
        data-goal-loop={goalRow.kind === 'nudge' ? `nudge:${goalRow.attempt}` : `stop:${goalRow.reason}`}
        className="my-1 flex items-center justify-center gap-1.5 px-2 text-[11px] text-app-text-muted"
      >
        <Target size={11} className="flex-shrink-0" />
        <span className="truncate">
          {goalRow.kind === 'nudge'
            ? tr('goal.loop.continuing', { n: String(goalRow.attempt) })
            : goalRow.reason === 'capped'
              ? tr('goal.loop.capped')
              : tr('goal.loop.stalled')}
        </span>
      </div>
    );
  }

  // THE BOARD'S ENVELOPE TALKS, IT DOES NOT IMPERSONATE. The row itself lives
  // in `DispatchEnvelopeRow`, shared with the card's conversation: two surfaces
  // draw it, and a service line that looks different in each is a second thing
  // to learn. See `dispatchedEnvelope.ts` for the rule that recognises it.
  if (isDispatchedEnvelope(msg.blocks)) {
    return <DispatchEnvelopeRow messageId={msg.id} content={msg.content} />;
  }

  return (
    <div
      // Riga del messaggio identificabile per RUOLO e per id: senza, contare "le
      // bolle dell'assistente" in un test voleva dire agganciarsi a una classe di
      // layout, che cambia col design. Serve, fra l'altro, a provare che un turno
      // fermato prima di produrre qualcosa non lascia una bolla vuota.
      data-testid="chat-message"
      data-role={msg.role}
      data-message-id={msg.id}
      // IL CALLOUT DI iOS NON DEVE PARTIRE DURANTE I 500 ms.
      //
      // Era l'unico elemento con long-press senza niente addosso: sul telefono,
      // mentre il timer del gesto scorre, WebKit apre la sua lente + il menu
      // «Copia/Cerca» sopra il testo, e la barra azioni arriva sotto a un menu
      // di sistema che non abbiamo chiesto.
      //
      // Ma qui il testo È il contenuto, e un `select-none` secco costerebbe la
      // selezione col mouse — cioè lo stesso errore che questo giro sta
      // chiudendo (trattare «touch» come se escludesse il puntatore). Quindi
      // due cose distinte:
      //  · `-webkit-touch-callout: none` SEMPRE: toglie il menu di sistema e
      //    non costa un pixel a chi ha un mouse (su desktop non esiste proprio);
      //  · `select-none` solo dove NON c'è hover, cioè sul telefono, dove il
      //    «tieni premuto» è l'unica strada per la barra azioni — e per copiare
      //    il testo c'è il bottone Copia lì dentro. Su un ibrido (touch + mouse)
      //    la selezione resta: lì il gesto convive col puntatore.
      ref={bubbleRef}
      className={`${emojiMsg ? 'mb-1' : isCompact ? 'mb-1' : 'mb-1.5'} ${isTouch && !hasHover ? 'select-none' : ''}`}
      style={{ WebkitTouchCallout: 'none' }}
      // Il segno che la pressione è stata registrata: su iPhone `haptic()` è un
      // no-op, quindi senza questo mezzo secondo di attesa sarebbe cieco.
      data-pressing={longPress.pressed || undefined}
      {...longPress.handlers}
      // L'ECO DEL LONG-PRESS SI MANGIA QUI, ESPLICITAMENTE.
      //
      // Prima `consumeClick()` non veniva chiamato MAI: reggeva solo perché
      // questo wrapper non aveva `onClick` e il `preventDefault()` di
      // `useLongPress.onTouchEnd` sopprime il clic sintetico. Due condizioni
      // implicite, e la prima cade al primo handler che qualcuno aggiunge qui —
      // che a quel punto sparerebbe subito dopo l'apertura della barra azioni.
      // Chiamandolo il contratto diventa visibile e il flag non resta armato:
      // fase di bubbling e nessuno `stopPropagation`, quindi i bottoni della
      // barra (che sono discendenti e hanno già eseguito il loro handler) non
      // perdono un clic.
      onClick={() => { if (longPress.consumeClick()) return; }}
    >
      {/* Date separator */}
      {dateSep && (
        // pointer-events-none: purely decorative; must never win hit-tests
        // against the floating message-action toolbars that overlap this row.
        <div className="flex items-center gap-3 my-3 pointer-events-none">
          <div className="flex-1 h-px bg-app-border" />
          <span className="text-[11px] font-medium text-app-text-muted uppercase tracking-wider">{dateSep}</span>
          <div className="flex-1 h-px bg-app-border" />
        </div>
      )}

      <div
        className={`group flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} ${!grouped ? 'message-appear' : ''} ${grouped && isCompact ? 'mt-0.5' : ''}`}
      >
        <div
          // NO overflow-hidden here: this div is the containing block of the
          // absolutely-positioned hover toolbar below (`bottom-full` = above the
          // top edge), so clipping here made the toolbar invisible AND
          // unclickable — clicks fell through to the previous list row. Content
          // clipping lives on the inner bubble div (which has its own
          // overflow-hidden + overflow-wrap), so wide code/links still wrap.
          //
          // Only the user's own messages are boxed into a bubble, so only
          // they need the 85% cap to look like a bubble; assistant replies
          // have no card to constrain and get the full row width instead.
          className={`relative flex flex-col min-w-0`}
          style={{ maxWidth: isMobile ? 'calc(100vw - 5rem)' : (msg.role === 'user' ? '85%' : '100%') }}
        >
          {/* Floating action toolbar */}
          {!grouped && (
            <div className={`absolute bottom-full mb-1 ${msg.role === 'user' ? 'right-1' : 'left-1'} flex items-center gap-0.5 z-10 transition-opacity ${actionsVisibility} bg-elevated dark:bg-app-surface rounded-lg shadow-sm border border-app-border-light px-1 py-0.5`}>
              {msg.role === 'user' && onEdit && (
                <button onClick={() => onEdit(msg)} className={actionBtnClass} title="Edit" aria-label="Edit message">
                  <Pencil size={14} />
                </button>
              )}
              <button onClick={() => onReply(msg)} className={actionBtnClass} title="Reply" aria-label="Reply">↩</button>
              <button onClick={() => onCopy(msg)} className={actionBtnClass} title="Copy" aria-label="Copy message">
                {copiedMsgId === msg.id ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
              </button>
              <button onClick={() => onTogglePin(msg)} className={`w-7 h-7 flex items-center justify-center rounded ${(topic.pinnedMessages || []).includes(msg.id) ? 'text-yellow-500' : 'text-app-text-muted hover:text-yellow-500'}`} title="Pin" aria-label="Pin message">
                <Pin size={14} />
              </button>
              {msg.role === 'assistant' && onRemember && (
                <button onClick={() => onRemember(msg)} className="w-7 h-7 flex items-center justify-center text-app-text-muted hover:text-purple-500 rounded" title="Remember this" aria-label="Save to memory">
                  <Brain size={14} />
                </button>
              )}
              {msg.role === 'assistant' && onRegenerate && !msg.partial && (
                <button
                  onClick={() => onRegenerate(msg)}
                  className={actionBtnClass}
                  title="Regenerate"
                  aria-label="Regenerate response"
                  data-testid="msg-action-regenerate"
                >
                  <RotateCw size={14} />
                </button>
              )}
              {onDeleteMessage && !msg.partial && (
                <button
                  onClick={handleDeleteClick}
                  className={`h-7 flex items-center justify-center rounded transition-colors ${
                    deleteArmed
                      ? 'px-1.5 gap-1 text-red-600 dark:text-red-400 bg-red-500/10 text-[11px] font-medium'
                      : 'w-7 text-app-text-muted hover:text-red-500'
                  }`}
                  title={deleteArmed ? 'Click again to delete' : 'Delete'}
                  aria-label={deleteArmed ? 'Confirm delete' : 'Delete message'}
                  data-testid="msg-action-delete"
                >
                  <Trash2 size={14} />
                  {deleteArmed && 'Delete?'}
                </button>
              )}
            </div>
          )}
          {isEmojiOnly(msg.content) ? (
            <div className="text-[32px] leading-none py-0.5">
              {msg.content.trim()}
            </div>
          ) : (
          <div
            // Assistant replies are no longer wrapped in a card (no bg, no
            // padding, no rounding) so long responses get the full row width
            // to breathe — only the user's own messages keep the bubble look.
            //
            // Nemmeno un turno FALLITO viene più incorniciato per intero. La
            // scatola ambra qui dentro avvolgeva tutto — prosa, cronologia dei
            // tool, media — e si accendeva guardando `content`, che è la colonna
            // che il client NON stampa quando ci sono i blocchi: il risultato
            // erano turni riusciti bordati di giallo senza una parola che
            // dicesse perché. Il verdetto ora è una riga sua, in cima al
            // contenuto (`TurnErrorBanner` in MessageContent).
            className={`text-[13px] leading-relaxed overflow-hidden ${
              msg.role === 'user'
                // Grigio di sistema, non il blu del marchio: in quest'app il
                // blu è l'accento delle azioni e del caricamento, e un
                // messaggio non è un'azione. Stessa regola per cui la
                // selezione è neutra. Niente `shadow-sm`: su un grigio chiaro
                // l'ombra sporca invece di staccare — basta il gradino di
                // tinta.
                ? `px-3 py-2 user-bubble bg-app-user-bubble text-app-text ${grouped ? 'rounded-2xl rounded-tr-md' : 'rounded-2xl'}`
                : 'text-app-text'
            }`}
            style={{ fontSize: `${fontSize}px`, overflowWrap: 'break-word', wordBreak: 'break-word' }}
          >
            <div className="message-content">
              <MessageContent
                content={msg.content}
                role={msg.role}
                thinking={msg.thinking}
                toolCalls={msg.toolCalls}
                blocks={msg.blocks}
                media={msg.media}
                partial={msg.partial}
                isLast={isLast}
                turnStartedAt={Date.parse(msg.timestamp)}
                usagePromptTokens={msg.usagePromptTokens}
                cacheReadTokens={msg.cacheReadTokens}
                cacheCreationTokens={msg.cacheCreationTokens}
                cacheCreation1hTokens={msg.cacheCreation1hTokens}
                usageCompletionTokens={msg.usageCompletionTokens}
                costCents={msg.costCents}
                onPlanDecision={onPlanDecision}
                sessionKey={topic.sessionKey}
                messageId={msg.id}
                onMessage={onMessage}
              />
            </div>
          </div>
          )}
          {/* Il bottone che rimanda il messaggio rimasto senza risposta.
              `handleRetry` (ChatPane) ripesca l'ultimo turno dell'utente e lo
              rispedisce: è il motivo per cui i cartelli d'errore possono
              permettersi di dire «il tuo messaggio è ancora qui».
              Il cancello NON è «c'è un errore»: è «c'è SOLO un errore». Un turno
              che ha risposto e poi è inciampato non si ripara rimandandolo — se
              ne farebbe un secondo, a pagamento, sopra uno che è già lì. Il
              cartello dice che qualcosa è andato storto; solo l'assenza di
              lavoro dice che c'è da rifarlo. */}
          {onRetry && msg.role === 'assistant' && turnIsOnlyError(msg) && (
            <button
              onClick={onRetry}
              data-testid="message-retry"
              title={tr('msg.resend')}
              className="mt-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-amber-100 dark:bg-amber-800/40 text-amber-800 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-700/50 transition-colors"
            >
              ↻ {tr('common.retry')}
            </button>
          )}
          {/* Queued indicator for offline messages */}
          {msg.role === 'user' && (msg.queued || msg.partial) && (
            <div className="text-[11px] text-amber-500 mt-0.5 text-right">
              Queued
            </div>
          )}
          {/* Branch navigation arrows */}
          {onSwitchBranch && msg.siblingCount != null && msg.siblingCount > 1 && (
            <div className={`flex items-center gap-1 mt-0.5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <button
                onClick={() => {
                  const current = msg.activeBranchIndex ?? 0;
                  if (current > 0) onSwitchBranch(msg.id, current - 1);
                }}
                disabled={(msg.activeBranchIndex ?? 0) === 0}
                className="w-5 h-5 flex items-center justify-center text-app-text-muted hover:text-app-text disabled:opacity-30 disabled:cursor-default rounded transition-colors"
                aria-label="Previous branch"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="text-[11px] text-app-text-muted font-medium tabular-nums min-w-[2ch] text-center">
                {(msg.activeBranchIndex ?? 0) + 1}/{msg.siblingCount}
              </span>
              <button
                onClick={() => {
                  const current = msg.activeBranchIndex ?? 0;
                  if (current < (msg.siblingCount ?? 1) - 1) onSwitchBranch(msg.id, current + 1);
                }}
                disabled={(msg.activeBranchIndex ?? 0) >= (msg.siblingCount ?? 1) - 1}
                className="w-5 h-5 flex items-center justify-center text-app-text-muted hover:text-app-text disabled:opacity-30 disabled:cursor-default rounded transition-colors"
                aria-label="Next branch"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
          {/* La riga di servizio del messaggio: l'ora e — sulle risposte finite
              — durata, token e costo, che prima erano una SECONDA riga sempre
              accesa sopra questa (e su pane strette andava pure a capo, perché
              le voci sono fino a sei).
              Sta IN FLUSSO, e ci è tornata dopo un giro sbagliato.
              Era stata messa fuori flusso (`absolute top-full`) per non
              prendersi ~18px invisibili sotto ogni messaggio — un peso che
              contava quando ogni singola tool call era un MESSAGGIO suo, cioè
              venti righe per turno. Da quando le corse di tool si fondono in un
              item solo (`coalesceToolRun`) le righe per turno sono tre, e il
              conto non regge più il prezzo: fuori flusso questa riga finiva
              SOPRA il messaggio successivo, e da quando porta anche durata,
              token e costo la sovrapposizione si legge benissimo.
              Fra uno spazio onesto e una riga che copre il testo di sotto si
              sceglie lo spazio. `min-h` fissa: la riga occupa la stessa altezza
              accesa e spenta, quindi il passaggio del mouse non rimisura niente
              — che era l'altra metà del motivo per cui era finita fuori flusso.
              Mai a capo: se un giorno non ci sta, scorre. */}
          {/* La riga esiste per i numeri del TURNO. Su una corsa di sola azione
              non ce ne sono — la durata di ogni passo sta già in fondo alla sua
              riga di tool — e da quando i messaggi di solo lavoro si fondono
              ognuna di quelle corse è un messaggio: si riservavano quattordici
              pixel ciascuna per ripetere in hover un numero già in chiaro.
              Il confine è avere i numeri, non avere la prosa: un turno fermo su
              una domanda è senza prosa ma si CHIUDE come un messaggio finito,
              con la sua durata e il suo costo, e quella riga gli serve. */}
          {(!isWorkOnlyAssistant(msg) || hasTurnMetrics) && msg.timestamp && !(msg.role === 'user' && (msg.queued || msg.partial)) && (
            <div
              data-testid="message-meta-row"
              className={`text-[11px] mt-0.5 min-h-[14px] transition-opacity flex items-center gap-1.5 whitespace-nowrap overflow-x-auto scrollbar-none ${
                msg.role === 'user' ? 'justify-end' : 'justify-start'
              } ${
                // La riga di servizio (ora, durata, costo) e' una delle cose che
                // sul desktop si vedono AL PASSAGGIO DEL MOUSE: su touch stava
                // sempre accesa a opacity-60 sotto ogni bolla. Segue lo stesso
                // gesto della barra azioni — tieni premuto e compare tutto cio'
                // che il mouse rivelerebbe, invece di due meta-informazioni
                // stampate addosso a ogni messaggio.
                // Qui e' TESTO, non un comando: il ramo senza puntatore non ha
                // bisogno di `pointer-events-none` (non c'e' niente da colpire)
                // e segue `showActions`.
                hasHover
                  ? hoverRevealClass(true)
                  : showActions ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <span className="text-app-placeholder flex-shrink-0">{formatTimestamp(msg.timestamp)}</span>
              {msg.role === 'assistant' && !msg.partial && (
                <MessageMetaFooter
                  variant="inline"
                  latencyMs={msg.latencyMs}
                  promptTokens={msg.usagePromptTokens}
                  cacheReadTokens={msg.cacheReadTokens}
                  cacheCreationTokens={msg.cacheCreationTokens}
                  cacheCreation1hTokens={msg.cacheCreation1hTokens}
                  model={msg.model}
                  completionTokens={msg.usageCompletionTokens}
                  costCents={msg.costCents}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
