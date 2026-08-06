import { describe, expect, it } from "bun:test";
import {
  evaluateAuth, isLoopbackAddress, isSameSite, canonHost, originHost,
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
