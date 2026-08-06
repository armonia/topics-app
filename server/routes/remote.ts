import type { AppContext, RouteHandler } from "../types";
import { resolveTailscaleBin } from "../lib/tailscale-bin";

/**
 * Remote-access endpoints — rilevano e commutano l'esposizione del server locale
 * sul TAILNET (con rilevamento passivo di cloudflared/ngrok avviati a mano).
 * Scorporati dal god-file topics.ts: sono una faccenda di rete, non di chat.
 * Autosufficienti (ctx.json/readJSON + resolveTailscaleBin + spawn/fetch).
 *
 * LAN-OPEN-03 — questo pannello esponeva su INTERNET, e per due volte non se ne
 * accorgeva nessuno:
 *
 *   `tailscale serve`  → visibile ai soli dispositivi del tailnet: identità
 *                        per-nodo, ACL, revoca. È l'estensione naturale della LAN.
 *   `tailscale funnel` → visibile al mondo intero, a un URL `*.ts.net` pubblico.
 *
 * Il bottone chiamava il secondo. E un tunnel TERMINA sulla macchina e inoltra a
 * localhost, quindi la richiesta arrivava al server da 127.0.0.1: prima della
 * change `lan-open-same-origin` il funnel scavalcava già il pairing token, e
 * dopo passa il check same-site col nome pubblico. Nessuno dei due confini lo
 * ferma — l'unico modo di non pubblicare è non offrire il gesto. Resta un comando
 * da terminale per chi lo vuole davvero.
 *
 * L'altra metà: il target era `http://localhost:3333` contro un listener TLS,
 * quindi il tunnel NON È MAI SALITO, e `isActive` leggeva due chiavi che
 * `tailscale serve status --json` non emette. Il pannello era cosmetico da
 * quando esiste.
 */
export function createRemoteRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON } = ctx;

  // Async subprocess (not spawnSync): /api/remote/status is polled every 30s by
  // RemoteAccessPanel and shells out to tailscale + `ps aux`; spawnSync froze
  // Bun's single event loop for each call, stalling every other request/WS/PTY.
  // Drains both pipes before awaiting exit so a full buffer can't deadlock the
  // child. Returns trimmed stdout, or "" on non-zero exit (same as before).
  const runCmd = async (cmd: string[]): Promise<string> => {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return (await proc.exited) === 0 ? out.trim() : "";
  };

  return async function remoteRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (method === "GET" && pathname === "/api/remote/status") {
      const tsBin = resolveTailscaleBin();
      try {
        try {
          const serveStatus = await runCmd([tsBin, "serve", "status", "--json"]);
          const serve = JSON.parse(serveStatus || '{}');
          // `Web` è chiavato sull'host:porta IN ASCOLTO (`macbook.<tailnet>.ts.net:443`),
          // non su `"https://"`, e `TCP` sulla porta in ascolto (443), non su quella
          // di destinazione (3333): le due chiavi lette prima non esistevano, quindi
          // `isActive` era falso anche a tunnel su. Si guarda invece se ESISTE un
          // handler, qualunque sia la chiave — così non si rompe se il nome del nodo
          // o la porta cambiano.
          const webEntries = Object.values(serve?.Web ?? {}) as Array<{ Handlers?: Record<string, unknown> }>;
          const isActive =
            webEntries.some((e) => Object.keys(e?.Handlers ?? {}).length > 0) ||
            Object.keys(serve?.TCP ?? {}).length > 0;
          const tsJson = await runCmd([tsBin, "status", "--json"]);
          const tsStatus = JSON.parse(tsJson || '{}');
          const hostname = (tsStatus?.Self?.DNSName || "").replace(/\.$/, "");
          if (isActive && hostname) return json({ active: true, url: `https://${hostname}`, type: 'tailscale' });
        } catch {}
        try {
          const procs = await runCmd(["ps", "aux"]);
          const lines = procs.split("\n").filter(l => /cloudflared|lt |ngrok/.test(l) && !l.includes("grep"));
          const line = lines[0] || "";
          // `url: null` e non una frase: il pannello lo infila in un `href`
          // (RemoteAccessPanel.tsx), e «Check cloudflared logs» diventava un link
          // che porta a una pagina inesistente.
          if (line.includes('cloudflared') && line.includes('3333')) return json({ active: true, type: 'cloudflare', url: null });
          if (line.includes('ngrok')) {
            try {
              const resp = await fetch("http://localhost:4040/api/tunnels");
              const data = await resp.json() as any;
              const ngrokUrl = data?.tunnels?.[0]?.public_url;
              if (ngrokUrl) return json({ active: true, type: 'ngrok', url: ngrokUrl });
            } catch {}
          }
        } catch {}
        return json({ active: false, type: 'unknown' });
      } catch (err: any) { return json({ active: false, error: err.message }); }
    }

    if (method === "POST" && pathname === "/api/remote/tunnel") {
      try {
        const body = await readJSON(req);
        const action = body?.action;
        const tsBin = resolveTailscaleBin();
        if (action === "start") {
          try {
            // `https+insecure://` è la forma che tailscale documenta per un backend
            // HTTPS con certificato self-signed — che è esattamente il nostro
            // listener. Con `http://` il proxy parlava in chiaro contro TLS e il
            // tunnel non saliva mai.
            await runCmd([tsBin, "serve", "--bg", "--https=443", "https+insecure://localhost:3333"]);
            const tsJson = await runCmd([tsBin, "status", "--json"]);
            const tsStatus = JSON.parse(tsJson || '{}');
            const hostname = (tsStatus?.Self?.DNSName || "").replace(/\.$/, "");
            return json({ success: true, url: hostname ? `https://${hostname}` : null, message: 'Esposto sul tailnet' });
          } catch (err: any) { return json({ success: false, error: err.message }, 500); }
        } else if (action === "stop") {
          try {
            // `funnel off` resta SOLO come bonifica: questo pannello non accende
            // più un funnel, ma chi ha premuto il bottone vecchio ne ha uno acceso,
            // e togliere anche la sua unica leva di spegnimento lo lascerebbe
            // pubblicato per sempre. Su un funnel già spento esce non-zero e
            // `runCmd` lo ingoia.
            await runCmd([tsBin, "funnel", "off"]);
            await runCmd([tsBin, "serve", "off"]);
            return json({ success: true, message: 'Esposizione disattivata' });
          } catch (err: any) { return json({ success: false, error: err.message }, 500); }
        }
        return json({ error: "Invalid action" }, 400);
      } catch (err: any) { return json({ error: err.message }, 500); }
    }

    return null;
  };
}
