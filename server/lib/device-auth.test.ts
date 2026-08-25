/**
 * The credential layer under the identity axis: session tokens and their hash,
 * the pairing code, the cookie, and `evaluateIdentity` — which is what answers
 * 401 to a remote peer that presents nothing, a revoked device or an expired
 * session.
 *
 * @covers GUEST-03
 */
import { describe, expect, it } from "bun:test";
import {
  SESSION_COOKIE, SESSION_TTL_MS,
  hashToken, mintSessionToken, mintPairingCode, tokensMatch,
  readSessionCookie, buildSessionCookie, buildClearedSessionCookie,
  evaluateIdentity, isIdentityExemptPath,
  type DeviceRecord, type IdentityInput,
} from "./device-auth";

const NOW = 1_800_000_000_000;

function device(over: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "dev-1",
    name: "iPhone di Attilio",
    tokenHash: hashToken("t".repeat(64)),
    createdAt: NOW - 1000,
    lastSeenAt: NOW - 1000,
    firstIp: "192.168.1.42",
    revokedAt: null,
    role: 'owner',
    ...over,
  };
}

function input(over: Partial<IdentityInput> = {}): IdentityInput {
  return {
    transport: "remote",
    sessionToken: null,
    device: null,
    bearerToken: null,
    expectedDaemonToken: "d".repeat(64),
    now: NOW,
    ...over,
  };
}

describe("device-auth · token", () => {
  it("hashToken è stabile e non restituisce il token", () => {
    const t = "abc";
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(t);
    expect(hashToken(t)).toHaveLength(64);
  });

  it("mintSessionToken dà 32 byte esadecimali, sempre diversi", () => {
    const a = mintSessionToken();
    const b = mintSessionToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("tokensMatch è falso su null, lunghezze diverse e valori diversi", () => {
    const t = "a".repeat(64);
    expect(tokensMatch(t, t)).toBe(true);
    expect(tokensMatch(t, "b".repeat(64))).toBe(false);
    expect(tokensMatch(t, "corto")).toBe(false); // niente throw di timingSafeEqual
    expect(tokensMatch(null, t)).toBe(false);
    expect(tokensMatch(t, null)).toBe(false);
  });
});

describe("device-auth · codice di appaiamento", () => {
  it("sei caratteri in due gruppi di tre", () => {
    expect(mintPairingCode()).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
  });

  it("non usa MAI i caratteri ambigui: il codice si CONFRONTA fra due schermi", () => {
    // 0/O, 1/I/L, 5/S, 8/B letti da un umano su due schermi diversi trasformano
    // un confronto in un dubbio. 200 estrazioni: se uno passasse, esce qui.
    const vietati = /[01O5S8ILB]/;
    for (let i = 0; i < 200; i++) {
      expect(mintPairingCode()).not.toMatch(vietati);
    }
  });
});

describe("device-auth · cookie", () => {
  it("legge il token dall'header Cookie fra gli altri", () => {
    expect(readSessionCookie(`foo=1; ${SESSION_COOKIE}=abc123; bar=2`)).toBe("abc123");
    expect(readSessionCookie(`${SESSION_COOKIE}=solo`)).toBe("solo");
  });

  it("null quando manca, è vuoto, o l'header non c'è", () => {
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie("altro=1")).toBeNull();
    expect(readSessionCookie(`${SESSION_COOKIE}=`)).toBeNull();
  });

  it("non confonde un cookie che CONTIENE il nome con quello giusto", () => {
    expect(readSessionCookie("x_topics_device=intruso")).toBeNull();
  });

  it("il cookie emesso è HttpOnly, SameSite=Lax, Path=/ e Secure su TLS", () => {
    const c = buildSessionCookie("tok", { secure: true });
    expect(c).toContain(`${SESSION_COOKIE}=tok`);
    expect(c).toContain("HttpOnly");       // un XSS non se lo porta via
    expect(c).toContain("SameSite=Lax");   // seconda linea dietro il check d'origine
    expect(c).toContain("Path=/");         // vale anche per /preview, /media, /ws
    expect(c).toContain("Secure");
    expect(c).toContain(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  });

  it("senza TLS il flag Secure NON c'è, o il cookie non verrebbe mai memorizzato", () => {
    expect(buildSessionCookie("tok", { secure: false })).not.toContain("Secure");
  });

  it("il cookie di cancellazione ha età zero", () => {
    expect(buildClearedSessionCookie({ secure: true })).toContain("Max-Age=0");
  });
});

describe("device-auth · evaluateIdentity", () => {
  it("loopback è fidato senza presentare niente: è anche la rete anti-lockout", () => {
    const r = evaluateIdentity(input({ transport: "loopback" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.as).toBe("loopback");
  });

  it("un dispositivo appaiato passa, e porta il suo nome", () => {
    const r = evaluateIdentity(input({ sessionToken: "t", device: device() }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.as).toBe("device");
      expect(r.deviceName).toBe("iPhone di Attilio");
    }
  });

  it("un peer remoto senza niente → 401 device_not_paired", () => {
    const r = evaluateIdentity(input());
    expect(r).toEqual({
      ok: false, status: 401, reason: "device not paired", code: "device_not_paired",
    });
  });

  it("un dispositivo REVOCATO non passa, e il codice lo distingue", () => {
    const r = evaluateIdentity(input({ sessionToken: "t", device: device({ revokedAt: NOW - 1 }) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("device_revoked");
  });

  it("una sessione scaduta non passa", () => {
    const vecchio = device({ lastSeenAt: NOW - SESSION_TTL_MS - 1 });
    const r = evaluateIdentity(input({ sessionToken: "t", device: vecchio }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("session_expired");
  });

  it("il token del daemon copre gli agenti fuori loopback", () => {
    const r = evaluateIdentity(input({ bearerToken: "d".repeat(64) }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.as).toBe("daemon");
  });

  it("un bearer sbagliato non passa", () => {
    expect(evaluateIdentity(input({ bearerToken: "x".repeat(64) })).ok).toBe(false);
  });

  it("nessun token del daemon configurato ⇒ un bearer non apre niente", () => {
    const r = evaluateIdentity(input({ bearerToken: "d".repeat(64), expectedDaemonToken: null }));
    expect(r.ok).toBe(false);
  });
});

describe("device-auth · percorsi esenti", () => {
  it("solo i due che SERVONO a ottenere l'identità", () => {
    expect(isIdentityExemptPath("/api/auth/pair/request")).toBe(true);
    expect(isIdentityExemptPath("/api/auth/session")).toBe(true);
  });

  it("tutto il resto NO — un'esenzione di troppo è un buco", () => {
    for (const p of [
      "/api/topics", "/api/terminal/sessions", "/preview/etc/hosts",
      "/api/auth/devices", "/api/auth/pair/approve", "/ws",
    ]) {
      expect(isIdentityExemptPath(p)).toBe(false);
    }
  });
});

describe("device-auth · il ruolo viaggia con l'identità", () => {
  it("evaluateIdentity porta ruolo e id, così il gate può confinare", () => {
    const ospite = evaluateIdentity(input({ sessionToken: "t", device: device({ role: "guest" }) }));
    expect(ospite.ok).toBe(true);
    if (ospite.ok) { expect(ospite.role).toBe("guest"); expect(ospite.deviceId).toBe("dev-1"); }

    // Loopback e daemon sono proprietari: non c'è un ruolo più alto della
    // macchina su cui gira il server.
    const locale = evaluateIdentity(input({ transport: "loopback" }));
    if (locale.ok) expect(locale.role).toBe("owner");
    const daemon = evaluateIdentity(input({ bearerToken: "d".repeat(64) }));
    if (daemon.ok) expect(daemon.role).toBe("owner");
  });
});
