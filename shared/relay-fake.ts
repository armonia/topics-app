/**
 * Un relay FINTO, in memoria: due capi, nessuna rete.
 *
 * Serve a due cose, e la seconda è quella che conta.
 *
 * La prima: provare il protocollo senza dipendere da un servizio esterno. Un
 * test che ha bisogno di Cloudflare per girare è un test che nella pratica non
 * gira.
 *
 * La seconda: **tenere onesta la promessa che il trasporto è sostituibile.**
 * Finché esistono due implementazioni del relay — questa e quella vera — il
 * protocollo non può scivolare dentro l'implementazione senza che qualcosa si
 * rompa. Se un giorno il Worker cominciasse a guardare dentro le buste, o a
 * dipendere da un ordine che il protocollo non garantisce, questa smetterebbe
 * di funzionare e lo si saprebbe subito. È lo stesso motivo per cui un
 * linguaggio con due compilatori ha una specifica migliore.
 *
 * Non è un mock: implementa il contratto per intero, compreso il fatto di NON
 * poter leggere ciò che inoltra.
 */
import {
  RELAY_PROTOCOL_VERSION, leggiMessaggio, haContenutoOpaco,
  type MessaggioRelay, type Rifiutato,
} from "./relay-protocol";

type Invia = (m: MessaggioRelay) => void;

interface Capo {
  invia: Invia;
}

export interface RelayFintoOpts {
  /** I token validi per installazione. Il relay verifica CHE tu sia
   *  l'installazione che dici, non CHI sei come persona — quella domanda non è
   *  sua e non deve diventarlo. */
  tokenValidi?: Record<string, string>;
  /** I riferimenti di condivisione ancora buoni. Assente = tutti buoni. */
  shareRefValidi?: Set<string>;
}

/**
 * Un relay che funziona davvero, in memoria.
 *
 * Regola che si porta dietro dal contratto: quando la macchina non è collegata,
 * l'ospite riceve `host-offline` — un motivo suo, non un errore generico. È la
 * differenza fra dire «la sua macchina è spenta» e lasciare qualcuno davanti a
 * una pagina vuota che si legge come «non ti hanno condiviso niente».
 */
export function creaRelayFinto(opts: RelayFintoOpts = {}) {
  const macchine = new Map<string, Capo>();
  const ospiti = new Map<string, { capo: Capo; installationId: string }>();
  /** Ciò che il relay ha VISTO passare: serve ai test per dimostrare che non
   *  contiene i contenuti. */
  const visto: Array<Record<string, unknown>> = [];
  let contatore = 0;

  const nega = (capo: Capo, motivo: Rifiutato["motivo"]) => capo.invia({ t: "denied", motivo });

  function collegaMacchina(invia: Invia) {
    const capo: Capo = { invia };
    let id: string | null = null;

    return {
      /** Un messaggio dalla macchina verso il relay. */
      ricevi(raw: unknown) {
        const m = leggiMessaggio(raw);
        if (!m) return nega(capo, "bad-version");
        visto.push({ t: m.t, ...(haContenutoOpaco(m) ? {} : {}) });

        if (m.t === "hello") {
          const atteso = opts.tokenValidi?.[m.installationId];
          if (atteso !== undefined && atteso !== m.token) return nega(capo, "bad-token");
          id = m.installationId;
          macchine.set(id, capo);
          capo.invia({ t: "ready", v: RELAY_PROTOCOL_VERSION });
          return;
        }

        if (m.t === "to-guest") {
          if (!id) return nega(capo, "bad-token");
          const dest = ospiti.get(m.to);
          // Una busta per un ospite che se n'è andato si lascia cadere in
          // silenzio: non è un errore della macchina, è il mondo che è cambiato.
          if (dest && dest.installationId === id) dest.capo.invia(m);
          return;
        }

        nega(capo, "bad-version");
      },
      scollega() {
        if (id) macchine.delete(id);
        for (const [sid, o] of ospiti) {
          if (o.installationId === id) {
            o.capo.invia({ t: "denied", motivo: "host-offline" });
            ospiti.delete(sid);
          }
        }
      },
    };
  }

  function collegaOspite(invia: Invia) {
    const capo: Capo = { invia };
    let sessionId: string | null = null;

    return {
      ricevi(raw: unknown) {
        const m = leggiMessaggio(raw);
        if (!m) return nega(capo, "bad-version");
        visto.push({ t: m.t });

        if (m.t === "guest-open") {
          if (opts.shareRefValidi && !opts.shareRefValidi.has(m.shareRef)) {
            return nega(capo, "expired");
          }
          const host = macchine.get(m.installationId);
          if (!host) return nega(capo, "host-offline");
          sessionId = `s${++contatore}`;
          ospiti.set(sessionId, { capo, installationId: m.installationId });
          capo.invia({ t: "ready", v: RELAY_PROTOCOL_VERSION, sessionId });
          host.invia({ t: "guest-joined", sessionId });
          return;
        }

        if (m.t === "to-host") {
          if (!sessionId) return nega(capo, "bad-token");
          const o = ospiti.get(sessionId);
          const host = o && macchine.get(o.installationId);
          if (!host) return nega(capo, "host-offline");
          // Il relay aggiunge da chi viene: l'ospite non se lo può attribuire
          // da solo, o potrebbe spacciarsi per un altro.
          host.invia({ t: "to-guest", to: sessionId, payload: m.payload });
          return;
        }

        nega(capo, "bad-version");
      },
      scollega() {
        if (!sessionId) return;
        const o = ospiti.get(sessionId);
        if (o) {
          macchine.get(o.installationId)?.invia({ t: "guest-left", sessionId });
          ospiti.delete(sessionId);
        }
      },
    };
  }

  return {
    collegaMacchina,
    collegaOspite,
    /** Tutto ciò che il relay ha visto. Nessun contenuto, per costruzione. */
    visto,
    macchineCollegate: () => macchine.size,
    ospitiCollegati: () => ospiti.size,
  };
}
