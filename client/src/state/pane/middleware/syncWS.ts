/**
 * WS subscriber for `ui-state:init`, `ui-state:updated`, and `ui-state:patch`
 * frames.
 *
 * Reads the Option-A parallel envelope (see 30-04-SUMMARY.md):
 *   - `ui-state:init`:    payload at frame.data['pane-store-v2'],
 *                         LWW key at frame.meta['pane-store-v2'].server_seq
 *   - `ui-state:updated`: payload at frame.value (when frame.key === 'pane-store-v2'),
 *                         LWW key at frame.server_seq (top-level, additive)
 *   - `ui-state:patch`:   delta shape introduced by finding #11. `entries[key]`
 *                         carries `{ data, payload_version, server_seq }`, and
 *                         replaces the old bulk-PUT → full `ui-state:init`
 *                         broadcast fan-out. Only the keys actually modified
 *                         by the bulk PUT are present. We apply only the
 *                         pane-store-v2 entry (other keys are consumed by
 *                         useServerState). Back-compat: the server still sends
 *                         `ui-state:init` on WS open, so older clients that
 *                         don't recognise `ui-state:patch` are unaffected.
 *
 * LWW: frames with `server_seq <= lastAppliedServerSeq` are dropped so stale
 * init frames (e.g. arriving after a later `ui-state:updated`) never clobber
 * newer state.
 *
 * Finding #10 (defence-in-depth on top of isSelfEcho): every broadcast carries
 * `sourceClientId`. If it matches this tab's id we skip HYDRATE — covers the
 * case where the PUT ack is lost (crash mid-PUT, reconnect) while the
 * broadcast still lands. The seq-based `isSelfEcho` check is still the primary
 * gate; sourceClientId is a belt-and-braces additional filter.
 */
import { usePaneStore } from '../store';
import { isSelfEcho, resetSelfEcho } from './selfEcho';
import { markServerHydrated } from './serverHydrated';
import { getTabId } from './syncCrossTab';
import { subscribeLifecycle } from '../../../lib/wsFrameBus';

const REMOTE_KEY = 'pane-store-v2';

type InitFrame = {
  type: 'ui-state:init';
  data?: Record<string, unknown>;
  meta?: Record<string, { payload_version: number; server_seq: number }>;
};

type UpdatedFrame = {
  type: 'ui-state:updated';
  key: string;
  value: unknown;
  payload_version?: number;
  server_seq: number;
  sourceClientId?: string | null;
};

type PatchEntry = { data?: unknown; payload_version?: number; server_seq?: number };

type PatchFrame = {
  type: 'ui-state:patch';
  sourceClientId?: string | null;
  entries?: Record<string, PatchEntry>;
};

// WS frames flow in from the app's existing bus. The shapes we care about
// (ui-state:init, ui-state:updated) are narrowed below via string compare on
// `type`; anything else is ignored. Keep the public type loose to avoid
// forcing the caller's bus to conform to our discriminated union.
export type WSFrame = { type: string; [k: string]: unknown };

let started = false;
let lastAppliedServerSeq = 0;

/**
 * L'IDENTITA' DELL'ULTIMO STATO ARRIVATO DAL SERVER, per chi deve decidere se
 * vale la pena rimandarlo indietro.
 *
 * PERCHE' ESISTE (2026-08-19). A schermo fermo una finestra manda 12-17 PUT di
 * `pane-store-v2` in 25 secondi, uno ogni 1,5 s, con `lastSeq` che sale e
 * NESSUN'ALTRA differenza fra un corpo e il successivo. Strumentando il
 * dispatcher (la sonda va messa PRIMA del `return` che salta le azioni
 * server-autoritative, o e' cieca proprio a quelle): sedici
 * `HYDRATE_FROM_SNAPSHOT` nella stessa finestra, uno per PUT. La catena e'
 * quella: un HYDRATE porta `lastSeq` a `max(lastSeq, clean.lastSeq)`
 * (`reducers/panes.ts`), il middleware di sync osserva `lastSeq` e mezzo
 * secondo dopo rimanda 75 KB identici. Su un server con `bun:sqlite` sincrono
 * e su HTTP/1.1 quelle scritture si mettono davanti alle letture della board.
 *
 * SONO I PARI, e ci sono arrivato due volte: la prima per ipotesi, la seconda
 * per misura, dopo essermi smentito da solo con una sonda difettosa. Vale la
 * pena raccontarlo, perche' l'errore era nello STRUMENTO e non nel ragionamento.
 *
 * La previsione dell'ipotesi era verificabile: ogni PUT deve seguire un frame
 * `ui-state:*` in arrivo. Misurata contando i frame dal lato Playwright
 * (`page.on('websocket')`): **zero** frame in venticinque secondi contro quindici
 * PUT. Sembrava una smentita netta, e avevo riscritto la diagnosi come «causa
 * sconosciuta». Ma quel contatore non vedeva il socket dell'app: rifatta la
 * misura DENTRO la pagina, avvolgendo `WebSocket` con un Proxy, in venti secondi
 * arrivano **29 frame, di cui 24 `ui-state:updated` su `pane-store-v2`** — e i
 * loro `sourceClientId` sono DUE, dodici e dodici: due client che si scrivono
 * addosso a vicenda.
 *
 * Il ciclo, per intero: `server_seq` e' allocato dal SERVER e cresce a ogni
 * scrittura di CHIUNQUE (ventuno sessioni aperte su questa macchina); il frame
 * di un pari arriva qui, questo ramo dispaccia `HYDRATE_FROM_SNAPSHOT`, il
 * reducer porta `lastSeq` a `max(lastSeq, clean.lastSeq)`; il middleware di
 * sync osserva `lastSeq` e mezzo secondo dopo rimanda 75 KB identici a quelli
 * appena ricevuti; quel PUT alza `server_seq`, il server ritrasmette, e il pari
 * fa lo stesso. Il filtro dell'eco protegge dalla PROPRIA scrittura, non da
 * quella di un pari.
 *
 * La lezione da tenere: una sonda che misura zero non prova un'assenza finche'
 * non le si e' chiesto se sa vedere qualcosa. Quella contava zero frame TOTALI,
 * il che avrebbe dovuto insospettirmi subito — un'app che parla col server via
 * WebSocket non ne riceve zero.
 *
 * SERVONO DUE FINESTRE, ed e' anche il motivo per cui il ciclo si e' nascosto
 * cosi' a lungo: la correlazione misurata e' 12 PUT inviati, 24 frame ricevuti,
 * 2 id di scrittura distinti — ogni nostra scrittura torna come frame, e quella
 * del pari pure. Il secondo client era l'app dell'utente, aperta accanto alla
 * finestra di prova. Una finestra sola non gira: OGNI misura che ha letto «0
 * scritture a riposo» era stata presa con una sola finestra aperta.
 *
 * E questo sposta anche dove cercare il rimedio. Il gate ritirato provava a
 * fermare l'INVIO; la domanda piu' economica e' perche' la scrittura di un pari
 * debba far avanzare il NOSTRO contatore di dispatch (`reducers/panes.ts`, il
 * `max(state.lastSeq, clean.lastSeq)` di HYDRATE_FROM_SNAPSHOT). Il prossimo
 * tentativo parta da li'.
 *
 * Il filtro dell'eco (`selfEcho`) non copre questo: protegge dalla PROPRIA
 * scrittura che torna indietro, non dallo stato di un PARI che ci arriva
 * legittimamente e che noi ri-annunciamo per il solo fatto di averlo ricevuto.
 *
 * Si registra l'identita' e non il seq perche' la domanda del middleware non e'
 * «quale numero d'ordine ho visto» ma «cio' che sto per mandare e' gia' cio' che
 * il server ha». Vedi `alreadyOnServer`.
 */
let lastHydratedIdentity: string | null = null;

/**
 * L'identita' di uno stato ai fini di questo confronto: tutto tranne i due
 * contatori di trasporto.
 *
 * `lastSeq` e `server_seq` NON sono lo stato — sono i numeri d'ordine con cui il
 * server decide chi ha scritto per ultimo. Salgono per costruzione a ogni giro,
 * quindi confrontare il corpo intero direbbe sempre «diverso» e non fermerebbe
 * un solo PUT.
 */
function stateIdentity(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const { lastSeq: _a, server_seq: _b, seq: _c, ...rest } = value as Record<string, unknown>;
  void _a; void _b; void _c;
  return JSON.stringify(rest);
}

/**
 * Cio' che sto per mandare e' esattamente cio' che il server mi ha appena
 * mandato? Allora rimandarglielo non gli dice niente di nuovo.
 *
 * Sbagliare qui in un senso costa un PUT in piu' (innocuo); nell'altro costa uno
 * stato che non si sincronizza — per questo la risposta e' `false` ogni volta
 * che non c'e' un'idratazione recente con cui confrontarsi, e ogni scrittura
 * LOCALE la invalida (vedi `noteLocalWrite`).
 */
export function alreadyOnServer(snapshot: unknown): boolean {
  return lastHydratedIdentity !== null && stateIdentity(snapshot) === lastHydratedIdentity;
}

/**
 * Una scrittura NOSTRA e' partita: da qui in poi lo stato non e' piu' «quello
 * che il server mi ha mandato», e il confronto va rifatto da capo.
 *
 * Senza questo, una modifica locale che riportasse per caso lo stato alla forma
 * appena idratata verrebbe saltata — e quella e' la direzione in cui il rimedio
 * diventa peggiore del difetto.
 */
export function noteLocalWrite(): void {
  lastHydratedIdentity = null;
}

/**
 * Register a subscription against the app's existing WS event bus. The caller
 * supplies a `subscribe` function that invokes our handler with each incoming
 * frame — we do NOT open our own socket.
 */
export function initWSSync(
  onFrame: (handler: (frame: WSFrame) => void) => () => void,
): () => void {
  if (started) return () => {};
  started = true;

  // Review-round-13: reset per-connection state on every WS reconnect.
  //   - `lastAppliedServerSeq` (this module): resets so the first init of a
  //     server-restart connection applies unconditionally.
  //   - `selfEcho` (both the Map AND the TTL-free `lastEmittedServerSeq`
  //     high-water mark): resets so the first init of a seq-restarted
  //     server is NOT classified as a self-echo against stale pre-restart
  //     acks. Without this paired reset, the lastAppliedServerSeq fix alone
  //     is insufficient — the init would pass the monotonic gate but then
  //     be dropped by `isSelfEcho(seq <= lastEmittedServerSeq)`.
  const unsubLifecycle = subscribeLifecycle((event) => {
    if (event === 'open') {
      lastAppliedServerSeq = 0;
      resetSelfEcho();
    }
  });

  const unsub = onFrame((raw) => {
    if (!raw || typeof raw !== 'object') return;

    if (raw.type === 'ui-state:init') {
      const frame = raw as InitFrame;
      // Option-A parallel envelope: payload is at frame.data['pane-store-v2'],
      // LWW key at frame.meta['pane-store-v2'].server_seq.
      const value = frame.data?.['pane-store-v2'];
      const metaEntry = frame.meta?.['pane-store-v2'];
      if (value == null || !metaEntry) return;
      if (metaEntry.server_seq <= lastAppliedServerSeq) return;
      // A `ui-state:init` frame — even if it's a self-echo — proves the
      // server is reachable and has current state for this tab, so the
      // initial-load fallback GET (bootstrap.ts) must NOT fire.
      markServerHydrated();
      // Skip echoes of our own outbound PUT — preserves in-flight local state
      // (blocker B2: 500 ms GET fallback vs in-flight PUT race).
      if (isSelfEcho(metaEntry.server_seq)) {
        lastAppliedServerSeq = metaEntry.server_seq;
        return;
      }
      lastAppliedServerSeq = metaEntry.server_seq;
      const currentSeq = usePaneStore.getState().lastSeq;
      usePaneStore.getState().dispatch({
        type: 'HYDRATE_FROM_SNAPSHOT',
        payload: {
          snapshot: {
            ...(value as object),
            lastSeq: Math.max(currentSeq, metaEntry.server_seq),
            server_seq: metaEntry.server_seq,
            seq: metaEntry.server_seq,
          },
        },
      });
      return;
    }

    if (raw.type === 'ui-state:updated') {
      const upd = raw as UpdatedFrame;
      if (upd.key !== REMOTE_KEY) return;
      if (typeof upd.server_seq !== 'number') return;
      if (upd.server_seq <= lastAppliedServerSeq) return;
      // Same reasoning as `ui-state:init` above: a valid `ui-state:updated`
      // proves the server is hydrating this tab — suppress the fallback GET.
      markServerHydrated();
      // Finding #10 (defence-in-depth): if the server tagged the broadcast
      // with our own tab id, this is a self-echo even if `isSelfEcho` missed
      // it (e.g. the client crashed mid-PUT before `rememberLocalAck`).
      if (typeof upd.sourceClientId === 'string' && upd.sourceClientId === getTabId()) {
        lastAppliedServerSeq = upd.server_seq;
        return;
      }
      // Skip echoes of our own outbound PUT — see B2 above.
      if (isSelfEcho(upd.server_seq)) {
        lastAppliedServerSeq = upd.server_seq;
        return;
      }
      lastAppliedServerSeq = upd.server_seq;
      // Terzo (e piu' frequente) punto in cui uno stato arriva DAL server: e' il
      // broadcast di una scrittura di un PARI. Registrarne l'identita' qui e'
      // cio' che impedisce di ri-annunciarla come se fosse nostra.
      lastHydratedIdentity = stateIdentity(upd.value);
      const currentSeq = usePaneStore.getState().lastSeq;
      usePaneStore.getState().dispatch({
        type: 'HYDRATE_FROM_SNAPSHOT',
        payload: {
          snapshot: {
            ...((upd.value as object) ?? {}),
            lastSeq: Math.max(currentSeq, upd.server_seq),
            server_seq: upd.server_seq,
            seq: upd.server_seq,
          },
        },
      });
      return;
    }

    if (raw.type === 'ui-state:patch') {
      // Finding #11: `ui-state:patch` carries only the keys the bulk PUT
      // changed. We only care about the pane-store-v2 entry here; other keys
      // flow through useServerState (which listens to `ui-state:updated`
      // today — those callers don't use bulk PUT, so they're unaffected by
      // this new shape).
      const patch = raw as PatchFrame;
      const entry = patch.entries?.[REMOTE_KEY];
      if (!entry) return;
      if (typeof entry.server_seq !== 'number') return;
      if (entry.server_seq <= lastAppliedServerSeq) return;
      markServerHydrated();
      // Finding #10: defence-in-depth — drop self-originated patches.
      if (typeof patch.sourceClientId === 'string' && patch.sourceClientId === getTabId()) {
        lastAppliedServerSeq = entry.server_seq;
        return;
      }
      if (isSelfEcho(entry.server_seq)) {
        lastAppliedServerSeq = entry.server_seq;
        return;
      }
      lastAppliedServerSeq = entry.server_seq;
      // Come nell'altro ramo: questo stato viene DAL server, e registrarne
      // l'identita' e' cio' che evita di rimandarglielo indietro.
      lastHydratedIdentity = stateIdentity(entry.data);
      const currentSeq = usePaneStore.getState().lastSeq;
      // Back-compat: reuse HYDRATE_FROM_SNAPSHOT — sanitizer + LWW gate in
      // the reducer handle the shape exactly like `ui-state:updated`. The
      // pane-store-v2 key IS a full sub-snapshot (panes/groups/projects/...),
      // so feeding it into HYDRATE is semantically the same as what the old
      // `ui-state:init` broadcast did for this single key.
      usePaneStore.getState().dispatch({
        type: 'HYDRATE_FROM_SNAPSHOT',
        payload: {
          snapshot: {
            ...((entry.data as object) ?? {}),
            lastSeq: Math.max(currentSeq, entry.server_seq),
            server_seq: entry.server_seq,
            seq: entry.server_seq,
          },
        },
      });
    }
  });

  return () => {
    unsub();
    unsubLifecycle();
    started = false;
  };
}

/** Test/diagnostic helper — returns the last server_seq the middleware applied. */
export function __getLastAppliedServerSeq(): number {
  return lastAppliedServerSeq;
}
