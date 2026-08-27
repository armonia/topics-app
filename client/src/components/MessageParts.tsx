import { costTokens, partsFromMessage } from '../../../shared/token-cost';
import { useT } from '../hooks/useT';
import { useEffect, useState } from 'react';
import { WaveLoader } from './Layout/StreamingIndicator';
import { MessageMetaFooter } from './Chat/MessageMetaFooter';
import { turnClock, formatTurnElapsed } from '../state/turnClock';
import { phraseAt } from '../lib/thinkingPhrases';
import { cacheBreakdown } from '../lib/cacheBreakdown';
import { formatTokens } from '../lib/formatTokens';
import type { WSMessage } from '../types';

/**
 * Il title del contatore vivo: quante chiamate, e da dove vengono quei token.
 *
 * Le chiamate spiegano perché il numero supera la finestra di contesto; lo
 * scorporo spiega che quasi tutto è lo STESSO prompt riletto. Le due voci
 * sommano a `promptTokens`, con le scritture in cache contate coi nuovi —
 * erano token freschi, pagati di più per essere memorizzati.
 */
function liveUsageTitle(u: {
  calls: number;
  promptTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreation1hTokens?: number;
}): string {
  const calls = `${u.calls} chiamat${u.calls === 1 ? 'a' : 'e'} al modello finora. I token letti comprendono il prompt riletto a ogni chiamata`;
  const bd = cacheBreakdown({
    promptTokens: u.promptTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheCreationTokens: u.cacheCreationTokens,
    cacheCreation1hTokens: u.cacheCreation1hTokens,
  });
  if (!bd.known) return calls;
  return `${calls}\n\n${bd.read.toLocaleString()} riletti dalla cache · ${bd.newTokens.toLocaleString()} nuovi`;
}

// The old ToolCallBadge (colored bordered pill + raw JSON args) lived here.
// Every tool render — blocks timeline, legacy bucket AND inline contentOffset
// tools — now goes through <ToolCallRow>, the single compact row + typed-card
// language (chat-rendering-parity).

/**
 * The live "assistant is working" line. Replaces the old three bouncing dots
 * AND the generic spinner + "Streaming..." row with one consistent element for
 * the whole turn: a softly glowing dot, a playful phrase that rotates every
 * few seconds, and a running turn timer. It is rendered at the current bottom
 * of the turn, so the elapsed reads "right here, right now" — under whatever
 * step is active (thinking or the streaming prose). Per-tool steps keep their
 * own <ElapsedTimer>.
 *
 * `since` is the turn start (ms epoch); may be undefined/NaN if the message
 * timestamp is unparseable, in which case elapsed starts from mount. Both the
 * phrase and the timer advance off a single 1s tick; `elapsed` is derived
 * during render (no Date.now() at render time — react-hooks/purity, same
 * shape as ElapsedTimer).
 */
export function TurnActivityIndicator({
  since,
  sessionKey,
  onMessage,
  awaitingInput,
  promptTokens,
  completionTokens,
  costCents,
  cacheReadTokens,
  cacheCreationTokens,
  cacheCreation1hTokens,
}: {
  since?: number;
  /** Serve solo per lo stato "lento": senza, l'indicatore resta quello normale. */
  sessionKey?: string;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  /**
   * I numeri del turno in corso, presi dal MESSAGGIO e non da un'iscrizione
   * propria. Prima questa riga si iscriveva a `stream:usage` da sé e teneva i
   * totali in uno stato locale: il frame passa una volta e nessuno lo
   * conserva, quindi chi montava dopo — pane aperta a turno già iniziato,
   * cambio di tab, qualunque remount — non vedeva più comparire né token né
   * costo. Ora li scrive `useChat` sulla riga, che ai remount sopravvive.
   */
  promptTokens?: number | null;
  completionTokens?: number | null;
  costCents?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  cacheCreation1hTokens?: number | null;
  /**
   * Il turno è fermo su una domanda all'umano (un tool in `waiting_for_input`).
   * Tecnicamente il turno è ancora vivo — il messaggio resta `partial` — ma
   * "sto elaborando" con la frase che ruota e il puntino che pulsa è una bugia:
   * la palla è dall'altra parte. Qui la riga smette di fare finta di lavorare e
   * dice quello che sta davvero succedendo, in tono d'attesa.
   */
  awaitingInput?: boolean;
}) {
  const tr = useT();
  const [now, setNow] = useState(() => Date.now());
  // `awaitingInput` è fra le dipendenze perché l'apertura e la chiusura di
  // un'attesa si misurano su `now`: rileggere l'orologio subito al cambio fa
  // partire il conto dell'attesa dall'istante giusto invece che dall'ultimo
  // battito. Resta un arrotondamento sotto il secondo sulla chiusura — su
  // un'attesa che si misura in minuti non si vede.
  useEffect(() => {
    // Il battito si aggancia al CONFINE del secondo del turno, non parte quando
    // capita.
    //
    // Un `setInterval(1000)` avviato a metà secondo aggiorna sempre a metà
    // secondo: il numero a schermo, che è a secondi interi, cambia con uno
    // sfasamento fisso rispetto al tempo vero, e su una macchina carica il
    // timer slitta ancora — due tick nello stesso secondo (il numero ripete) o
    // uno saltato (il numero salta due). È l'altra metà del «non scorre live»:
    // non era fermo, era fuori fase. Riallineandosi a ogni giro, la cifra
    // cambia quando cambia il secondo.
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const adesso = Date.now();
      setNow(adesso);
      const origine = since != null && Number.isFinite(since) ? since : adesso;
      const atNext = 1000 - ((adesso - origine) % 1000);
      t = setTimeout(tick, atNext);
    };
    tick();
    return () => clearTimeout(t);
  }, [since, awaitingInput]);

  // Stream lento: `stream:slow` lo accende, `stream:resumed` lo spegne.
  //
  // Il server annunciava già entrambi e NESSUNO li ascoltava; al loro posto
  // appendeva un'annotazione al CONTENUTO del messaggio, che se il turno si
  // chiudeva mentre era lento restava dentro per sempre e tornava al modello a
  // ogni turno successivo (64 messaggi così nel DB reale). L'indicatore è il
  // posto giusto: vive quanto il turno e sparisce con lui.
  //
  // L'iscrizione sta QUI e non cinque livelli più su perché `MessageContent` già
  // riceve `sessionKey` e `onMessage`: uno stato transitorio di un elemento non
  // ha motivo di attraversare l'albero come prop.
  const [slow, setSlow] = useState(false);
  // I DUE FATTORI del costo, presi dal filo mentre il turno lavora.
  //
  // `calls` = quante volte il modello è stato chiamato in questo turno (una per
  // ogni tool). `context` = quanto era grande il prompt dell'ultima chiamata.
  // Il costo del turno è il loro PRODOTTO, e finché stavano in due tooltip
  // diversi nessuno lo faceva: con 320k in pancia dieci chiamate sono 3,2M, e
  // ci si accorgeva della cifra a spesa finita.
  //
  // Su un remount ricominciano dal frame dopo, come prima: sono numeri del
  // turno VIVO. I totali che devono sopravvivere — token, cache, costo —
  // continuano ad arrivare dalla riga del messaggio.
  const [calls, setCalls] = useState(0);
  const [context, setContext] = useState(0);
  useEffect(() => {
    if (!onMessage || !sessionKey) return;
    return onMessage((msg: WSMessage) => {
      if (!('sessionKey' in msg) || msg.sessionKey !== sessionKey) return;
      if (msg.type === 'stream:slow') setSlow(true);
      else if (msg.type === 'stream:resumed') setSlow(false);
      else if (msg.type === 'stream:usage') setCalls(msg.calls ?? 0);
      else if (msg.type === 'stream:context') setContext(msg.usage?.used ?? 0);
    });
  }, [onMessage, sessionKey]);

  // Il turno cambia ⇒ il conto riparte. Senza, un secondo turno erediterebbe le
  // chiamate del primo finché non arriva il suo primo frame di consumo.
  //
  // Azzerato in RENDER, non in un effect: un effect ridisegnerebbe una volta col
  // numero del turno vecchio prima di correggersi — un lampeggio del conteggio a
  // ogni turno nuovo. È il pattern React per "aggiustare lo stato quando cambia
  // una prop": si confronta con l'ultimo valore visto e si riparte subito.
  const [usageTurn, setUsageTurn] = useState(since);
  if (usageTurn !== since) {
    setUsageTurn(since);
    setCalls(0);
  }
  // I totali di adesso, come li porta la riga — e il numero mostrato è QUANTO
  // È COSTATO, la stessa regola della card, del grafico e del piede di un
  // messaggio (`shared/token-cost.ts`). Qui c'era `prompt + completion`, cioè
  // la rilettura di cache a prezzo pieno: la stessa formula che rendeva questa
  // striscia e la card due numeri diversi per lo stesso turno.
  const liveTokens = costTokens(partsFromMessage({
    usagePromptTokens: promptTokens, usageCompletionTokens: completionTokens, cacheReadTokens,
  }));

  // Da quando aspetta noi, e quanto ha aspettato in tutto in questo turno.
  //
  // Stessa forma dell'azzeramento del consumo qui sopra: si aggiusta lo stato in
  // RENDER confrontandolo con l'ultimo valore visto, non in un effetto. Gli
  // orologi si leggono da `now`, il battito che già scandisce la striscia: un
  // `Date.now()` in fase di render sarebbe impuro (React ridisegna quando vuole,
  // e in StrictMode due volte). Il prezzo è che l'inizio dell'attesa si arrotonda
  // al battito, cioè meno di un secondo su un'attesa che si misura in minuti.
  const isWaiting = !!awaitingInput;
  const [waitTurn, setWaitTurn] = useState(since);
  const [waitStartedAt, setWaitStartedAt] = useState<number | null>(isWaiting ? now : null);
  const [waitedMs, setWaitedMs] = useState(0);
  if (waitTurn !== since) {
    // Turno nuovo: conti azzerati. Se nasce già in attesa, l'attesa parte adesso.
    setWaitTurn(since);
    setWaitStartedAt(isWaiting ? now : null);
    setWaitedMs(0);
  } else if (isWaiting && waitStartedAt == null) {
    setWaitStartedAt(now);
  } else if (!isWaiting && waitStartedAt != null) {
    // L'attesa si chiude: il suo pezzo va nel totale, così il turno che riparte
    // non se la porta dentro al tempo di lavoro.
    setWaitedMs(waitedMs + Math.max(0, now - waitStartedAt));
    setWaitStartedAt(null);
  }

  const base = since != null && Number.isFinite(since) ? since : now;
  const elapsed = Math.max(0, now - base);
  // L'attesa dell'umano vince su "lento": se il turno è fermo su una domanda,
  // uno stream che non produce token è la normalità, non un sintomo.
  const state = awaitingInput ? 'waiting' : slow ? 'slow' : 'working';
  const clock = turnClock({
    elapsedMs: elapsed,
    waitedMs,
    waitingMs: state === 'waiting' && waitStartedAt != null ? Math.max(0, now - waitStartedAt) : null,
  });
  const label =
    state === 'waiting'
      ? 'in attesa della tua risposta'
      : state === 'slow'
        ? 'stream lento, il provider è ancora connesso'
        // La frase di fatica cresce col LAVORO, non col totale: dopo mezz'ora di
        // attesa nostra il turno non deve ripartire da «ci sto ancora mettendo
        // parecchio» per una cosa cominciata due secondi fa.
        : `${phraseAt(clock.workedMs)}…`;
  return (
    <>
    <div
      data-testid="chat-streaming-indicator"
      data-slow={state === 'slow' ? 'true' : undefined}
      data-waiting={state === 'waiting' ? 'true' : undefined}
      className="flex items-center gap-2 mt-1 text-[11px] leading-none select-none"
      role="status"
      aria-live="polite"
      aria-label={
        state === 'waiting'
          ? tr('turn.waitingYou')
          : state === 'slow'
            ? tr('turn.slow')
            : tr('turn.working')
      }
    >
      {/* LO STESSO glifo della sidebar e delle tab: la matrice che si accende
          cella per cella mentre lavora, e la stessa matrice ferma in ambra
          quando la palla è dell'umano. Qui c'era un pallino che pulsava — un
          terzo linguaggio per dire la cosa che le altre due superfici dicevano
          già a modo loro, e da fuori la chat sembravano stati diversi. Il glifo
          vive in un posto solo (`StreamingIndicator`), così non possono più
          divergere. Lo stato "lento" tiene il pallino ambra: è l'unico che NON
          è «sta lavorando», ed è giusto che si distingua. */}
      {state === 'slow' ? (
        <span className="turn-activity-dot inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-amber-500" />
      ) : (
        <WaveLoader className="shrink-0" still={state === 'waiting'} />
      )}
      <span
        // `turn-activity-phrase` è lo shimmer del lavoro in corso: dipinge il
        // testo con un gradiente in `background-clip` e mette il fill a
        // trasparente, quindi qualunque colore Tailwind sopra sparirebbe. Negli
        // stati d'attesa la classe non si mette proprio — così l'ambra si vede
        // e l'animazione non suggerisce un'attività che non c'è.
        className={
          state === 'working'
            ? 'turn-activity-phrase font-medium'
            : 'font-medium text-amber-600 dark:text-amber-400'
        }
        data-testid="turn-phrase"
      >
        {label}
      </span>
      {/* Mentre la domanda aspetta, accanto a «in attesa della tua risposta»
          NON ci va nessun numero. Anche fermo, un cronometro lì è un pezzo di
          cronaca in mezzo a una richiesta: chi legge lo prende per il tempo che
          sta facendo aspettare, e la domanda diventa un conto alla rovescia.
          Il lavoro fatto finora non sparisce — scende nella striscia di
          chiusura qui sotto, al posto dov'è sempre stato in un messaggio
          finito, con la sua spiegazione nel tooltip. */}
      {state !== 'waiting' && (
        <span
          className="tabular-nums text-app-text-muted shrink-0"
          data-testid="turn-timer"
          // Che cosa sta contando questo numero: il totale (turno senza attese)
          // o il lavoro al netto delle attese già chiuse.
          data-clock={clock.totalWaitedMs > 0 ? 'worked' : 'total'}
          title={clock.title}
        >
          · {formatTurnElapsed(clock.primaryMs)}
        </span>
      )}
      {/* Mentre la domanda aspetta, i numeri NON stanno qui: scendono nella
          striscia di chiusura qui sotto, che è la stessa di un messaggio
          finito. Lasciarli anche in riga li direbbe due volte. */}
      {/* IL MOLTIPLICATORE, in chiaro e mentre lavora: `12 × 309k`.
          Non è una decorazione del totale accanto — è la sua CAUSA. Il totale
          dice quanto è già andato; questo dice che la prossima chiamata costa
          ancora 309k, quindi è l'unico dei due su cui si può ancora decidere
          (fermare, compattare, aprire una chat nuova). Finora i due fattori
          stavano separati e muti: le chiamate in un tooltip qui, il contesto
          nell'anello del composer, e il loro prodotto da nessuna parte.
          Sta PRIMA del totale perché si legge come una moltiplicazione che
          finisce nel numero dopo. */}
      {calls > 0 && context > 0 && state !== 'waiting' && (
        <span
          className="tabular-nums text-app-text-muted shrink-0"
          data-testid="turn-multiplier"
          data-calls={calls}
          data-context={context}
          title={tr('turn.multiplier', { calls, ctx: formatTokens(context), total: formatTokens(calls * context), unit: calls === 1 ? tr('turn.call') : tr('turn.calls') })}
        >
          · {calls} × {formatTokens(context)}
        </span>
      )}
      {liveTokens > 0 && state !== 'waiting' && (
        <span
          className="tabular-nums text-app-text-muted shrink-0"
          data-testid="turn-usage"
          // Lo scorporo della cache sta nel title e non nella riga: spiega che
          // quasi tutti i letti sono lo STESSO prompt riletto, ma la striscia
          // deve restare una riga. A turno finito passa in chiaro nella
          // striscia del messaggio (`MessageMetaFooter`), dove c'e' spazio per
          // mandarlo a capo. Le chiamate invece sono uscite dal tooltip: sono
          // il moltiplicatore qui accanto.
          title={liveUsageTitle({
            calls,
            promptTokens: promptTokens ?? undefined,
            cacheReadTokens: cacheReadTokens ?? undefined,
            cacheCreationTokens: cacheCreationTokens ?? undefined,
            cacheCreation1hTokens: cacheCreation1hTokens ?? undefined,
          })}
        >
          · {formatTokens(liveTokens)} token
          {costCents != null && costCents > 0
            ? ` · ${costCents / 100 >= 1 ? `$${(costCents / 100).toFixed(2)}` : `$${(costCents / 100).toFixed(4)}`}`
            : ''}
        </span>
      )}
    </div>
    {/* Un turno fermo su una domanda si CHIUDE come un messaggio qualunque.
        Tecnicamente non è finito — la riga resta `partial`, il processo è vivo
        e aspetta — ma a schermo restava a mezz'aria: niente striscia di
        chiusura, i numeri in un formato tutto suo, e la sensazione di un
        messaggio lasciato aperto invece che di un turno consegnato in attesa
        di una risposta. Qui sotto va la STESSA striscia del messaggio finito,
        coi numeri di adesso: durata a parte (la porta il cronometro fermo qui
        sopra, con la sua spiegazione), letti, quota di cache e costo.
        Quando la risposta arriva il turno riparte e questa sparisce da sé. */}
    {state === 'waiting' && (
      <MessageMetaFooter
        latencyMs={clock.primaryMs}
        latencyTitle={clock.title}
        // Il numero va NOMINATO, o si legge come il tempo che stai facendo
        // perdere: è il lavoro fatto finora, e finché la domanda è aperta non
        // cresce di un millisecondo.
        latencyPrefix="lavorato"
        promptTokens={promptTokens}
        completionTokens={completionTokens}
        costCents={costCents}
        cacheReadTokens={cacheReadTokens}
        cacheCreationTokens={cacheCreationTokens}
        cacheCreation1hTokens={cacheCreation1hTokens}
      />
    )}
    </>
  );
}
