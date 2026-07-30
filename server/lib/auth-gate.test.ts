import { describe, expect, it } from "bun:test";
import { evaluateAuth, isLoopbackAddress, isLocalOrigin, isAuthGatedPath, isWebSocketPath, resolveAllowedOrigins, type AuthInput } from "./auth-gate";

const TOKEN = "a".repeat(64);

// Sensible defaults = a loopback GET with the real token available. Each test
// overrides only what it exercises.
function input(over: Partial<AuthInput> = {}): AuthInput {
  return {
    ip: "127.0.0.1",
    origin: null,
    method: "GET",
    pathname: "/api/topics",
    token: null,
    expectedToken: TOKEN,
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
    // Regression: the primary client socket is `/ws` (no trailing slash,
    // useWebSocket.ts); keying only on `/ws/` left it ungated.
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

describe("auth-gate · isAuthGatedPath", () => {
  it("gates the API, BOTH WS forms (/ws + /ws/…), and every file-serving root", () => {
    for (const p of [
      "/api/topics",
      "/api/files/save",
      "/api/media?path=/etc/passwd",
      "/ws",                 // ← the primary ui-state + live-chat socket
      "/ws/terminal/abc",
      "/ws/browser/xyz",
      "/preview/Users/x/secret.pdf",
      "/media/browser/downloads/report.pdf",
      "/media/agent-screenshots/x.png",
      "/uploads/attachment.png",
    ]) {
      expect(isAuthGatedPath(p)).toBe(true);
    }
  });
  it("leaves the public SPA / health surface open", () => {
    for (const p of ["/", "/index.html", "/assets/index-abc.js", "/health", "/favicon.ico"]) {
      expect(isAuthGatedPath(p)).toBe(false);
    }
  });
  it("does not gate look-alike prefixes that aren't the real roots", () => {
    // guards against a `/mediafoo` or `/previews` bypass illusion — the trailing
    // slash in the prefixes means only the actual roots match (and /ws is exact).
    for (const p of ["/mediafoo", "/preview", "/apix", "/media", "/websocket", "/uploadsx"]) {
      expect(isAuthGatedPath(p)).toBe(false);
    }
  });
});

describe("auth-gate · isLocalOrigin", () => {
  it("accepts every origin the app itself uses", () => {
    for (const o of [
      "tauri://localhost",
      "http://tauri.localhost",
      "https://tauri.localhost",
      "http://localhost:13333",
      "https://localhost:3333",
      "http://127.0.0.1:3333",
    ]) {
      expect(isLocalOrigin(o)).toBe(true);
    }
  });
  it("rejects external sites", () => {
    for (const o of ["https://evil.com", "http://attacker.example", "https://notlocalhost.com"]) {
      expect(isLocalOrigin(o)).toBe(false);
    }
  });
});

describe("auth-gate · evaluateAuth", () => {
  it("kill-switch bypasses everything (remote, no token, foreign origin)", () => {
    const r = evaluateAuth(input({ authOff: true, ip: "8.8.8.8", token: null, origin: "https://evil.com", method: "POST" }));
    expect(r.allow).toBe(true);
  });

  it("loopback GET with no token/origin → allow", () => {
    expect(evaluateAuth(input()).allow).toBe(true);
  });

  it("loopback POST with a LOCAL origin → allow", () => {
    expect(evaluateAuth(input({ method: "POST", origin: "tauri://localhost" })).allow).toBe(true);
    expect(evaluateAuth(input({ method: "POST", origin: "http://localhost:13333" })).allow).toBe(true);
  });

  it("loopback POST with a FOREIGN origin → 403 (CSRF)", () => {
    const r = evaluateAuth(input({ method: "POST", origin: "https://evil.com" }));
    expect(r).toEqual({ allow: false, status: 403, reason: "cross-site origin blocked" });
  });

  it("loopback GET with a foreign origin → allow (GET is not mutating, not WS)", () => {
    expect(evaluateAuth(input({ method: "GET", origin: "https://evil.com" })).allow).toBe(true);
  });

  it("loopback WS upgrade with a foreign origin → 403", () => {
    const r = evaluateAuth(input({ pathname: "/ws/terminal/x", origin: "https://evil.com" }));
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.status).toBe(403);
  });

  it("loopback WS upgrade with a local origin → allow", () => {
    expect(evaluateAuth(input({ pathname: "/ws/terminal/x", origin: "tauri://localhost" })).allow).toBe(true);
  });

  // Regression: the PRIMARY socket is the bare `/ws` (ui-state + live chat). It
  // must get the SAME token + CSRF treatment as `/ws/…`, not slip through.
  it("bare /ws with a foreign origin → 403 (CSRF applies to the primary socket)", () => {
    const r = evaluateAuth(input({ pathname: "/ws", origin: "https://evil.com" }));
    expect(r).toEqual({ allow: false, status: 403, reason: "cross-site origin blocked" });
  });

  it("bare /ws from a remote peer with NO token → 401", () => {
    const r = evaluateAuth(input({ pathname: "/ws", ip: "192.168.1.5", token: null }));
    expect(r).toEqual({ allow: false, status: 401, reason: "pairing token required for remote access" });
  });

  it("bare /ws on loopback with a local origin → allow (the real app is unaffected)", () => {
    expect(evaluateAuth(input({ pathname: "/ws", origin: "tauri://localhost" })).allow).toBe(true);
  });

  it("remote with the valid token → allow", () => {
    expect(evaluateAuth(input({ ip: "192.168.1.5", token: TOKEN })).allow).toBe(true);
  });

  it("remote with NO token → 401", () => {
    const r = evaluateAuth(input({ ip: "192.168.1.5", token: null }));
    expect(r).toEqual({ allow: false, status: 401, reason: "pairing token required for remote access" });
  });

  it("remote with a WRONG token (same length) → 401", () => {
    expect(evaluateAuth(input({ ip: "192.168.1.5", token: "b".repeat(64) })).allow).toBe(false);
  });

  it("remote with a wrong-length token → 401 (no timingSafeEqual throw)", () => {
    expect(evaluateAuth(input({ ip: "192.168.1.5", token: "short" })).allow).toBe(false);
  });

  // LAN-PAIR-02: a valid token from a remote peer IS the CSRF proof — a hostile
  // site can neither learn the 256-bit token nor set x-topics-token cross-origin
  // (that trips a preflight the server refuses). So a token-authed remote peer is
  // allowed WITHOUT the foreign-origin block. (Previously this returned 403.)
  it("remote with valid token AND foreign origin on a mutation → allow (token bypasses CSRF)", () => {
    const r = evaluateAuth(input({ ip: "192.168.1.5", token: TOKEN, method: "POST", origin: "http://192.168.1.12:3333" }));
    expect(r.allow).toBe(true);
  });

  it("remote with valid token AND foreign origin on a WS upgrade → allow", () => {
    const r = evaluateAuth(input({ ip: "192.168.1.5", token: TOKEN, pathname: "/ws", origin: "http://192.168.1.12:3333" }));
    expect(r.allow).toBe(true);
  });

  it("remote with valid token AND foreign origin on a sub-WS (/ws/…) → allow", () => {
    const r = evaluateAuth(input({ ip: "192.168.1.5", token: TOKEN, pathname: "/ws/terminal/x", origin: "https://evil.com" }));
    expect(r.allow).toBe(true);
  });

  it("null ip is treated as non-loopback → needs a token", () => {
    expect(evaluateAuth(input({ ip: null, token: null })).allow).toBe(false);
    expect(evaluateAuth(input({ ip: null, token: TOKEN })).allow).toBe(true);
  });

  it("no expectedToken configured → remote can never authenticate", () => {
    expect(evaluateAuth(input({ ip: "192.168.1.5", token: "whatever", expectedToken: null })).allow).toBe(false);
  });

  // LAN-PAIR-02: the previously-dead allowedOrigins branch, now reachable, on the
  // LOOPBACK CSRF path (default ip 127.0.0.1) — an operator-configured extra origin.
  it("explicit allowedOrigins lets a configured origin through a loopback mutation", () => {
    expect(evaluateAuth(input({ method: "POST", origin: "https://phone.pwa", allowedOrigins: ["https://phone.pwa"] })).allow).toBe(true);
  });

  it("loopback mutation with a foreign origin NOT in allowedOrigins → 403", () => {
    const r = evaluateAuth(input({ method: "POST", origin: "https://evil.com", allowedOrigins: ["https://phone.pwa"] }));
    expect(r).toEqual({ allow: false, status: 403, reason: "cross-site origin blocked" });
  });
});

describe("auth-gate · resolveAllowedOrigins", () => {
  it("parses TOPICS_ALLOWED_ORIGINS as a trimmed, comma-separated, non-empty list", () => {
    // Cached on first call; set env before the first read in this fresh process.
    const prev = process.env.TOPICS_ALLOWED_ORIGINS;
    process.env.TOPICS_ALLOWED_ORIGINS = " https://a.example , , https://b.example ";
    try {
      expect(resolveAllowedOrigins()).toEqual(["https://a.example", "https://b.example"]);
    } finally {
      if (prev === undefined) delete process.env.TOPICS_ALLOWED_ORIGINS;
      else process.env.TOPICS_ALLOWED_ORIGINS = prev;
    }
  });
});
