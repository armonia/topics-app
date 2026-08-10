/**
 * Registra la prova del passaggio di sessione nativa → condivisa.
 *
 * Non è una messinscena: il barattolo che il video applica è ESATTAMENTE il
 * file che `seedSharedFromNative` ha appena scritto sullo store, partendo da un
 * delegate nativo scriptato che risponde nella forma del comando Rust
 * `browser_pane_get_cookies`. Il video mostra cosa quel file fa a un browser
 * vero: prima FUORI, dopo DENTRO.
 *
 *   bun run scripts/handoff-evidence.ts [cartella-di-uscita]
 */
import { mkdtempSync, rmSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const OUT = resolve(process.argv[2] ?? join(process.cwd(), "videos", "handoff"));

const DATA = mkdtempSync(join(tmpdir(), "handoff-evidence-"));
process.env.DATA_DIR = join(DATA, "data");

const { seedSharedFromNative } = await import("../server/browser-session-handoff");
const { createNativeDelegateRegistry } = await import("../server/browser-native-delegate");
const { loadStorageState } = await import("../server/browser-state-store");

const CTX = "evidenza-handoff";
const SID = "sessione-del-mac";

const page = (stato: "DENTRO" | "FUORI", nota: string) => `<!doctype html><html><head>
<meta charset="utf-8"><title>${stato}</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; height:100vh; display:flex; flex-direction:column; align-items:center;
         justify-content:center; gap:18px; font:16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;
         background:#0e1116; color:#e7edf5 }
  .badge { font-size:13px; letter-spacing:.12em; text-transform:uppercase; color:#8b98a8 }
  .stato { font-size:64px; font-weight:650; letter-spacing:-.02em;
           color:${stato === "DENTRO" ? "#4ade80" : "#f87171"} }
  .nota { font-size:15px; color:#9aa7b8; max-width:44ch; text-align:center }
  .jar { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; color:#64748b }
</style></head><body>
<div class="badge">sessione condivisa · contesto ${CTX}</div>
<div class="stato" id="stato">${stato}</div>
<div class="nota">${nota}</div>
<div class="jar">cookie: ${stato === "DENTRO" ? `sid=${SID}` : "(nessuno)"}</div>
</body></html>`;

const site = Bun.serve({
  port: 0,
  fetch(req) {
    const sid = /(?:^|;\s*)sid=([^;]*)/.exec(req.headers.get("cookie") ?? "")?.[1];
    return new Response(
      sid === SID
        ? page("DENTRO", "Il barattolo scritto dal passaggio è arrivato: la sessione condivisa riconosce il login fatto sulla WKWebView nativa.")
        : page("FUORI", "Due cassetti cookie separati: il login fatto sulla WKWebView nativa non attraversa il passaggio alla sessione condivisa."),
      { headers: { "content-type": "text/html" } },
    );
  },
});
const origin = `http://127.0.0.1:${site.port}`;

// ── 1. Il passaggio VERO: pane nativa viva → store della sessione condivisa ──
const registry = createNativeDelegateRegistry();
registry.register(CTX, (msg) => {
  // La risposta ha la forma esatta di `browser_pane_get_cookies` (CookieJson).
  queueMicrotask(() =>
    registry.resolveOp({
      opId: msg.opId,
      result: { cookies: [{ name: "sid", value: SID, domain: "127.0.0.1", path: "/", expires: -1 }], origins: [] },
    }),
  );
});
const esito = await seedSharedFromNative(CTX, { registry });
console.log("[evidenza] passaggio:", JSON.stringify(esito));
if (!esito.ok) throw new Error("il passaggio non ha scritto nulla — niente da filmare");

// Il barattolo che il video userà è quello che il passaggio ha scritto su disco.
const seme = await loadStorageState(CTX);
if (!seme?.cookies?.length) throw new Error("store vuoto dopo il passaggio");
console.log("[evidenza] seme letto dallo store:", JSON.stringify(seme.cookies));

// ── 2. Il filmato ────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 900, height: 560 },
  recordVideo: { dir: OUT, size: { width: 900, height: 560 } },
});
const p = await context.newPage();
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

// PRIMA: la sessione condivisa com'è oggi, senza passaggio.
await p.goto(origin, { waitUntil: "load" });
if ((await p.textContent("#stato")) !== "FUORI") throw new Error("il controllo non è FUORI: il video mentirebbe");
await pausa(3200);

// IL PASSAGGIO: si applica il barattolo scritto da seedSharedFromNative.
await context.addCookies(seme.cookies as never);
await pausa(700);

// DOPO: stessa pagina, stesso contesto, ricaricata.
await p.reload({ waitUntil: "load" });
if ((await p.textContent("#stato")) !== "DENTRO") throw new Error("dopo il passaggio non è DENTRO: il video mentirebbe");
await pausa(3200);

await context.close();
await browser.close();
site.stop(true);

const webm = readdirSync(OUT).find((f) => f.endsWith(".webm"));
if (!webm) throw new Error("nessun .webm prodotto");
const finale = join(OUT, "passaggio-cookie-nativa-condivisa.webm");
copyFileSync(join(OUT, webm), finale);
rmSync(join(OUT, webm), { force: true });
rmSync(DATA, { recursive: true, force: true });
console.log(finale);
