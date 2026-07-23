import { describe, expect, it } from "bun:test";
import { evaluateAuth, isLoopbackAddress, isLocalOrigin, type AuthInput } from "./auth-gate";

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

  it("remote with valid token BUT foreign origin on a mutation → 403 (token ok, CSRF still blocks)", () => {
    const r = evaluateAuth(input({ ip: "192.168.1.5", token: TOKEN, method: "POST", origin: "https://evil.com" }));
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.status).toBe(403);
  });

  it("null ip is treated as non-loopback → needs a token", () => {
    expect(evaluateAuth(input({ ip: null, token: null })).allow).toBe(false);
    expect(evaluateAuth(input({ ip: null, token: TOKEN })).allow).toBe(true);
  });

  it("no expectedToken configured → remote can never authenticate", () => {
    expect(evaluateAuth(input({ ip: "192.168.1.5", token: "whatever", expectedToken: null })).allow).toBe(false);
  });

  it("explicit allowedOrigins lets a paired PWA host through a mutation", () => {
    expect(evaluateAuth(input({ method: "POST", origin: "https://phone.pwa", allowedOrigins: ["https://phone.pwa"] })).allow).toBe(true);
  });
});
