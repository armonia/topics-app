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
      // ─────────────────────────────────────────────────────────────────────
      // APERTO (2026-08-19): un ciclo di PUT che passa DA QUI, e la caccia
      // lasciata a meta' con quel che si sa gia'.
      //
      // SINTOMO: a schermo fermo, con una chat aperta, questa finestra manda
      // 12-17 PUT di `pane-store-v2` in 25 secondi — uno ogni 1,5 s, da 75 KB,
      // con `lastSeq` che sale e NESSUN'ALTRA differenza fra un corpo e il
      // successivo. Si misura con `scripts/check-idle-writes.mjs` (tetto 3).
      //
      // COSA E' GIA' ESCLUSO, misurato e non dedotto:
      //  · non e' `UPDATE_PANE` (guardia aggiunta, e il ciclo e' RIMASTO);
      //  · non e' `FOCUS_PANE` (guardia aggiunta, ciclo rimasto);
      //  · non e' NESSUNA azione: strumentando il dispatcher per contare le
      //    azioni per tipo, in quella finestra ne ho contate **zero**, con
      //    quindici PUT partiti nello stesso intervallo. Il `lastSeq` che fa
      //    partire il debounce non viene dal reducer;
      //  · i PUT partono DA QUESTA finestra (contati sul suo `fetch`), non sono
      //    scritture altrui viste passare.
      //
      // IL SOSPETTO CHE RESTA, ed e' il motivo per cui la nota sta QUI: la riga
      // qui sotto porta `lastSeq` a `max(currentSeq, server_seq)`. `server_seq`
      // e' allocato dal SERVER e cresce a ogni scrittura di CHIUNQUE — su questa
      // macchina `/api/system/presence` ne dichiarava ventuno di sessioni
      // aperte. Ogni idratazione remota alza quindi il nostro contatore, il
      // middleware vede il contatore muoversi e manda uno snapshot identico;
      // quel PUT alza `server_seq`, il server lo ritrasmette a tutti, e ogni
      // altro client fa lo stesso. Il filtro dell'eco (`isSelfEcho`) protegge
      // dalla PROPRIA scrittura, non da quella dei pari.
      //
      // PERCHE' NON L'HO CHIUSA: la riga esiste per una ragione vera —
      // post-idratazione i nostri PUT devono portare un seq che il server
      // consideri fresco, o il suo LWW li rifiuta — e toccarla senza capire
      // quale delle due meta' vale in ogni caso significa scegliere fra due
      // guasti peggiori: un client che non sincronizza piu', o uno che
      // sovrascrive i pari. Ho gia' ritirato oggi un rimedio scritto con meno
      // certezza di questa, e mi era costato una chiusura di scheda che non
      // arrivava al server.
      // ─────────────────────────────────────────────────────────────────────
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
