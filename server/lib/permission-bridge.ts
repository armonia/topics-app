/**
 * Il rendez-vous del CANALE DI PERMESSO.
 *
 * ── Il buco che chiude ──────────────────────────────────────────────────────
 * Topics lancia la CLI headless (`--print`). In ogni `--permission-mode` che
 * non sia `bypassPermissions` la CLI, prima di eseguire uno strumento che la
 * modalità non copre, CHIEDE — e senza qualcuno che risponda quella richiesta
 * diventa un no muto:
 *
 *     Claude requested permissions to use mcp__gateway__kiwi__search-flight,
 *     but you haven't granted it yet.
 *
 * Misurato sulla CLI 2.1.221 e 2.1.224 (identiche): in `acceptEdits` passano
 * Bash e le modifiche DENTRO la cwd; muoiono mute **ogni tool MCP** e ogni
 * scrittura fuori dalla cwd. Non era una regressione: la mappatura
 * `auto-apply → acceptEdits` è nata così, e il probe che la "provò" esercitava
 * solo `Bash` — l'unica capacità che passa in tutte e sei le modalità.
 *
 * ── Come si risponde ────────────────────────────────────────────────────────
 * `--permission-prompt-tool <tool MCP>` (sparito da `--help` in 2.1.224, ancora
 * accettato e funzionante: provato) dirotta la richiesta su uno strumento MCP
 * invece che sul prompt interattivo. Topics attacca già un server MCP a ogni
 * sessione, quindi il canale è `mcp__topics__approval_prompt`.
 *
 * Il giro è identico a quello di `ask_user_question` (vedi ask-user-bridge.ts),
 * e per lo stesso motivo: la CLI si blocca sulla RISPOSTA JSON-RPC del bridge,
 * non su stdin. Quindi il gestore del bridge deve bloccarsi finché l'umano non
 * decide, e questo modulo è il punto d'incontro fra:
 *
 *   - il bridge (bloccato in `POST /api/sessions/:sk/permission` → `waitForDecision`)
 *   - il click nella chat (`POST /api/chat/tool-response` → `deliverDecision`)
 *
 * ── Perché una chiave per TOOL e non per sessione ───────────────────────────
 * `ask_user_question` si può indicizzare per sessione: la CLI blocca il turno
 * su una domanda alla volta. Un permesso no — la CLI può emettere più
 * `tool_use` nello stesso messaggio e chiedere per ognuno. Misurati a 170 ms di
 * distanza sullo stesso turno. Indicizzare per sessione farebbe rispondere alla
 * richiesta sbagliata: la chiave è `sessionKey + tool_use_id`, che è anche
 * l'identificatore della riga di tool già a schermo.
 */

import { emitHumanHoldChange } from './human-hold-events';
import type { CliPermissionDecision as PermissionDecision } from '../../shared/permission-decision';

/**
 * Cosa torna ALLA CLI. `allow_always` consente ORA e scrive un grant.
 *
 * Tre valori, non quattro: `allow_free` — «consenti e libera la sessione» — è
 * una decisione dell'interfaccia, e da qui in giù non deve nemmeno essere
 * dicibile. La rotta la converte in `allow` sul confine (`cliDecisionFor`), e
 * questo tipo fa sì che dimenticarsene sia un errore di compilazione invece che
 * una parola sconosciuta consegnata a un processo figlio.
 */
export type { CliPermissionDecision as PermissionDecision } from '../../shared/permission-decision';

export interface PermissionWaitOptions {
  /** Quanto blocca QUESTA gamba (ms). Una gamba, non la richiesta. */
  timeoutMs?: number;
  /** Quanto resta in dispensa una decisione consegnata a nessuno (ms). */
  bufferTtlMs?: number;
}

export type PermissionWaitFailure = 'timeout' | 'cancelled' | 'superseded';

export class PermissionWaitError extends Error {
  constructor(public readonly code: PermissionWaitFailure, message: string) {
    super(message);
    this.name = 'PermissionWaitError';
  }
}

/**
 * Una gamba, non la richiesta. Stessa misura di `ask-user-bridge`: una singola
 * richiesta HTTP tenuta aperta a zero byte è esattamente ciò che un timeout di
 * socket inattivo uccide, e muore dal lato del CLIENT — nessuna pazienza
 * server-side la salva. Gambe corte che tornano sempre, riarmate subito.
 */
const DEFAULT_TIMEOUT_MS = 25 * 1000;

/**
 * Il tetto della RICHIESTA. Più corto delle 24 h di una domanda, e di proposito:
 * una domanda è il turno che aspetta te, e può aspettare la mattina dopo; un
 * permesso tiene fermo uno strumento in mezzo a un turno, con tutto ciò che
 * segue in attesa. Dopo due ore senza risposta la cosa onesta è dire di no e
 * lasciare che il turno si chiuda, non tenere un processo appeso a vuoto.
 *
 * Non è un modo per negare in fretta: finché il pannello è a schermo e il figlio
 * è vivo, `humanHoldAgeMs` tiene lontani watchdog e reaper esattamente come per
 * una domanda.
 */
const DEFAULT_REQUEST_TTL_MS = 2 * 60 * 60 * 1000;

export const PERMISSION_TTL_MS = DEFAULT_REQUEST_TTL_MS;

const DEFAULT_BUFFER_TTL_MS = 30 * 1000;

interface Waiter {
  resolve: (decision: PermissionDecision) => void;
  reject: (err: PermissionWaitError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BufferedDecision {
  decision: PermissionDecision;
  timer: ReturnType<typeof setTimeout>;
}

const waiters = new Map<string, Waiter>();
const buffered = new Map<string, BufferedDecision>();

/**
 * Le richieste APERTE — il pannello è a schermo e nessuno ha ancora deciso.
 * Separata da `waiters` per lo stesso motivo dell'ask: con un bridge che polla
 * ci sono millisecondi fra una gamba e l'altra in cui nessun waiter è
 * registrato, e in quella fessura la richiesta è viva eccome. Valore = quando è
 * stata aperta, così il TTL copre la richiesta e non riparte a ogni gamba.
 */
const activeRequests = new Map<string, { sessionKey: string; toolUseId: string; startedAt: number }>();

/** La chiave: la richiesta È la riga di tool a schermo. */
export function permissionKey(sessionKey: string, toolUseId: string): string {
  return `${sessionKey}\u0000${toolUseId}`;
}

/**
 * Apre la richiesta, o conferma quella già aperta. Chiamata in cima a ogni
 * gamba: la PRIMA la apre (e fa partire l'orologio del TTL), le successive sono
 * no-op, così un poll ogni 25 secondi non può tenerla viva per sempre.
 *
 * Torna false quando la richiesta ha superato il TTL — il chiamante allora la
 * chiude e riporta una scadenza pulita invece di pollare fino alla morte del
 * figlio CLI.
 */
export function beginPermission(
  sessionKey: string,
  toolUseId: string,
  ttlMs = DEFAULT_REQUEST_TTL_MS,
  now = Date.now(),
): boolean {
  const key = permissionKey(sessionKey, toolUseId);
  const open = activeRequests.get(key);
  if (open === undefined) {
    const wasHeld = sessionHasPendingPermission(sessionKey);
    activeRequests.set(key, { sessionKey, toolUseId, startedAt: now });
    // Il primo permesso aperto e' quello che ferma il turno agli occhi di chi
    // guarda la board; i successivi non cambiano il fatto.
    if (!wasHeld) emitHumanHoldChange({ sessionKey, phase: 'held', source: 'permission' });
    return true;
  }
  return now - open.startedAt < ttlMs;
}

/** Chiude una richiesta: decisa, annullata o scaduta. Idempotente. */
export function endPermission(sessionKey: string, toolUseId: string): void {
  const removed = activeRequests.delete(permissionKey(sessionKey, toolUseId));
  for (const [alias, target] of [...aliases]) {
    if (target === toolUseId && alias.startsWith(`${sessionKey}\u0000`)) aliases.delete(alias);
  }
  // `released` solo quando cade l'ULTIMO: con due pannelli aperti, chiuderne uno
  // non rimette il turno a lavorare.
  if (removed && !sessionHasPendingPermission(sessionKey)) {
    emitHumanHoldChange({ sessionKey, phase: 'released', source: 'permission' });
  }
}

/**
 * Chiamata dal bridge, una volta per gamba. Si risolve con la decisione
 * dell'umano, o si rifiuta con un `PermissionWaitError` il cui `code` dice
 * perché: `timeout` (questa gamba è scaduta — torna subito), `cancelled`,
 * `superseded`. Se la decisione era già arrivata mentre nessuna gamba era
 * registrata, si risolve subito dalla dispensa.
 */
export function waitForDecision(
  sessionKey: string,
  toolUseId: string,
  opts: PermissionWaitOptions = {},
): Promise<PermissionDecision> {
  const key = permissionKey(sessionKey, toolUseId);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const buf = takeBufferedDecision(sessionKey, toolUseId);
  if (buf !== undefined) return Promise.resolve(buf);

  const existing = waiters.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    waiters.delete(key);
    existing.reject(new PermissionWaitError('superseded', 'permesso: richiesta sostituita da una più recente'));
  }

  return new Promise<PermissionDecision>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(key);
      reject(new PermissionWaitError('timeout', 'permesso: gamba di poll scaduta'));
    }, timeoutMs);
    waiters.set(key, { resolve, reject, timer });
  });
}

/**
 * The decision a human delivered to THIS request while no leg was in flight,
 * taken out of the pantry, or `undefined` when there is none.
 *
 * The route reads it at the TOP of a leg, before the global rules. The order
 * matters: a click between two legs closes the request and buffers the
 * decision, and the next leg used to reach `waitForDecision` (which drains
 * the buffer) only after the grant check. With «always allow» that check now
 * finds the rule the click just wrote, answers `allow` on its own, and the
 * human's `allow_always` stays in the pantry until its TTL: the CLI got an
 * answer, but not the one the person gave for this very request. Reading the
 * pantry first also spares the leg from re-opening a request that is already
 * decided, that is from repainting a panel nobody needs to press again.
 */
export function takeBufferedDecision(sessionKey: string, toolUseId: string): PermissionDecision | undefined {
  const key = permissionKey(sessionKey, toolUseId);
  const buf = buffered.get(key);
  if (!buf) return undefined;
  clearTimeout(buf.timer);
  buffered.delete(key);
  return buf.decision;
}

/**
 * Chiamata quando l'umano preme. Torna `true` se c'è (o ci sarà a breve, via
 * dispensa) un gestore del bridge che la raccoglie — cioè se questa riga di
 * tool è davvero una richiesta di permesso aperta. `false` quando non c'è
 * niente a cui consegnarla, così il chiamante può proseguire sulle altre
 * strade (la domanda del bridge, l'approvazione di un piano, stdin).
 */
export function deliverDecision(
  sessionKey: string,
  toolUseId: string,
  decision: PermissionDecision,
  opts: PermissionWaitOptions = {},
): boolean {
  const key = permissionKey(sessionKey, toolUseId);
  // Consegnare a una richiesta che non è aperta significherebbe mettere in
  // dispensa una decisione che nessuno verrà mai a ritirare — e far credere al
  // chiamante di aver risposto a qualcosa.
  if (!activeRequests.has(key) && !waiters.has(key)) return false;
  endPermission(sessionKey, toolUseId);
  const w = waiters.get(key);
  if (w) {
    clearTimeout(w.timer);
    waiters.delete(key);
    w.resolve(decision);
    return true;
  }
  const ttl = opts.bufferTtlMs ?? DEFAULT_BUFFER_TTL_MS;
  const prev = buffered.get(key);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => buffered.delete(key), ttl);
  buffered.set(key, { decision, timer });
  return true;
}

/** C'è una richiesta di permesso aperta su questa riga di tool? */
export function hasPendingPermission(sessionKey: string, toolUseId: string): boolean {
  return activeRequests.has(permissionKey(sessionKey, toolUseId));
}

/**
 * Il pannello è finito su una riga con un id DIVERSO da quello della richiesta?
 * Allora si registra la corrispondenza, invece di indovinarla dopo.
 *
 * Succede solo nel ripiego della rotta: se Topics non aveva persistito il
 * `tool_use_id` che la CLI passa, il pannello si aggancia all'ultima riga con
 * quel nome. Il click arriverà con l'id della RIGA, la richiesta è indicizzata
 * con quello della CLI.
 *
 * Prima qui c'era un'euristica — «se sulla sessione c'è una richiesta sola, il
 * click è suo». Reggeva finché non ce n'era davvero una sola: con una richiesta
 * aperta e un click su una riga scollegata, mandava la decisione a un permesso
 * che nessuno aveva guardato. Un sì dato al posto di un altro è il peggiore
 * degli errori possibili qui dentro, e una corrispondenza SCRITTA non indovina.
 */
const aliases = new Map<string, string>();

export function aliasPermission(sessionKey: string, toolUseId: string, aliasId: string): void {
  if (aliasId === toolUseId) return;
  aliases.set(permissionKey(sessionKey, aliasId), toolUseId);
}

/**
 * Da quale richiesta aperta viene il click su QUESTA riga di tool, o `null` se
 * da nessuna — e `null` è una risposta legittima: un pannello può sopravvivere
 * al turno che lo ha aperto (server riavviato, figlio morto), e in quel caso
 * dirlo è meglio che accettare un click che non arriverà da nessuna parte.
 */
export function resolvePendingPermission(sessionKey: string, toolUseId: string): string | null {
  if (hasPendingPermission(sessionKey, toolUseId)) return toolUseId;
  const aliased = aliases.get(permissionKey(sessionKey, toolUseId));
  return aliased && hasPendingPermission(sessionKey, aliased) ? aliased : null;
}

/**
 * Consente IN BLOCCO ogni richiesta ancora aperta su questa sessione, e dice
 * quali erano — con gli id delle righe a schermo, alias compresi, perché chi
 * chiama deve poterle richiudere anche graficamente.
 *
 * Esiste per una sola strada: la sessione passa in modalità libera mentre più
 * pannelli sono a schermo. La CLI può emettere più `tool_use` nello stesso
 * messaggio e chiedere per ognuno (misurati a 170 ms di distanza), quindi
 * rispondere solo a quello premuto lascerebbe gli altri appesi: la loro gamba
 * successiva verrebbe cortocircuitata dalla rotta — «questa sessione non chiede
 * più» — e nessuno chiuderebbe MAI la richiesta aperta. Il pannello resterebbe
 * a schermo su un permesso già superato, e con lui `humanHold`, che tiene
 * lontani watchdog e reaper: un turno che nessuno sorveglia più.
 *
 * Gli alias si leggono PRIMA di consegnare: `endPermission` li cancella.
 */
export function allowPendingPermissions(sessionKey: string): { toolUseId: string; rowIds: string[] }[] {
  const prefix = `${sessionKey}\u0000`;
  const served: { toolUseId: string; rowIds: string[] }[] = [];
  for (const entry of [...activeRequests.values()]) {
    if (entry.sessionKey !== sessionKey) continue;
    const rowIds: string[] = [];
    for (const [aliasKey, target] of aliases) {
      if (target === entry.toolUseId && aliasKey.startsWith(prefix)) rowIds.push(aliasKey.slice(prefix.length));
    }
    if (deliverDecision(sessionKey, entry.toolUseId, 'allow')) {
      served.push({ toolUseId: entry.toolUseId, rowIds });
    }
  }
  return served;
}

/** C'è ALMENO una richiesta di permesso aperta su questa sessione? */
export function sessionHasPendingPermission(sessionKey: string): boolean {
  for (const entry of activeRequests.values()) if (entry.sessionKey === sessionKey) return true;
  return false;
}

/**
 * Da quanto è a schermo la richiesta PIÙ VECCHIA di questa sessione, o `null`.
 * Chi sospende una rete di sicurezza (il watchdog dei turni, il reaper
 * d'inattività, lo spazzino degli stream fermi) deve sapere non solo «c'è
 * qualcosa?» ma «e da quanto?», altrimenti l'esenzione non ha fine.
 */
export function pendingPermissionAgeMs(sessionKey: string, now = Date.now()): number | null {
  let oldest: number | null = null;
  for (const entry of activeRequests.values()) {
    if (entry.sessionKey !== sessionKey) continue;
    const age = now - entry.startedAt;
    if (oldest === null || age > oldest) oldest = age;
  }
  return oldest;
}

/** Sblocca UNA richiesta con un errore (scaduta, o la sua riga è sparita). */
export function cancelPermission(sessionKey: string, toolUseId: string, reason = 'cancelled'): void {
  const key = permissionKey(sessionKey, toolUseId);
  // Terza uscita, e la piu' facile da dimenticare: e' quella che scatta quando
  // la richiesta SCADE (topics.ts, `if (!beginPermission(...)) cancelPermission(...)`).
  // Senza l'annuncio qui, chi guarda resterebbe su «aspetta te» mentre l'agente
  // ha gia' ripreso a lavorare — la stessa bugia che il canale esiste per
  // togliere, girata al contrario. E non la salva la pulizia di fine turno:
  // `cancelPermissionsForSession` legge `wasHeld` DOPO che questa ha gia'
  // cancellato la voce, quindi non trova piu' niente da annunciare.
  const removed = activeRequests.delete(key);
  const w = waiters.get(key);
  if (w) {
    clearTimeout(w.timer);
    waiters.delete(key);
    w.reject(new PermissionWaitError('cancelled', `permesso: ${reason}`));
  }
  const buf = buffered.get(key);
  if (buf) {
    clearTimeout(buf.timer);
    buffered.delete(key);
  }
  if (removed && !sessionHasPendingPermission(sessionKey)) {
    emitHumanHoldChange({ sessionKey, phase: 'released', source: 'permission' });
  }
}

/**
 * Sblocca ogni richiesta aperta su questa sessione con un errore, invece di
 * lasciarla appesa fino al timeout. Va chiamata dove si annulla una domanda —
 * turno interrotto, turno finito, sessione azzerata: le due cose hanno
 * esattamente lo stesso ciclo di vita, e la porta unica è `releaseHumanHold`
 * in `server/lib/human-hold.ts`.
 */
export function cancelPermissionsForSession(sessionKey: string, reason = 'cancelled'): void {
  const wasHeld = sessionHasPendingPermission(sessionKey);
  for (const [key, entry] of [...activeRequests]) {
    if (entry.sessionKey !== sessionKey) continue;
    activeRequests.delete(key);
    const w = waiters.get(key);
    if (w) {
      clearTimeout(w.timer);
      waiters.delete(key);
      w.reject(new PermissionWaitError('cancelled', `permesso: ${reason}`));
    }
    const buf = buffered.get(key);
    if (buf) {
      clearTimeout(buf.timer);
      buffered.delete(key);
    }
  }
  // Un solo annuncio per l'intera sessione, e solo se c'era davvero qualcosa da
  // annullare: questa funzione viene chiamata anche a fine turno su sessioni che
  // non hanno mai aperto un pannello.
  if (wasHeld) emitHumanHoldChange({ sessionKey, phase: 'released', source: 'permission' });
}
