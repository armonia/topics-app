// Una card che gira in una sessione cloud: crea, segue gli eventi, manda messaggi,
// gira i permessi. Ha la forma di `AIProvider.sendChat` (un turno per chiamata, fine
// sul `result`), ma non è ancora registrata fra i provider: è il prototipo da misurare.

import type { StreamHandler } from "../types";
import { CloudApi, type CloudSource } from "./api";
import { applyEvent, newTurnState, type PermissionAsk, type TurnState } from "./events";

export interface CloudTurnOptions {
  source: CloudSource;
  deliveryBranch: string;
  model: string;
  effort?: string;
  title?: string;
  /** Decide un permesso. Senza: nega, perché nessuno lo sta guardando. */
  onPermission?: (ask: PermissionAsk) => Promise<{ allow: boolean; message?: string }>;
  /** Intervallo del polling mentre il turno lavora (default 2 s). */
  pollMs?: number;
  /** Turno senza eventi nuovi per così tanto = fermo (default 15 min). */
  stallMs?: number;
  signal?: AbortSignal;
}

export interface CloudTurnResult {
  sessionId: string;
  deliveredBranch?: string;
  deliveredUrl?: string;
  /** `stalled` = il polling non vede più nulla: la card va in needs_input, mai in delivered */
  outcome: "done" | "error" | "stalled" | "aborted";
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

export class CloudSessionRunner {
  private sessions = new Map<string, { sid: string; cursor?: string }>();
  private envId?: string;

  constructor(private readonly api: CloudApi) {}

  /** Un turno: il primo crea la sessione, i successivi le scrivono. */
  async sendTurn(sessionKey: string, message: string, h: StreamHandler, o: CloudTurnOptions): Promise<CloudTurnResult> {
    let s = this.sessions.get(sessionKey);
    if (!s) {
      this.envId ??= await this.api.defaultEnvironmentId();
      const sid = await this.api.createSession({
        title: o.title ?? message.slice(0, 60),
        prompt: message,
        source: o.source,
        deliveryBranch: o.deliveryBranch,
        model: o.model,
        effort: o.effort,
        environmentId: this.envId,
      });
      s = { sid };
      this.sessions.set(sessionKey, s);
    } else {
      // Salta gli eventi vecchi: il turno nuovo parte da dopo l'ultimo visto.
      await this.drain(s);
      await this.api.sendMessage(s.sid, message);
    }
    return this.follow(s, h, o);
  }

  private async drain(s: { sid: string; cursor?: string }) {
    for (;;) {
      const page = await this.api.events(s.sid, s.cursor);
      if (page.last_id) s.cursor = page.last_id;
      if (!page.has_more) return;
    }
  }

  private async follow(s: { sid: string; cursor?: string }, h: StreamHandler, o: CloudTurnOptions): Promise<CloudTurnResult> {
    const st: TurnState = newTurnState();
    const pollMs = o.pollMs ?? 2_000;
    const stallMs = o.stallMs ?? 15 * 60_000;
    let lastNews = Date.now();
    let failed = false;
    const asks: PermissionAsk[] = [];
    const handler = { ...h, onError: (e: string) => { failed = true; h.onError(e); } };

    while (!st.done) {
      if (o.signal?.aborted) return { sessionId: s.sid, outcome: "aborted" };
      let page;
      try {
        page = await this.api.events(s.sid, s.cursor);
      } catch {
        // Un errore di rete non chiude il turno: conta come silenzio, ci pensa lo stallo.
        page = { data: [], has_more: false };
      }
      if (page.last_id) s.cursor = page.last_id;
      if (page.data.length) lastNews = Date.now();
      for (const ev of page.data) {
        // L'eco del messaggio appena mandato non è un evento del turno.
        if (ev.type === "user" && typeof (ev.message as { content?: unknown })?.content === "string") continue;
        applyEvent(ev, st, handler, (a) => asks.push(a));
      }
      while (asks.length) {
        const a = asks.shift()!;
        const d = o.onPermission ? await o.onPermission(a) : { allow: false, message: "nessuno risponde ai permessi" };
        await this.api.respondPermission(s.sid, a.requestId, d.allow, d.message);
      }
      if (st.done) break;
      if (Date.now() - lastNews > stallMs) return { sessionId: s.sid, outcome: "stalled", deliveredBranch: st.deliveredBranch };
      if (!page.has_more) await sleep(pollMs, o.signal);
    }
    return {
      sessionId: s.sid,
      outcome: failed ? "error" : "done",
      deliveredBranch: st.deliveredBranch,
      deliveredUrl: st.deliveredUrl,
    };
  }
}
