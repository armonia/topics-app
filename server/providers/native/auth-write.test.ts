/**
 * La scrittura delle credenziali, che è la parte che può fare male.
 *
 * PERCHÉ ESISTE QUESTO FILE. Il ramo del rinnovo gira una volta ogni otto ore:
 * su una macchina con un token fresco resta silenzioso tutto il giorno, e i
 * test d'integrazione non lo toccano mai. Il giorno che sbaglia però riscrive
 * il file di credenziali VERO dell'utente — e sbagliare lì significa lasciare
 * sloggata anche la CLI ufficiale, che è la cosa già successa stanotte per un
 * rinnovo buttato via.
 *
 * Qui si lavora su file finti in una directory temporanea: nessuna credenziale
 * vera viene letta o toccata.
  * @covers RT-02
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeCredentials } from "./auth";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "auth-write-")); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ } });

const NEXT = {
  accessToken: "nuovo-access",
  refreshToken: "nuovo-refresh",
  expiresAt: 1_800_000_000_000,
};

describe("riscrivere il formato di Claude Code", () => {
  test("aggiorna i tre campi e NON perde il resto del file", () => {
    const p = join(dir, "creds.json");
    writeFileSync(p, JSON.stringify({
      claudeAiOauth: {
        accessToken: "vecchio", refreshToken: "vecchio-r", expiresAt: 1,
        scopes: ["user:inference"], subscriptionType: "max",
      },
      // Campi che non conosciamo: un domani la CLI ne aggiunge altri, e
      // cancellarli sarebbe rompere il file di un programma che non è nostro.
      altroCampo: { qualcosa: true },
    }, null, 2));

    writeCredentials(p, NEXT);

    const out = JSON.parse(readFileSync(p, "utf-8"));
    expect(out.claudeAiOauth.accessToken).toBe("nuovo-access");
    expect(out.claudeAiOauth.refreshToken).toBe("nuovo-refresh");
    expect(out.claudeAiOauth.expiresAt).toBe(NEXT.expiresAt);
    // Sopravvive ciò che non abbiamo cambiato.
    expect(out.claudeAiOauth.subscriptionType).toBe("max");
    expect(out.claudeAiOauth.scopes).toEqual(["user:inference"]);
    expect(out.altroCampo).toEqual({ qualcosa: true });
  });
});

describe("riscrivere il formato di jcode", () => {
  test("scrive nell'account giusto e lascia stare gli altri", () => {
    const p = join(dir, "auth.json");
    writeFileSync(p, JSON.stringify({
      anthropic_accounts: [
        { label: "primo", access: "vecchio", refresh: "vecchio-r", expires: 1 },
        // Un secondo account NON deve essere toccato: si rinnova quello che si
        // è letto, non tutti.
        { label: "secondo", access: "altro", refresh: "altro-r", expires: 2 },
      ],
      openai_accounts: [{ label: "x" }],
    }, null, 2));

    writeCredentials(p, NEXT);

    const out = JSON.parse(readFileSync(p, "utf-8"));
    expect(out.anthropic_accounts[0].access).toBe("nuovo-access");
    expect(out.anthropic_accounts[0].refresh).toBe("nuovo-refresh");
    expect(out.anthropic_accounts[0].label).toBe("primo");
    expect(out.anthropic_accounts[1]).toEqual({
      label: "secondo", access: "altro", refresh: "altro-r", expires: 2,
    });
    expect(out.openai_accounts).toEqual([{ label: "x" }]);
  });
});

describe("le garanzie che valgono per entrambi i formati", () => {
  test("il file resta leggibile SOLO dall'utente (0600)", () => {
    const p = join(dir, "perms.json");
    writeFileSync(p, JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "b", expiresAt: 1 } }));
    writeCredentials(p, NEXT);
    // Un file di credenziali leggibile dal resto del sistema è peggio di uno
    // scritto male: quello si nota, questo no.
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test("un file illeggibile non blocca il rinnovo: si riscrive da zero", () => {
    // Il caso vero: JSON troncato da un crash precedente. Perdere il rinnovo
    // perché il file era già rotto sarebbe farsi male due volte.
    const p = join(dir, "rotto.json");
    writeFileSync(p, "{ questo non e' json");
    writeCredentials(p, NEXT);
    const out = JSON.parse(readFileSync(p, "utf-8"));
    expect(out.claudeAiOauth.accessToken).toBe("nuovo-access");
  });

  test("un file che non esisteva viene creato nel formato di Claude Code", () => {
    const p = join(dir, "nuovo.json");
    writeCredentials(p, NEXT);
    const out = JSON.parse(readFileSync(p, "utf-8"));
    expect(out.claudeAiOauth.refreshToken).toBe("nuovo-refresh");
  });

  // IL PUNTO DELLA SCRITTURA ATOMICA: il file non deve MAI esistere a metà.
  test("il contenuto è sempre JSON completo, mai troncato", () => {
    const p = join(dir, "atomico.json");
    writeFileSync(p, JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "b", expiresAt: 1 } }));
    for (let i = 0; i < 20; i++) {
      writeCredentials(p, { ...NEXT, accessToken: `giro-${i}` });
      const raw = readFileSync(p, "utf-8");
      // Se rename non fosse atomico, o se si scrivesse in place, qui si
      // vedrebbe un JSON monco almeno una volta.
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(JSON.parse(raw).claudeAiOauth.accessToken).toBe(`giro-${i}`);
    }
  });
});
