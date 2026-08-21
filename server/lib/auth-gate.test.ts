import { describe, expect, it } from "bun:test";
import {
  evaluateAuth, isLoopbackAddress, isSameSite, isAllowedHost, canonHost, originHost,
  isOriginGatedPath, isWebSocketPath, resolveAllowedOrigins, type AuthInput,
} from "./auth-gate";

// Default sensati = una GET same-site sul server locale. Ogni test sovrascrive
// solo ciò che esercita.
function input(over: Partial<AuthInput> = {}): AuthInput {
  return {
    origin: null,
    method: "GET",
    pathname: "/api/topics",
    host: "127.0.0.1:3333",
    authOff: false,
    ...over,
  };
}

describe("auth-gate · isLoopbackAddress", () => {
  it("accepts v4, v6, and v4-mapped-v6 loopback", () => {
    for (const ip of ["127.0.0.1", "127.0.0.5", "::1", "::ffff:127.0.0.1", "localhost"]) {
      expect(isLoopbackAddress(ip)).toBe(true);
    }
  });
  it("rejects LAN / public / null", () => {
    for (const ip of ["192.168.1.42", "10.0.0.3", "8.8.8.8", "::ffff:192.168.1.1", null]) {
      expect(isLoopbackAddress(ip)).toBe(false);
    }
  });
});

describe("auth-gate · isWebSocketPath", () => {
  it("matches the PRIMARY bare /ws socket AND the /ws/… sub-sockets", () => {
    // Regression: il socket primario è `/ws` (senza slash finale, useWebSocket.ts);
    // chiavare solo su `/ws/` lo lasciava scoperto.
    for (const p of ["/ws", "/ws/terminal/abc", "/ws/browser/xyz"]) {
      expect(isWebSocketPath(p)).toBe(true);
    }
  });
  it("does not match look-alikes", () => {
    for (const p of ["/websocket", "/wsx", "/", "/api/ws"]) {
      expect(isWebSocketPath(p)).toBe(false);
    }
  });
});

describe("auth-gate · isOriginGatedPath", () => {
  it("gates the API, BOTH WS forms (/ws + /ws/…), and every file-serving root", () => {
    for (const p of [
      "/api/topics",
      "/api/files/save",
      "/api/media?path=/etc/passwd",
      "/ws",                 // ← il socket primario, ui-state + chat dal vivo
      "/ws/terminal/abc",
      "/ws/browser/xyz",
      "/preview/Users/x/secret.pdf",
      "/media/browser/downloads/report.pdf",
      "/media/agent-screenshots/x.png",
      "/uploads/attachment.png",
    ]) {
      expect(isOriginGatedPath(p)).toBe(true);
    }
  });
  it("leaves the public SPA / health surface open", () => {
    for (const p of ["/", "/index.html", "/assets/index-abc.js", "/health", "/favicon.ico"]) {
      expect(isOriginGatedPath(p)).toBe(false);
    }
  });
  it("does not gate look-alike prefixes that aren't the real roots", () => {
    for (const p of ["/mediafoo", "/preview", "/apix", "/media", "/websocket", "/uploadsx"]) {
      expect(isOriginGatedPath(p)).toBe(false);
    }
  });
});

describe("auth-gate · canonHost", () => {
  it("collapses every name that means THIS machine into one class", () => {
    const local = canonHost("localhost");
    expect(local).not.toBeNull();
    for (const h of [
      "localhost", "localhost:3333", "LOCALHOST",
      "127.0.0.1", "127.0.0.1:3333", "127.0.0.5",
      "::1", "[::1]", "[::1]:3333", "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1", "tauri.localhost", "app.localhost",
    ]) {
      expect(canonHost(h)).toBe(local!);
    }
  });

  it("strips the port but never mistakes a bare IPv6 for host:port", () => {
    expect(canonHost("192.168.1.12:3333")).toBe("192.168.1.12");
    expect(canonHost("macbook.local:3333")).toBe("macbook.local");
    // Più di un `:` ⇒ IPv6 nudo: non va troncato al primo.
    expect(canonHost("fe80::1234:5678")).toBe("fe80::1234:5678");
    // Fra parentesi la porta si toglie comunque.
    expect(canonHost("[fe80::1]:3333")).toBe("fe80::1");
  });

  it("returns null for nothing and for an unterminated bracket", () => {
    expect(canonHost(null)).toBeNull();
    expect(canonHost("")).toBeNull();
    expect(canonHost("   ")).toBeNull();
    expect(canonHost("[::1")).toBeNull();
  });

  it("keeps LAN, mDNS and public names distinct from each other", () => {
    expect(canonHost("192.168.1.12")).toBe("192.168.1.12");
    expect(canonHost("evil.com")).toBe("evil.com");
    // Regression: `notlocalhost.com` non deve finire nella classe locale.
    expect(canonHost("notlocalhost.com")).toBe("notlocalhost.com");
  });

  it("un NOME che comincia per `127.` non è loopback: solo il LETTERALE lo è", () => {
    // Il buco misurato: `/^127\./` girava sul NOME, quindi qualunque dominio
    // pubblico che comincia per `127.` collassava in `#local`, passava l'asse
    // host, era same-site e arrivava PROPRIETARIO da loopback.
    for (const h of [
      "127.0.0.1.nip.io", "127.0.0.1.nip.io:3333", "127.pwn.evil.com",
      "127.evil.com", "127.0.0.1.evil.com", "1270.0.0.1",
      "::ffff:127.0.0.1.evil.com",
    ]) {
      // Torna sé stesso (porta a parte), cioè NON la classe locale.
      expect(`${h}→${canonHost(h)}`).toBe(`${h}→${h.replace(/:3333$/, "")}`);
    }
    // …e il letterale invece sì, o il controllo passerebbe per il motivo sbagliato.
    expect(canonHost("127.0.0.1")).toBe(canonHost("localhost"));
    expect(canonHost("::ffff:127.0.0.1")).toBe(canonHost("localhost"));
  });

  it("la SENTINELLA non si può mandare come Host", () => {
    // `#local` è il valore di comodo in cui collassa la classe locale: se
    // arrivasse dall'esterno coinciderebbe con essa e verrebbe preso per questa
    // macchina.
    expect(canonHost("#local")).toBeNull();
  });
});

describe("auth-gate · originHost", () => {
  it("reads the hostname out of every origin shape the app produces", () => {
    expect(originHost("https://192.168.1.12:3333")).toBe("192.168.1.12");
    expect(originHost("https://macbook-pro-di-attilio.local:3333")).toBe("macbook-pro-di-attilio.local");
    // `new URL(...).hostname` restituisce l'IPv6 CON le parentesi: vanno tolte.
    expect(originHost("https://[::1]:3333")).toBe(canonHost("localhost"));
  });
  it("returns null for the opaque `null` origin and for garbage", () => {
    expect(originHost("null")).toBeNull();
    expect(originHost("not an origin")).toBeNull();
  });
});

describe("auth-gate · isSameSite", () => {
  it("accepts every origin/host pair the app itself produces", () => {
    // Il guscio Tauri: splice L4, Origin e Host arrivano da due mondi diversi.
    expect(isSameSite("tauri://localhost", "127.0.0.1:13333")).toBe(true);
    expect(isSameSite("http://tauri.localhost", "127.0.0.1:13333")).toBe(true);
    // Il proxy Vite in dev: `changeOrigin: true` riscrive Host e lascia Origin.
    expect(isSameSite("https://localhost:3332", "127.0.0.1:3333")).toBe(true);
    // Il telefono in LAN, per IP e per nome mDNS.
    expect(isSameSite("https://192.168.1.12:3333", "192.168.1.12:3333")).toBe(true);
    expect(isSameSite("https://macbook.local:3333", "macbook.local:3333")).toBe(true);
  });

  it("is blind to scheme and port, as the old isLocalOrigin was", () => {
    expect(isSameSite("http://192.168.1.12:9999", "192.168.1.12:3333")).toBe(true);
  });

  it("rejects a different host, an opaque origin, and a missing side", () => {
    expect(isSameSite("https://evil.com", "192.168.1.12:3333")).toBe(false);
    expect(isSameSite("https://notlocalhost.com", "127.0.0.1:3333")).toBe(false);
    expect(isSameSite("null", "192.168.1.12:3333")).toBe(false);
    expect(isSameSite(null, "192.168.1.12:3333")).toBe(false);
    expect(isSameSite("https://192.168.1.12:3333", null)).toBe(false);
  });
});

describe("auth-gate · isAllowedHost", () => {
  // OGNI strada da cui questa app viene raggiunta davvero. Un 403 sul telefono
  // sarebbe un esito peggiore del buco che questo asse chiude.
  it("accepts every way this app is actually reached", () => {
    for (const h of [
      "127.0.0.1:3333", "localhost:3333", "[::1]:3333", "0:0:0:0:0:0:0:1",
      "tauri.localhost",                 // il guscio Tauri
      "127.0.0.1:13333",                 // il proxy loopback del guscio
      "127.0.0.1:3334",                  // l'ascoltatore del tunnel / relay
      "192.168.1.12:3333", "10.0.0.3:3333", "172.16.4.9",  // la LAN, per IP
      "[fe80::1]:3333", "fe80::1234:5678",                  // la LAN, per IPv6
      "macbook-pro-di-attilio.local:3333",                  // mDNS
      "mac.tail1234.ts.net",                                // Tailscale MagicDNS
    ]) {
      expect(`${h}→${isAllowedHost(h)}`).toBe(`${h}→true`);
    }
  });

  it("accepts the tunnel hostname declared in TOPICS_ALLOWED_ORIGINS", () => {
    // `cloudflared` inoltra l'`Host` originale (docs/tunnel.md), quindi senza
    // questo ramo il tunnel documentato risponderebbe 403 a se stesso.
    const ammesse = ["https://topics.esempio.io"];
    expect(isAllowedHost("topics.esempio.io", ammesse)).toBe(true);
    expect(isAllowedHost("topics.esempio.io:8443", ammesse)).toBe(true);
    // …e anche scritto come hostname nudo: chi configura la variabile fa l'uno
    // o l'altro, e un 403 qui sembrerebbe un guasto.
    expect(isAllowedHost("topics.esempio.io", ["topics.esempio.io"])).toBe(true);
  });

  it("rejects every other DNS name — quello è il rebinding", () => {
    for (const h of [
      "rebind.evil.com:13333", "evil.com", "notlocalhost.com",
      "topics.esempio.io",                       // non dichiarato ⇒ non nostro
      "macbook.local.evil.com", "mac.ts.net.evil.com",
      "ts.net",                                  // il suffisso NUDO non è un nostro nome
      // `local` is no longer here: since a single label passes (own network
      // name, MagicDNS, /etc/hosts), `local` is a name like `topics`, and for
      // the same reason — it does not exist in public DNS. `ts.net` does have a
      // dot, so it stays registrable and stays out.
      "999.1.1.1",                               // sembra un IP, non lo è
    ]) {
      expect(`${h}→${isAllowedHost(h)}`).toBe(`${h}→false`);
    }
  });

  it("rejects PREFIX confusions too — il caso che qui mancava del tutto", () => {
    // Fino a oggi questo elenco aveva solo confusioni di SUFFISSO
    // (`macbook.local.evil.com`), e il buco stava dalla parte opposta: un nome
    // pubblico che COMINCIA per `127.` veniva dichiarato loopback.
    // `127.0.0.1.nip.io` risolve a 127.0.0.1 per chiunque, senza nemmeno
    // registrare un dominio — misurato 200 contro il server vivo.
    for (const h of [
      "127.0.0.1.nip.io", "127.0.0.1.nip.io:3333",
      "127.pwn.evil.com", "127.evil.com", "127.0.0.1.evil.com:13333",
      "::ffff:127.0.0.1.evil.com",
      "localhost.evil.com", "localhost.attacker.io:3333",
      "topics.esempio.io.evil.com",
      "#local",                                  // la sentinella della classe locale
    ]) {
      expect(`${h}→${isAllowedHost(h, ["https://topics.esempio.io"])}`).toBe(`${h}→false`);
    }
  });

  it("lascia passare un Host ASSENTE: chi può ometterlo non è un browser", () => {
    // CLI, tool MCP, hook HTTP. Il rebinding è un attacco da browser, e un
    // browser l'header lo manda sempre.
    expect(isAllowedHost(null)).toBe(true);
    expect(isAllowedHost(undefined)).toBe(true);
    expect(isAllowedHost("   ")).toBe(true);
    // Storto invece è storto: una parentesi mai chiusa non è nessuno di noi.
    expect(isAllowedHost("[::1")).toBe(false);
  });
});

describe("auth-gate · evaluateAuth", () => {
  it("kill-switch bypasses everything (foreign origin, mutation)", () => {
    const r = evaluateAuth(input({ authOff: true, origin: "https://evil.com", method: "POST" }));
    expect(r.allow).toBe(true);
  });

  // ── L'asse che è stato RIMOSSO: nessun peer deve più presentare un token.
  // Prima di `lan-open-same-origin` ognuno di questi era un 401.

  it("un telefono in LAN, senza alcun token, fa una GET → allow", () => {
    const r = evaluateAuth(input({ host: "192.168.1.12:3333", origin: "https://192.168.1.12:3333" }));
    expect(r.allow).toBe(true);
  });

  it("un telefono in LAN, senza alcun token, fa una MUTAZIONE → allow", () => {
    const r = evaluateAuth(input({
      method: "POST", host: "192.168.1.12:3333", origin: "https://192.168.1.12:3333",
    }));
    expect(r.allow).toBe(true);
  });

  it("un telefono in LAN apre il /ws PRIMARIO senza token → allow", () => {
    const r = evaluateAuth(input({
      pathname: "/ws", host: "192.168.1.12:3333", origin: "https://192.168.1.12:3333",
    }));
    expect(r.allow).toBe(true);
  });

  it("un telefono in LAN apre un sub-WS (terminale) senza token → allow", () => {
    const r = evaluateAuth(input({
      pathname: "/ws/terminal/x", host: "192.168.1.12:3333", origin: "https://192.168.1.12:3333",
    }));
    expect(r.allow).toBe(true);
  });

  it("per nome mDNS, che è la strada consigliata (l'IP cambia col DHCP, il nome no)", () => {
    const r = evaluateAuth(input({
      method: "POST",
      host: "macbook-pro-di-attilio.local:3333",
      origin: "https://macbook-pro-di-attilio.local:3333",
    }));
    expect(r.allow).toBe(true);
  });

  // ── L'asse che RESTA: l'origine.

  it("un sito ostile su una MUTAZIONE → 403", () => {
    const r = evaluateAuth(input({ method: "POST", origin: "https://evil.com" }));
    expect(r).toEqual({ allow: false, status: 403, reason: "cross-site origin blocked" });
  });

  it("un sito ostile che punta al TELEFONO, non al loopback → 403", () => {
    // Il caso che la regola vecchia non copriva: prima il check d'origine viveva
    // dentro il ramo loopback, quindi per un peer remoto era irraggiungibile.
    const r = evaluateAuth(input({
      method: "POST", host: "192.168.1.12:3333", origin: "https://evil.com",
    }));
    expect(r).toEqual({ allow: false, status: 403, reason: "cross-site origin blocked" });
  });

  it("un sito ostile su un upgrade WS → 403", () => {
    const r = evaluateAuth(input({ pathname: "/ws/terminal/x", origin: "https://evil.com" }));
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.status).toBe(403);
  });

  // Regression: il socket PRIMARIO è il `/ws` nudo (ui-state + chat dal vivo).
  // Deve ricevere lo stesso trattamento di `/ws/…`, non scivolare fuori.
  it("il /ws nudo con origine forestiera → 403 (il CSRF vale sul socket primario)", () => {
    const r = evaluateAuth(input({ pathname: "/ws", origin: "https://evil.com" }));
    expect(r).toEqual({ allow: false, status: 403, reason: "cross-site origin blocked" });
  });

  it("un'origine OPACA (`null` letterale: about:blank, iframe sandboxed, data:) → 403", () => {
    const r = evaluateAuth(input({ method: "POST", origin: "null" }));
    expect(r).toEqual({ allow: false, status: 403, reason: "cross-site origin blocked" });
  });

  it("una GET con origine forestiera → allow (non muta; a proteggerla è il CORS)", () => {
    // Vedi il commento di testa in auth-gate.ts: la risposta resta illeggibile
    // perché corsAllowOrigin non concede mai un'origine forestiera. Quel patto è
    // pinnato da tests/e2e/lan-same-origin.spec.ts.
    expect(evaluateAuth(input({ method: "GET", origin: "https://evil.com" })).allow).toBe(true);
  });

  it("nessun header Origin su una mutazione → allow (non è un browser)", () => {
    // CLI, tool MCP, hook HTTP, sendBeacon di teardown. Il CSRF è un attacco da
    // browser: chi può omettere l'header è già dentro la macchina o la rete.
    expect(evaluateAuth(input({ method: "POST", origin: null })).allow).toBe(true);
  });

  it("Host assente ⇒ nessuna origine è same-site → 403", () => {
    const r = evaluateAuth(input({ method: "POST", origin: "https://192.168.1.12:3333", host: null }));
    expect(r.allow).toBe(false);
  });

  // ── L'asse HOST: il DNS rebinding, che gli altri due non vedono.

  it("un nome ribattezzato su 127.0.0.1 → 403, anche con un'identità VALIDA", () => {
    // Prima era `allow: true`: `Origin` e `Host` concordano (il sito ostile
    // controlla entrambi), il peer è loopback, quindi l'identità è
    // PROPRIETARIA senza credenziali — e `POST /api/terminal/sessions` da lì è
    // esecuzione di codice arbitrario.
    const r = evaluateAuth(input({
      method: "POST", pathname: "/api/terminal/sessions",
      host: "rebind.evil.com:13333", origin: "https://rebind.evil.com",
      identity: { ok: true },
    }));
    expect(r).toEqual({ allow: false, status: 403, reason: "host not allowed" });
  });

  it("il rebinding SENZA registrare un dominio (`127.0.0.1.nip.io`) → 403", () => {
    // La forma esatta misurata contro il server vivo: `curl` con
    // `Host: 127.0.0.1.nip.io` su `POST /api/terminal/sessions` rispondeva 200,
    // cioè esecuzione di codice arbitrario a chiunque riuscisse a far aprire
    // quella pagina. Il nome non va nemmeno comprato: nip.io lo risolve per
    // tutti, e `sslip.io`/`localtest.me` fanno lo stesso.
    for (const host of ["127.0.0.1.nip.io", "127.0.0.1.nip.io:3333", "127.pwn.evil.com"]) {
      const r = evaluateAuth(input({
        method: "POST", pathname: "/api/terminal/sessions",
        host, origin: `http://${host}`, identity: { ok: true },
      }));
      expect(`${host}→${JSON.stringify(r)}`).toBe(
        `${host}→${JSON.stringify({ allow: false, status: 403, reason: "host not allowed" })}`,
      );
    }
  });

  it("vale anche sulle LETTURE: il rebinding la risposta la legge davvero", () => {
    // Sull'asse d'origine una GET passa perché il CORS la rende illeggibile.
    // Qui no: la pagina crede di essere sulla NOSTRA origine, e il CORS non
    // entra proprio in gioco.
    const r = evaluateAuth(input({ method: "GET", host: "rebind.evil.com:3333", origin: null }));
    expect(r).toEqual({ allow: false, status: 403, reason: "host not allowed" });
  });

  it("e le strade vere restano aperte: IP, .local, .ts.net, origine dichiarata", () => {
    const passa = (host: string, allowedOrigins: string[] = []) => evaluateAuth(input({
      method: "POST", host, origin: `https://${host}`, allowedOrigins, identity: { ok: true },
    })).allow;
    expect(passa("192.168.1.12:3333")).toBe(true);
    expect(passa("macbook-pro-di-attilio.local:3333")).toBe(true);
    expect(passa("mac.tail1234.ts.net")).toBe(true);
    expect(passa("topics.esempio.io", ["https://topics.esempio.io"])).toBe(true);
    // Il guscio Tauri: `Origin` e `Host` vengono da due mondi diversi.
    expect(evaluateAuth(input({
      method: "POST", host: "127.0.0.1:13333", origin: "tauri://localhost", identity: { ok: true },
    })).allow).toBe(true);
  });

  // ── Le origini configurate a mano (un hostname di tunnel).

  it("allowedOrigins lascia passare un'origine configurata", () => {
    const r = evaluateAuth(input({
      method: "POST", origin: "https://tunnel.example", allowedOrigins: ["https://tunnel.example"],
    }));
    expect(r.allow).toBe(true);
  });

  it("un'origine forestiera NON in allowedOrigins → 403", () => {
    const r = evaluateAuth(input({
      method: "POST", origin: "https://evil.com", allowedOrigins: ["https://tunnel.example"],
    }));
    expect(r).toEqual({ allow: false, status: 403, reason: "cross-site origin blocked" });
  });

  // ── La fiducia loopback non è cambiata: questi valevano prima e valgono ora.

  it("loopback GET senza origine → allow", () => {
    expect(evaluateAuth(input()).allow).toBe(true);
  });

  it("loopback POST con l'origine del guscio → allow", () => {
    expect(evaluateAuth(input({ method: "POST", origin: "tauri://localhost", host: "127.0.0.1:13333" })).allow).toBe(true);
    expect(evaluateAuth(input({ method: "POST", origin: "http://localhost:13333" })).allow).toBe(true);
  });

  it("loopback WS con l'origine del guscio → allow", () => {
    expect(evaluateAuth(input({ pathname: "/ws/terminal/x", origin: "tauri://localhost" })).allow).toBe(true);
    expect(evaluateAuth(input({ pathname: "/ws", origin: "tauri://localhost" })).allow).toBe(true);
  });

  it("il proxy Vite in dev, che riscrive Host e non Origin → allow", () => {
    expect(evaluateAuth(input({
      method: "POST", origin: "https://localhost:3332", host: "127.0.0.1:3333",
    })).allow).toBe(true);
  });
});

describe("auth-gate · resolveAllowedOrigins", () => {
  it("parses TOPICS_ALLOWED_ORIGINS as a trimmed, comma-separated, non-empty list", () => {
    const prev = process.env.TOPICS_ALLOWED_ORIGINS;
    process.env.TOPICS_ALLOWED_ORIGINS = " https://a.example , , https://b.example ";
    try {
      expect(resolveAllowedOrigins()).toEqual(["https://a.example", "https://b.example"]);
    } finally {
      if (prev === undefined) delete process.env.TOPICS_ALLOWED_ORIGINS;
      else process.env.TOPICS_ALLOWED_ORIGINS = prev;
    }
  });

  it("rilegge la variabile a ogni chiamata: la cache al primo uso era una trappola", () => {
    // Prima il valore veniva memoizzato al primo accesso, quindi cambiarlo a caldo
    // non aveva effetto e restava quello del boot — su una manopola che ora è viva.
    const prev = process.env.TOPICS_ALLOWED_ORIGINS;
    try {
      process.env.TOPICS_ALLOWED_ORIGINS = "https://uno.example";
      expect(resolveAllowedOrigins()).toEqual(["https://uno.example"]);
      process.env.TOPICS_ALLOWED_ORIGINS = "https://due.example";
      expect(resolveAllowedOrigins()).toEqual(["https://due.example"]);
      delete process.env.TOPICS_ALLOWED_ORIGINS;
      expect(resolveAllowedOrigins()).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.TOPICS_ALLOWED_ORIGINS;
      else process.env.TOPICS_ALLOWED_ORIGINS = prev;
    }
  });
});

describe("origine · l'asse che da curl non si vede", () => {
  // Il difetto: chi entra dal relay ha `Origin: https://app.topics.armonia.io`,
  // ma la richiesta viene RIGIOCATA su loopback, quindi l'host che la macchina
  // vede è `127.0.0.1:3334`. I due non combaciano e ogni scrittura veniva
  // rifiutata con «cross-site origin blocked» — che il client traduce in «non
  // riesco a contattare Topics», cioè la diagnosi sbagliata.
  //
  // Perché era rimasto scoperto: curl l'`Origin` non lo manda, e nemmeno
  // l'APIRequestContext di Playwright. Ogni prova fatta finora saltava proprio
  // il ramo che conta.
  const dal = (origin: string, ammesse: string[] = []) => evaluateAuth({
    method: "POST", pathname: "/api/auth/pair/request",
    origin, host: "127.0.0.1:3334", allowedOrigins: ammesse, authOff: false,
  });

  it("senza allowlist, un'origine che non combacia con l'host è bloccata", () => {
    expect(dal("https://app.topics.armonia.io").allow).toBe(false);
  });

  it("in allowlist passa", () => {
    expect(dal("https://app.topics.armonia.io", ["https://app.topics.armonia.io"]).allow).toBe(true);
  });

  it("e passa SOLO quella: nessun sosia, nessun downgrade", () => {
    // Il rischio di un'allowlist è aprire più di quanto si crede. Si confronta
    // l'origine INTERA, quindi lo schema conta e un suffisso non basta.
    const ammesse = ["https://app.topics.armonia.io"];
    for (const finta of [
      "https://app.topics.armonia.io.cattivo.example",
      "https://cattivo.example",
      "http://app.topics.armonia.io",
      "https://app.topics.armonia.io:8443",
    ]) {
      expect(`${finta}→${dal(finta, ammesse).allow}`).toBe(`${finta}→false`);
    }
  });

  it("una LETTURA non è bloccata: il CSRF riguarda ciò che cambia", () => {
    // Controllo positivo dell'asse: se anche le GET fossero bloccate, i tre
    // casi sopra passerebbero per il motivo sbagliato.
    expect(evaluateAuth({
      method: "GET", pathname: "/api/topics",
      origin: "https://cattivo.example", host: "127.0.0.1:3334", allowedOrigins: [], authOff: false,
    }).allow).toBe(true);
  });
});

describe("nome di rete a un'etichetta sola", () => {
  /**
   * A 403 on your own network name is the fault this rule exists to prevent,
   * and it was happening: from a phone on LAN or on Tailscale the Host is the
   * machine's short name, dot-free, and it was not in the allowlist.
   */
  it("accetta un nome senza punti, con e senza porta", () => {
    expect(isAllowedHost("macbook-pro-di-attilio")).toBe(true);
    expect(isAllowedHost("macbook-pro-di-attilio:3333")).toBe(true);
    expect(isAllowedHost("topics:13333")).toBe(true);
  });

  it("continua a rifiutare un nome PUBBLICO, che i punti ce li ha sempre", () => {
    expect(isAllowedHost("evil.example")).toBe(false);
    expect(isAllowedHost("127.0.0.1.nip.io")).toBe(false);
    expect(isAllowedHost("topics.attacker.com:3333")).toBe(false);
  });
});

describe("FQDN col punto finale", () => {
  /**
   * Bonjour and the iOS resolvers produce the trailing-dot form. Without
   * normalising it our own network name was not recognised: the same 403 this
   * gate exists NOT to give.
   */
  it("riconosce i nostri nomi anche pienamente qualificati", () => {
    expect(isAllowedHost("macbook-pro-di-attilio.local.")).toBe(true);
    expect(isAllowedHost("macbook-pro-di-attilio.local.:3333")).toBe(true);
    expect(isAllowedHost("mac.tail1234.ts.net.")).toBe(true);
  });

  it("non regala niente a un nome forestiero", () => {
    expect(isAllowedHost("evil.com.")).toBe(false);
    expect(isAllowedHost("macbook.local.evil.com.")).toBe(false);
  });

  it("un'origine dichiarata vale anche col punto", () => {
    expect(isAllowedHost("topics.esempio.io.", ["https://topics.esempio.io"])).toBe(true);
  });
});
