/**
 * The restart gate: what is still working, and the wait that ends when it is safe to stop.
 */
import { cardTurnsHoldingReload, chatGraceMs, chatsHolding, describeInFlight, dispatchDoor, sharedWait, splitOnPerson, turnComesBack as turnComesBackDecision, unadoptableStreams, unfinishedStreams, quiescenceVerdict, reloadHeldNotice, unrecoverableHolders } from "../lib/quiescence";
import { chatsParkedOnQuestion, PARKED_ASK_HOLD_MS } from "../lib/parked-asks";
import { touchReloadDeferred, clearReloadDeferred } from "../lib/reload-deferred";
import { countBusyAgentTerminals } from "../routes/terminal";
import { tryGetProvider } from "../providers";
import { aiBridgeEnabled } from "../providers/claude-code";
import { getAiBridgeClient } from "../lib/ai-bridge-client";
import { recordSystemNotice } from "../attention/system-notices";
import { askStillPolled, pendingAskKeys } from "../lib/ask-user-bridge";
import { decodeCol } from "../../shared/message-blob";
import type { AfterDispatcher } from "./scope";
import { late } from "./late";

export function bootQuiescence(
  scope: AfterDispatcher,
  /** What the gate asks of the outside, replaceable so a test can say what the broker keeps open and whether the bridge is on. */
  probes: { brokerOpenTurns?: () => Promise<string[]>; bridgeOn?: () => boolean } = {},
) {
  const bridgeOn = probes.bridgeOn ?? aiBridgeEnabled;
  const { activeStreams, ctx, deliveryOnlyWaitsOnChecks, landingQueue, taskDispatcher } = scope;
  // Quiescence gate: a PLANNED restart (approve self-restart, or an explicit
  // restart-when-idle request) must not cut an agent mid-turn. Poll the
  // dispatcher's in-flight count until it drains, capped so a stuck/very long
  // turn can't wedge the restart forever — past the cap we proceed and the
  // reload-resilience path resumes whatever was still running. Only for
  // CONTROLLED restarts; raw SIGTERM/SIGINT (OS shutdown) stay fast.
  //
  // IL TETTO STA SOPRA LA DURATA DI UN TURNO, NON SOTTO.
  //
  // Un turno d'agente aveva un limite suo — `dispatchTimeoutMin`, 20 minuti di
  // default (`tasks.ts`) — e questo cap serviva a stargli SOPRA. Quel tetto oggi
  // non taglia piu' niente (server.ts:1094, «reporting only, no cut»), quindi il
  // numero qui sotto non e' piu' «sopra il limite del turno»: e' solo la soglia
  // oltre cui un'attesa smette di essere muta.
  // A cinque minuti stava sotto, e il cancello scritto per non tagliare i
  // turni li tagliava quasi sempre: misurato il 19/08, salvato un file di
  // `server/` con quattro agenti `working`, cinque minuti dopo tutti e quattro
  // «Il server e' ripartito mentre l'agent lavorava: task rimesso in coda».
  //
  // Il tentativo non si perde (viene fatto il rollback) e nemmeno il lavoro gia'
  // committato sul ramo. Si perde il turno: quello che l'agente stava scrivendo,
  // e il tempo. Con venticinque minuti un turno sano arriva in fondo da solo, che
  // e' l'unico esito in cui questo cancello ha fatto il suo mestiere.
  //
  // La stessa variabile la legge `scripts/start-prod.sh` per la propria finestra
  // d'attesa: erano due numeri in due file che dovevano dire la stessa cosa.
  /** L'attesa quando a lavorare e' solo una CHAT (nessuna card in volo). Corta di
   *  proposito: una chat la reload-resilience la riadotta, e con l'attesa lunga il
   *  hot-reload non scatterebbe mai mentre si sviluppa. */
  const QUIESCENCE_CHAT_CAP_MS = Math.max(10_000, Number(process.env.TOPICS_QUIESCENCE_CHAT_CAP_MS) || 60_000);


  const QUIESCENCE_CAP_MS = Math.max(60_000, Number(process.env.TOPICS_QUIESCENCE_CAP_MS) || 25 * 60_000);

  /** Il broker si interroga a questa cadenza, non a ogni giro da 500ms: la sonda
   *  legge la coda dello store di OGNI sessione viva, e a 2Hz sarebbe un costo
   *  pagato per un'informazione che cambia di rado. */
  const QUIESCENCE_BROKER_PROBE_MS = 5_000;


  /**
   * Le sessioni di chat il cui TURNO è ancora aperto secondo il broker.
   *
   * È l'unico oracolo che vede un turno ADOTTATO. Dopo un riavvio la gamba di
   * riadozione (`runHeadlessReattach`) dura un attimo — è un replay muto — e
   * quando si chiude `endStream` toglie la voce da `activeStreams`. Da quel
   * momento, in QUESTO processo, non esiste più niente che rappresenti il figlio
   * CLI che sta ancora lavorando: `busyCount()` e `activeStreams` dicono «fermo»,
   * e lo dicono con verità. Solo lo store del broker sa che il figlio è vivo.
   *
   * Direzione del fallimento: se il broker non risponde si torna una lista VUOTA,
   * cioè non si trattiene il riavvio. È il verso opposto a quello del reap in
   * `reattachSurvivingChatTurns` — là il dubbio salvava un turno dall'essere
   * ucciso, qui il dubbio costerebbe un cancello che si inchioda su ogni riavvio
   * per un ponte rotto. Un SIGTERM, a differenza di un kill, il turno non lo
   * ammazza: il figlio sopravvive e viene riadottato.
   */
  async function openBrokerChatTurns(): Promise<string[]> {
    if (!aiBridgeEnabled()) return [];
    try {
      const sessions = await getAiBridgeClient().list();
      const live = sessions.filter((s) => s.alive && s.id.startsWith("topic:"));
      if (live.length === 0) return [];
      const prov = tryGetProvider("claude-code") as
        { brokerTurnState?: (sk: string) => Promise<"open" | "idle" | "unknown"> } | undefined;
      if (typeof prov?.brokerTurnState !== "function") return [];
      const open: string[] = [];
      for (const s of live) {
        // Niente `park: true`: quel flag è la promessa di riadottare subito, e qui
        // stiamo solo guardando.
        try { if (await prov.brokerTurnState(s.id) === "open") open.push(s.id); }
        catch { /* una sessione che non risponde non trattiene il riavvio */ }
      }
      return open;
    } catch { return []; }
  }


  let brokerProbeCache: { at: number; open: string[] } = { at: 0, open: [] };


  /**
   * IL TURNO DI QUESTA RIGA E' GIA' FINITO?
   *
   * `partial` e' il perno che ogni setaccio di boot gia' legge: vale 1 mentre il
   * turno scrive e 0 quando qualcuno lo ha finalizzato - bene, con un errore del
   * fornitore, o per mano di un cane da guardia. E' l'unico fatto su cui il
   * registro in memoria non ha voce, ed e' il registro ad aver mentito: il
   * 2026-09-03 `topic:6b9605e5` teneva il riavvio da 2160 secondi con un turno
   * morto da un pezzo di `400 prompt is too long`.
   *
   * Costo: una SELECT su chiave primaria per stream vivo, e gli stream vivi si
   * contano su una mano. Direzione del dubbio in `unfinishedStreams`: quello che
   * non si riesce a leggere continua a contare.
   */
  let turnFinishedStmt: ReturnType<typeof ctx.db.prepare> | null = null;

  function turnAlreadyFinished(messageId: string): boolean {
    if (!messageId) return false;
    turnFinishedStmt ??= ctx.db.prepare("SELECT partial FROM messages WHERE id = ?");
    const row = turnFinishedStmt.get(messageId) as { partial?: number } | undefined;
    // Riga assente: si continua a trattenere. Qui il dubbio protegge un turno
    // vivo dall'essere tagliato, e un riavvio in piu' che aspetta lo dichiara
    // subito e chiama una persona al minuto.
    if (!row) return false;
    return row.partial === 0;
  }


  let askProbeCache: { at: number; parked: string[] } = { at: 0, parked: [] };


  /**
   * Che cosa sta ancora lavorando — e perché il riavvio aspetta. `null` = niente.
   *
   * Il cancello guardava UN contatore solo: `taskDispatcher.busyCount()`, cioè
   * `inFlight.size`, una mappa chiavata sul taskId e scritta solo da `beginRun`
   * sul cammino di dispatch di una CARD. Una chat umana non è una card: non può
   * entrarci per costruzione, e infatti non ci entrava. Il 2026-08-18 il server
   * si è riavviato ~1,4 volte al minuto sopra un turno di chat vivo da quattordici
   * minuti senza che una sola riga `[quiescence]` comparisse nel log — il predicato
   * non era mai nemmeno entrato nel `while`. Il nome della rotta prometteva
   * «quando i turni finiscono»; manteneva «quando finiscono i turni della board».
   *
   * Ora le fonti sono tre, in ordine di costo: le card (contatore in RAM), le chat
   * che stanno streammando in QUESTO processo (`activeStreams`), e i turni
   * adottati che vivono solo nel broker. Le prime due sono gratis e si guardano a
   * ogni giro; la terza si paga, e si guarda ogni QUIESCENCE_BROKER_PROBE_MS.
   */
  /**
   * The turn on this session survives a restart (see `turnComesBack` in
   * `lib/quiescence.ts`): a native turn only when it runs in its own process,
   * any other when its provider re-adopts and the broker is on.
   */
  function turnComesBack(sessionKey: string): boolean {
    const native = tryGetProvider("topics") as unknown as { isTurnProcessAlive?: (sk: string) => boolean; turnRunsDetached?: (sk: string) => boolean } | undefined;
    const nativeTurn = native?.isTurnProcessAlive?.(sessionKey) === true;
    return turnComesBackDecision({
      bridgeOn: bridgeOn(),
      brokerKeeps: activeStreams.get(sessionKey)?.brokerKeeps === true,
      nativeTurn,
      nativeDetached: nativeTurn && native?.turnRunsDetached?.(sessionKey) === true,
    });
  }


  /**
   * Open turns, for the automatic land that reloads the server: the restart
   * gate's own predicate (cards and lands in flight, broker turns, chats parked on
   * a question) plus the chat streams and busy agent terminals. Counting less than
   * the gate lets a reload cut a turn the gate itself would have waited for.
   */
  async function autoLandTurnCount(opts?: { insideLand?: boolean }): Promise<number> {
    // Asked from within a land, that land is itself "in flight" for the gate, and
    // is not a turn it should wait for: it would never find the server idle.
    const working = await whatIsStillWorking({ ownLands: opts?.insideLand ? 1 : 0 });
    return (working.busy !== null ? 1 : 0) + activeStreams.size + countBusyAgentTerminals();
  }


  async function whatIsStillWorking(opts: { ownLands?: number } = {}): Promise<{ busy: string | null; cards: number; unadoptable: number; chats: number; workingChats: number; lostWorkingChats: number; working: boolean; waitingOnPerson: number; everyTurnComesBack: boolean; holder: string | null; holderKind: "turn" | "question" }> {
    // A land in flight is a card turn for this purpose: it rewrites main and
    // the card, and a restart in the middle of it forgets the delivery branch.
    //
    // A card turn PARKED ON OUR OWN CHECKS, with no command of ours running, is
    // not in this count: see `cardTurnsHoldingReload` for the 2026-09-15 wait it
    // closes. Its delivery is remembered and re-issued after the boot, so cutting
    // it loses nothing — while deferring for it froze the whole board.
    const { holding: cardTurnsAll, waiting: cardsWaitingOnChecks } =
      cardTurnsHoldingReload(taskDispatcher.busyTurns(), deliveryOnlyWaitsOnChecks);
    // A CARD WHOSE TURN COMES BACK DOES NOT HOLD (lossless-restart). Its turn
    // runs in a process the broker keeps (a detached native turn, or the CLI),
    // the boot finds it again through the dispatcher's `live` branch, and not a
    // round is redone. What still holds is a card whose turn lives in this
    // process, and a land, which rewrites main under the restart.
    const cardTurns = cardTurnsAll.filter((t) => !(t.sessionKey && turnComesBack(t.sessionKey)));
    // `ownLands`: the caller IS a land and does not count itself (the automatic land's last look).
    const cards = cardTurns.length + Math.max(0, landingQueue.inFlight() - (opts.ownLands ?? 0));
    // Those cards' own streams go with them. A card turn streams through
    // /api/chat, so its session is a stream key too, and left in it would hold
    // the restart a second time - as a chat on the native runtime, which is
    // unadoptable, which defers from the first loop.
    const waitingKeys = new Set(cardsWaitingOnChecks.map((t) => t.sessionKey).filter((k) => k !== ""));
    // NON LE CHIAVI DEL REGISTRO: quelle il cui TURNO e' ancora aperto. Una voce
    // rimasta dietro a un turno gia' finalizzato trattiene un riavvio per
    // nessuno, e nessuno puo' nemmeno sbloccarlo (vedi `turnAlreadyFinished`).
    //
    // E NON QUELLE FERME SU UNA PERSONA. Un turno bloccato su una domanda (o su un
    // permesso) a schermo e' vivo: il suo processo interroga il bridge, la sua
    // riga e' `partial = 1`. Ma non lavora, aspetta, ed e' la quarta fonte
    // (`parked` qui sotto) a dirlo. Contato anche come stream passava per «chat in
    // streaming» e per un turno che un riavvio perde: un'ora di domanda senza
    // risposta teneva `/__daemon/idle` a `idle: false`, e dieci ore dopo era
    // ancora li' (RGATE-12). Il registro in memoria del bridge e' quello giusto da
    // leggere: dice «aspetta una persona» nell'istante in cui lo e', e smette
    // nell'istante in cui qualcuno risponde, senza la coda di una sonda in cache.
    const unfinished = unfinishedStreams(activeStreams.values(), turnAlreadyFinished)
      .filter((s) => !waitingKeys.has(s.sessionKey));
    //
    // SOLO UNA DOMANDA, E SOLO SE IL SUO BRIDGE STA ANCORA INTERROGANDO. Non un
    // permesso: la sua decisione muore col turno (`endStream` lo chiude come
    // interrotto), quindi tagliare quel turno la perde, e resta fra chi lavora
    // come prima. E non una voce del registro che nessuno interroga piu': una
    // domanda viva e' interrogata ogni 25 s, una rimasta aperta dopo uno Stop o
    // dopo una risposta data fra due giri e' un residuo, e un residuo non deve
    // mai nascondere un turno che lavora (`askStillPolled`).
    const { working: liveStreams, onPerson: streamsOnPerson } = splitOnPerson(unfinished, (s) => s.sessionKey, (key) => askStillPolled(key));
    const streamKeys = liveStreams.map((s) => s.sessionKey);
    // La sonda del broker si paga, e si paga solo quando serve: se una fonte più
    // economica ha già detto «occupato», la risposta non cambia.
    let brokerOpen = brokerProbeCache.open;
    if (cards === 0 && streamKeys.length === 0) {
      const now = Date.now();
      if (now - brokerProbeCache.at >= QUIESCENCE_BROKER_PROBE_MS) {
        brokerProbeCache = { at: now, open: await (probes.brokerOpenTurns ?? openBrokerChatTurns)() };
      }
      brokerOpen = brokerProbeCache.open;
    }
    // Same reason as the streams above: a card whose turn lives in a broker child
    // must not come back as a chat once its delivery has stopped holding.
    brokerOpen = brokerOpen.filter((key) => !waitingKeys.has(key));
    // A turn the broker keeps is the same story one restart later: its child is
    // blocked on the same bridge call, and the broker's "open" is not "working".
    const { working: brokerWorking, onPerson: brokerOnPerson } = splitOnPerson(brokerOpen, (key) => key, (key) => askStillPolled(key));
    brokerOpen = brokerWorking;
    // QUALI DI QUESTE CHAT NON TORNANO PIÙ, se le tagliamo adesso.
    //
    // L'attesa corta riservata alle chat vale una promessa: «la reload-resilience
    // la riadotta». Quella promessa la mantiene solo un provider il cui turno vive
    // in un processo FIGLIO, che il SIGTERM non tocca e il broker ritrova. Il
    // runtime nativo `topics` esegue il turno dentro questo processo: quando muore,
    // muore il turno.
    //
    // La risposta è già sulla voce dello stream (`survivesRestart`, decisa quando
    // il turno è nato): qui si conta e basta, senza toccare il DB né il registro
    // dei provider — questo giro batte due volte al secondo.
    // CHI trattiene, non solo QUANTI. Serve per nominare la chat nella notifica
    // che il cancello manda oltre il tetto: un avviso che dice «una chat» manda a
    // cercare, uno che dice quale porta dove si decide (il click apre il topic).
    // Le non riadottabili per prime: sono quelle il cui lavoro non torna.
    const unadoptableKeys = unadoptableStreams(liveStreams);
    const unadoptable = unadoptableKeys.length;
    // THE FOURTH SOURCE: whoever is waiting for a PERSON. The three above answer
    // "who is WORKING", and a chat parked on a question is not working, so it
    // held nothing and the restart cut it. It holds the chat minute and no more:
    // the question outlives the restart (see `quiescenceVerdict`). Same economy as the broker probe: it reads rows, so
    // it is paid at the probe cadence, and not at all when a card is in flight
    // - there the verdict is already a deferral, and a STALE list must not
    // decide, since a question answered meanwhile would defer for nobody.
    let parked: string[] = [];
    if (cards === 0) {
      const now = Date.now();
      if (now - askProbeCache.at >= QUIESCENCE_BROKER_PROBE_MS) {
        askProbeCache = { at: now, parked: chatsParkedOnQuestion(ctx.db, decodeCol, { now, ttlMs: PARKED_ASK_HOLD_MS, fastPathKeys: pendingAskKeys() }) };
      }
      parked = askProbeCache.parked;
    }
    // Whoever the registry says is waiting joins the parked ones, whatever else
    // they are (a stream, a broker turn): one chat, one entry. Not only when no
    // card is in flight, like the rows above: it costs nothing and it keeps the
    // chat in `chats` (the door of the dispatcher reads it) instead of dropping it.
    const onPerson = [...streamsOnPerson.map((s) => s.sessionKey), ...brokerOnPerson];
    if (onPerson.length > 0) parked = [...new Set([...onPerson, ...parked])];
    const cardSessionKeys = taskDispatcher.busySessionKeys();
    return {
      busy: describeInFlight({ cards, streamKeys, brokerOpenKeys: brokerOpen, askOpenKeys: parked }),
      cards,
      unadoptable,
      // Every holder that is NOT a card: the streams of this process, the turns
      // the broker keeps, the chats parked on a question. `dispatchDoor` reads
      // this to decide whether refusing card turns buys the restart anything.
      // A card turn streams through /api/chat too, so its own session is taken
      // out here, or every card in flight would reopen the door by itself.
      chats: chatsHolding({ streamKeys, brokerOpenKeys: brokerOpen, parkedKeys: parked, cardSessionKeys }),
      // The same chats minus the ones parked on a question: the turns a restart
      // "at zero turns" waits for (see `unrecoverableHolders`).
      workingChats: chatsHolding({ streamKeys, brokerOpenKeys: brokerOpen, parkedKeys: [], cardSessionKeys }),
      // Of those, the ones a restart would cut: streams whose turn does not come
      // back. A broker-kept turn comes back by construction.
      lostWorkingChats: chatsHolding({ streamKeys: streamKeys.filter((k) => !turnComesBack(k)), brokerOpenKeys: [], parkedKeys: [], cardSessionKeys }),
      // Is anything COMPUTING right now? Cards, streams and broker turns, with the
      // chats that wait for a person left out: they hold the restart for the chat
      // minute (`busy`), but they are not work. This is what "idle" answers
      // (`GET /__daemon/idle`), because a machine is not busy while a person
      // thinks. A card's own stream counts here (its turn is a stream), as it
      // does in `busy`.
      working: cards > 0 || streamKeys.length > 0 || brokerOpen.length > 0,
      // The chats that wait for a person, apart from the card sessions.
      // A chat the rows say is parked but the registry has not yet confirmed (right
      // after a boot, before its child's next leg) is still counted as working
      // above: it is not counted here too.
      waitingOnPerson: chatsHolding({ streamKeys: [], brokerOpenKeys: [], parkedKeys: parked.filter((k) => !streamKeys.includes(k) && !brokerOpen.includes(k)), cardSessionKeys }),
      // Broker-kept turns and parked questions come back by construction; a
      // stream only if its turn does (a native one running in this process does not).
      // The parked streams count here too: what the restart does to their PROCESS
      // decides how long the gate waits (`chatGraceMs`), even though the question
      // itself survives on its row. Left out, a native turn running in this
      // process and parked on a question read as "everything comes back" and was
      // cut on the first lap, with no minute for the answer being typed.
      everyTurnComesBack: bridgeOn() && [...streamKeys, ...streamsOnPerson.map((s) => s.sessionKey)].every(turnComesBack),
      // STESSA PRIORITA' di `describeInFlight`, o la notifica nomina un soggetto
      // che non e' quello che trattiene: quando a trattenere e' una card la frase
      // parla di card, e qui non c'e' un topic da nominare — meglio `null` e il
      // ripiego su `busy` che il nome della prima chat che passa. Fra gli stream
      // vince la NON riadottabile: e' quella il cui lavoro non torna.
      holder: cards > 0 ? null : (unadoptableKeys[0] ?? streamKeys[0] ?? brokerOpen[0] ?? parked[0] ?? null),
      // WHICH GESTURE UNBLOCKS IT. The holder falls through to the parked list
      // only when the three "working" sources are empty, and that holder is a
      // chat waiting for a PERSON: the notice must ask for an answer, not for a
      // stop, or whoever reads it kills the turn the gate was protecting.
      holderKind: (cards === 0 && unadoptableKeys.length === 0 && streamKeys.length === 0 && brokerOpen.length === 0 && parked.length > 0)
        ? "question"
        : "turn",
    };
  }


  /**
   * ONE WAIT PER PROCESS, however many times somebody asks for a restart.
   *
   * The rule and the measurement that produced it live in `sharedWait`, pure and
   * covered by tests; here it is only applied. Before it, every
   * `POST /__daemon/restart-when-idle` started a loop of its own - with its own
   * start instant, its own `avvisato` flag and its own `waitId` - so N asks meant
   * N held-reload notices and N loops fighting over one `drain` token.
   */
  const attesaQuiescenza = sharedWait<void>();


  function waitForDispatcherQuiescent(label: string, capMs = QUIESCENCE_CAP_MS): Promise<void> {
    return attesaQuiescenza.join(() => runDispatcherQuiescentWait(label, capMs));
  }


  async function runDispatcherQuiescentWait(label: string, capMs = QUIESCENCE_CAP_MS): Promise<void> {
    // FIRST CLOSE THE DOOR. Every caller of this wait is a restart, and a wait
    // that lets the dispatcher keep starting turns behind a full cap never ends:
    // on 2026-09-04 `restart-when-idle` was still deferred after 18,482 s, three
    // card turns at a time, one starting as soon as one finished. From here on
    // no new card turn starts; the ones in flight finish, the queued ones keep
    // their sessions and the next process resumes them at boot.
    taskDispatcher.drain(label);
    // DUE SCADENZE, E TUTTE E DUE SONO TETTI VERI — contate dall'INIZIO
    // dell'attesa, non da «l'ultima volta che ho visto del lavoro».
    //
    // Prima la scadenza si RINNOVAVA a ogni giro con del lavoro in volo
    // (`deadline = max(deadline, now + capMs)`), e con una card sempre presente
    // non scadeva mai: simulato, dopo 2000 s la scadenza era ancora 1500 s più in
    // là. Non era un tetto, era una promessa infinita.
    //
    // COSA COSTAVA, misurato sul task 235afe11 il 20/08. Il server aspettava
    // senza fine; `start-prod.sh`, che di suo conta 1530 s DALL'INIZIO, arrivava
    // alla propria scadenza e sparava il SIGTERM su un turno vivo:
    //
    //     17:55:39  tentativo #1 parte
    //     18:22:46  il server riparte  (+27m)   → worktree buttato, task in coda
    //     18:23:12  tentativo #2 parte
    //     18:50:35  il server riparte  (+27m)   → di nuovo
    //     18:51:20  tentativo #3 parte
    //     19:18:07  SIGTERM            (+27m)   → «restart-when-idle accettato,
    //                                             ma il server è ancora vivo
    //                                             dopo 1530s — SIGTERM»
    //
    // Tre volte lo stesso task, a ventisette minuti esatti: la firma di un
    // orologio, non della sfortuna. E il cancello scritto per non tagliare i
    // turni non ha mai loggato una sola scadenza — perché non poteva scadere.
    //
    // Due orologi che si contraddicono sono peggio di un orologio solo troppo
    // stretto: quello che promette di aspettare non ferma il SIGTERM di quello
    // che ha smesso, e il turno muore comunque — ma senza che nessuno dei due
    // lo sappia. Ora il tetto è vero e il server esce DA SÉ, con `gracefulShutdown`
    // che gira per intero, prima che lo script perda la pazienza.
    const inizio = Date.now();
    let logged = false;
    let ultimoRinvioLoggatoS = -60;
    // Una sola chiamata per attesa: oltre il tetto il cancello avvisa una persona
    // invece di tagliare (vedi `reloadHeldNotice`). Ripeterlo ogni minuto sarebbe
    // rumore, e il log gia' lo fa per chi lo legge.
    let avvisato = false;
    // The door starts closed (`drain` above) and follows who is holding: see
    // `dispatchDoor`. Reopened while a chat holds, closed again the moment only
    // cards do - and closed before the final `break`, with one more look, so a
    // card cannot start in the gap between "nothing holds" and the shutdown.
    let doorClosed = true;
    for (;;) {
      const { busy, cards, unadoptable, chats, workingChats, lostWorkingChats, everyTurnComesBack, holder, holderKind } = await whatIsStillWorking();
      if (!busy) {
        if (!doorClosed) {
          taskDispatcher.drain(label);
          doorClosed = true;
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        break;
      }
      const door = dispatchDoor({ cards, chatsHolding: chats });
      if (door === "open" && doorClosed) {
        taskDispatcher.undrain(label);
        doorClosed = false;
      } else if (door === "closed" && !doorClosed) {
        taskDispatcher.drain(label);
        doorClosed = true;
      }
      // La REGOLA sta in `lib/quiescence.ts`, pura e provata: qui si applica.
      // Viveva dentro questo loop, e li' dentro nessun test poteva raggiungerla
      // senza avviare un server — che e' il motivo per cui il difetto del
      // rinnovo infinito e' sopravvissuto tanto a lungo.
      const unrecoverable = unrecoverableHolders({ cards, unadoptable, workingChats, lostWorkingChats, zeroTurns: late.restartAtZeroTurns });
      const verdetto = quiescenceVerdict({
        busy, unrecoverable,
        now: Date.now(), startedAt: inizio,
        // EVERYTHING STILL IN FLIGHT COMES BACK: no minute to wait. The minute
        // was for a chat that a restart cut and the boot resumed with a visible
        // pause; a turn the broker keeps is found again where it was, partial
        // text and open question included, so waiting buys nothing.
        chatCapMs: chatGraceMs({ unrecoverable, everyTurnComesBack, capMs: QUIESCENCE_CHAT_CAP_MS }),
      });
      // DUE ATTESE, PERCHE' SONO DUE DANNI DIVERSI.
      //
      // Un turno di CARD tagliato a meta' e' lavoro perso: l'agente stava
      // scrivendo file, e il turno non torna. Merita l'attesa lunga.
      //
      // Una CHAT che sta streammando no: la reload-resilience la riadotta, chi
      // guarda vede una pausa. Aspettarla quanto una card significa che il
      // hot-reload MUORE per chiunque abbia una conversazione aperta — cioe'
      // sempre, mentre si sviluppa. Misurato il 19/08 alzando il cap a 25
      // minuti: `restart-when-idle` rispondeva 202 e il server non usciva piu',
      // perche' a non drenare era la chat di chi stava lavorando.
      //
      // …SALVO QUANDO LA RIADOZIONE NON ESISTE. Quel «la riadotta» vale per un
      // turno che gira in un processo FIGLIO (claude-code): il SIGTERM non lo
      // tocca, il broker lo tiene, al riavvio torna. Un turno del runtime nativo
      // `topics` gira DENTRO questo processo, e quando il processo muore non c'e'
      // nessun figlio da riadottare: tagliarlo e' esattamente lo stesso danno di
      // una card tagliata, lavoro perso senza ritorno. Il 20/08, su
      // topic:9f9e9629, il cancello ha aspettato il suo minuto, ha concluso «la
      // riprendono» e ha ucciso una risposta a meta' frase che nessuno ha
      // ripreso. Quindi una chat NON riadottabile alza la scadenza come una card.
      //
      // IL PREZZO, MISURATO invece che stimato (94 blocchi di attivita' nativa
      // continua sul db vivo, 18-20/08):
      //
      //     cap      turni che arrivano in fondo    attesa media del reload
      //     1 min          19/94  (20%)                   0.8 min
      //     15 min         81/94  (86%)                   6.3 min
      //     25 min         84/94  (89%)                   7.6 min
      //
      // Col minuto di prima, QUATTRO TURNI NATIVI SU CINQUE venivano tagliati:
      // non era un caso sfortunato, era la norma. Quei numeri hanno smesso di
      // essere un tetto da scegliere e sono diventati la ragione per cui un turno
      // nativo non si taglia affatto: la colonna «arrivano in fondo» dice quanti
      // turni un orologio avrebbe ucciso, non quanto conviene aspettarli.
      //
      // E CHI ASPETTA NON VIENE MAI TAGLIATO. Per un turno che non torna
      // `quiescenceVerdict` non restituisce MAI "scaduto" — e' l'invariante del
      // 28/08, con un test che la fissa fino a `CAP * 10_000`. Qui c'era scritto
      // il contrario, e il commento sbagliato e' costato un'ora di indagine il
      // 30/08, quando il codice sembrava rotto perche' contraddiceva la riga
      // sopra di se'.
      //
      // IL TETTO LUNGO NON DECIDE PIU' NIENTE, E NON DEVE FINGERE DI FARLO
      // (2026-09-04). Restava come l'istante in cui il rinvio veniva DICHIARATO,
      // e siccome il verdetto era un rinvio prima e un rinvio dopo, quei
      // venticinque minuti non cambiavano un esito: cambiavano solo chi lo
      // sapeva. Il battito `touchReloadDeferred()` sta sul ramo del rinvio,
      // quindi fino al tetto non veniva scritto e `start-prod.sh` era libero di
      // sparare il proprio SIGTERM sul turno che questo cancello esiste per non
      // tagliare; e con lui restava ferma la notifica all'unica persona che puo'
      // finire l'attesa. Ora il rinvio si dichiara dal PRIMO giro, e `capMs`
      // sopravvive per una cosa sola: e' la soglia oltre cui si avvisa quando a
      // trattenere e' una CARD (vedi sotto).
      //
      // Quello che il cancello fa quando l'attesa non ha fine: smette di tacere.
      // Manda UNA notifica che nomina la chat che trattiene (`reloadHeldNotice`),
      // e la decisione resta a una persona. Il 30/08 un riavvio e' rimasto in
      // attesa 4599 secondi con la sola traccia in un log che nessuno guardava;
      // saputolo, l'utente l'ha sbloccato in cinque secondi. Un'attesa senza fine
      // e' accettabile, un'attesa MUTA no.
      //
      // La scadenza corta NON si rinnova a ogni giro: si conta dall'inizio
      // dell'attesa. Il rinnovo sembrava generoso — «una card che parte mentre
      // aspetto ha diritto all'attesa lunga» — ma era la ragione per cui questo
      // cancello non è mai scaduto una sola volta.
      if (verdetto === "rinvia") {
        // NON SI TAGLIA CHI NON TORNA. Si rinvia, e lo si dichiara: allo script,
        // con un battito su file, perche' altrimenti manda il SIGTERM al posto
        // nostro; e nel log, una riga al minuto, perche' un riavvio che non
        // arriva senza spiegazione e' peggio di uno che taglia.
        touchReloadDeferred();
        // OLTRE IL TETTO SI CHIAMA UNA PERSONA. Non si taglia — l'invariante
        // «un orologio non uccide lavoro che non torna» resta intera — ma
        // nemmeno si tace: il 30/08 un riavvio e' rimasto in attesa 4599s con la
        // sola traccia in un file che nessuno guardava, e l'utente l'ha sbloccato
        // in cinque secondi appena l'ha saputo. Best-effort: un registro che non
        // scrive non deve fermare l'attesa.
        // QUANDO AVVISARE DIPENDE DA CHI TRATTIENE, e sono due attese diverse.
        // Un turno di CARD finisce da solo e svegliare qualcuno al primo minuto
        // sarebbe rumore, quindi la sua soglia resta il tetto lungo.
        //
        // QUI C'ERA SCRITTO CHE A CHIUDERLO ERA `dispatchTimeoutMin`, VENTI
        // MINUTI. Non e' piu' vero da quando quel tetto e' stato declassato a
        // sola segnalazione (server.ts:1094: «reporting only, no cut»), e non lo
        // era comunque per il caso che ha prodotto l'attesa del 15/09: un turno
        // fermo su `update_task` con i check nostri in coda non ha nessun
        // orologio addosso — `isChecksHold` spegne anche il giudice di stallo.
        // Il limite vero e' ora dall'altra parte: un turno di card che trattiene
        // e' un turno con un COMANDO nostro in corso (gli altri non trattengono
        // piu', vedi `cardTurnsHoldingReload`), e quel comando ha il tetto di
        // `runReviewChecks`. Oltre il tetto lungo si chiama comunque una persona,
        // perche' un'attesa senza fine puo' essere accettabile ma MUTA no.
        // Una CHAT no: il turno nativo non ha nessun limite superiore, e a
        // finirlo puo' essere solo una persona - che al minuto sessanta e' gia'
        // l'unica cosa che puo' succedere, perche' e' li' che il cancello ha
        // deciso di non tagliare. Il 2026-09-04 quella notizia arrivava dopo
        // quindici minuti.
        //
        // La soglia si guarda PRIMA di comporre l'avviso: adesso il rinvio parte
        // dal primo giro, e cercare il nome del topic due volte al secondo per
        // tutta l'attesa sarebbe una lettura pagata per niente.
        const noticeAfterMs = cards > 0 ? capMs : QUIESCENCE_CHAT_CAP_MS;
        if (!avvisato && Date.now() - inizio >= noticeAfterMs) {
          const avviso = reloadHeldNotice({
            waitedMs: Date.now() - inizio,
            noticeAfterMs,
            busy,
            holderName: holder ? (ctx.getTopicBySessionKey(holder)?.name ?? null) : null,
            holderKind,
            waitId: `${label}:${inizio}`,
          });
          if (avviso) {
            avvisato = true;
            try {
              // The server's restart, not the chat's: a `system` row, one per wait (ATTN-10).
              recordSystemNotice({ key: "restart-held", cycle: avviso.dedupeKey, title: avviso.title, body: avviso.body });
            } catch (err) {
              console.warn("[quiescence] avviso di riavvio trattenuto non registrato:", err);
            }
          }
        }
        const attesaS = Math.round((Date.now() - inizio) / 1000);
        if (attesaS - ultimoRinvioLoggatoS >= 60) {
          ultimoRinvioLoggatoS = attesaS;
          console.warn(
            `[quiescence] ${label}: riavvio RINVIATO da ${attesaS}s — ${busy} ${late.restartAtZeroTurns ? "e il riavvio e' chiesto a zero turni (land)" : "non tornerebbe se lo tagliassi"}. ` +
            `Riparto appena finisce; per forzare adesso: launchctl kickstart -k gui/$(id -u)/com.armonia.topics-server`,
          );
        }
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if (verdetto === "scaduto") {
        // LA FRASE DICE LA VERITA' SU CHI SI STA TAGLIANDO, e sono tre sorti
        // diverse — non una.
        //
        // «la reload-resilience li riprende» era scritto per un turno che vive in
        // un processo FIGLIO: quello torna davvero. Ma qui ci passano anche le
        // CARD, e una card non viene riadottata: il dispatcher la rimette in coda
        // e il suo turno riparte DA CAPO (il worktree sopravvive, il turno no).
        // Dirle «ti riprendo» e' la stessa specie di bugia di «stream aborted by
        // user» su uno spegnimento — chi legge il log cerca dalla parte
        // sbagliata. Sul task 235afe11 e' successo tre volte in un'ora, e ogni
        // riga di quel giro raccontava una ripresa che non c'e' stata.
        const sorti: string[] = [];
        if (cards > 0) sorti.push(`${cards} card: turno perso, rimessa in coda (riparte da capo, il worktree resta)`);
        if (unadoptable > 0) sorti.push(`${unadoptable} chat NON riadottabile/i: quel lavoro non torna, in chat resta il cartello`);
        if (!sorti.length) sorti.push("la reload-resilience li riprende");
        console.warn(`[quiescence] ${label}: ${busy} — ancora in volo alla scadenza dopo ${Math.round((Date.now() - inizio) / 1000)}s, si procede lo stesso (${sorti.join("; ")})`);
        return;
      }
      if (!logged) {
        // NAME THE HOLDERS. "4 card turns" told nobody that three of them were
        // orphan recoveries stuck since boot (2026-09-04): a count cannot be
        // checked against the board, a list of ids can.
        const holders = cards > 0 ? ` [${taskDispatcher.busyIds().map((id) => id.slice(0, 8)).join(", ")}]` : "";
        console.log(`[quiescence] ${label}: aspetto prima di riavviare — ${busy}${holders}${unadoptable > 0 ? ` (${unadoptable} non riadottabile/i: attesa lunga)` : ""}`);
        logged = true;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    clearReloadDeferred();
    if (logged) console.log(`[quiescence] ${label}: tutto finito — si procede col riavvio`);
  }

  return { attesaQuiescenza, autoLandTurnCount, openBrokerChatTurns, waitForDispatcherQuiescent, whatIsStillWorking };
}
