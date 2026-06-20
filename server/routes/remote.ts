import type { AppContext, RouteHandler } from "../types";
import { resolveTailscaleBin } from "../lib/tailscale-bin";

/**
 * Remote-access (tunnel) endpoints — detect/toggle a public tunnel exposing the
 * local server (Tailscale Funnel, with cloudflared/ngrok detection). Split out
 * of the topics.ts chat god-file: it's a host/networking concern, not chat.
 * Self-contained (ctx.json/readJSON + resolveTailscaleBin + spawn/fetch).
 */
export function createRemoteRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON } = ctx;

  return async function remoteRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (method === "GET" && pathname === "/api/remote/status") {
      const tsBin = resolveTailscaleBin();
      const runCmd = (cmd: string[]) => {
        const result = Bun.spawnSync(cmd, { stderr: "pipe" });
        return result.exitCode === 0 ? result.stdout.toString().trim() : "";
      };
      try {
        try {
          const serveStatus = runCmd([tsBin, "serve", "status", "--json"]);
          const serve = JSON.parse(serveStatus || '{}');
          const isActive = serve?.TCP?.["3333"] || serve?.Web?.["https://"]?.Handlers?.["/"];
          const tsJson = runCmd([tsBin, "status", "--json"]);
          const tsStatus = JSON.parse(tsJson || '{}');
          const hostname = (tsStatus?.Self?.DNSName || "").replace(/\.$/, "");
          if (isActive && hostname) return json({ active: true, url: `https://${hostname}`, type: 'tailscale' });
        } catch {}
        try {
          const psResult = Bun.spawnSync(["ps", "aux"], { stderr: "pipe" });
          const procs = psResult.stdout.toString();
          const lines = procs.split("\n").filter(l => /cloudflared|lt |ngrok/.test(l) && !l.includes("grep"));
          const line = lines[0] || "";
          if (line.includes('cloudflared') && line.includes('3333')) return json({ active: true, type: 'cloudflare', url: 'Check cloudflared logs' });
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
            Bun.spawnSync([tsBin, "serve", "--bg", "--https=443", "http://localhost:3333"], { stderr: "pipe" });
            Bun.spawnSync([tsBin, "funnel", "--bg", "443"], { stderr: "pipe" });
            const tsJson = Bun.spawnSync([tsBin, "status", "--json"], { stderr: "pipe" });
            const tsStatus = JSON.parse(tsJson.stdout.toString() || '{}');
            const hostname = (tsStatus?.Self?.DNSName || "").replace(/\.$/, "");
            return json({ success: true, url: hostname ? `https://${hostname}` : null, message: 'Tailscale Funnel activated' });
          } catch (err: any) { return json({ success: false, error: err.message }, 500); }
        } else if (action === "stop") {
          try {
            Bun.spawnSync([tsBin, "funnel", "off"], { stderr: "pipe" });
            Bun.spawnSync([tsBin, "serve", "off"], { stderr: "pipe" });
            return json({ success: true, message: 'Tunnel deactivated' });
          } catch (err: any) { return json({ success: false, error: err.message }, 500); }
        }
        return json({ error: "Invalid action" }, 400);
      } catch (err: any) { return json({ error: err.message }, 500); }
    }

    return null;
  };
}
