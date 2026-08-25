/**
 * Serializzazione inter-processo del refresh OAuth.
 *
 * COSA PROVA. Il refresh token RUOTA a ogni rinnovo: due processi che rinnovano
 * in parallelo si invalidano a vicenda. Questo test lancia N processi contemporanei
 * che chiamano `getAccessToken` contro un server finto che conta le richieste e
 * ruota il token. Devono arrivare UNA sola richiesta e tutti i processi devono
 * uscire con lo stesso access token.
 *
 * STRUTTURA. Il test si basa su tre pezzi:
 * 1. Un server HTTP locale (Bun.serve) che simula l'endpoint OAuth.
 * 2. Un file di credenziali scaduto in una directory temporanea isolata.
 * 3. N processi (Bun.spawn) che chiamano `getAccessToken` con HOME
 *    sovrascritta alla directory temporanea e OAUTH_TOKEN_URL_OVERRIDE
 *    puntato al server finto.
 *
 * Nessuna credenziale vera viene letta o toccata.
  * @covers RT-02
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { tokenUrlFromEnv, OAUTH_TOKEN_URL_DEFAULT } from "./auth";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Configurazione del test
// ---------------------------------------------------------------------------

/** Quanti processi concorrenti. */
const N_PROCESSES = 6;

/** Percorso assoluto del worker (*.fixture.ts = processo lanciato da un test, non importato). */
const WORKER_PATH = join(import.meta.dir, "auth-lock-worker.fixture.ts");

// ---------------------------------------------------------------------------
// Stato del server finto
// ---------------------------------------------------------------------------

let requestCount = 0;
let currentRefreshToken = "refresh-iniziale";
let currentAccessToken = "access-token-0";
let tokenGeneration = 0;

let server: ReturnType<typeof Bun.serve>;
let tokenUrl: string;
let tempDir: string;
let credPath: string;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Server finto: conta le richieste e ruota il refresh token.
  server = Bun.serve({
    port: 0, // porta libera scelta dal kernel
    fetch(req) {
      requestCount++;
      const gen = ++tokenGeneration;
      const newAccess = `access-token-${gen}`;
      const newRefresh = `refresh-${gen}`;
      currentRefreshToken = newRefresh;
      currentAccessToken = newAccess;
      return Response.json({
        access_token: newAccess,
        refresh_token: newRefresh,
        expires_in: 28800,
        scope: "user:inference",
      });
    },
  });
  tokenUrl = `http://localhost:${server.port}/v1/oauth/token`;

  // Directory temporanea isolata con credenziali SCADUTE.
  tempDir = mkdtempSync(join(tmpdir(), "auth-lock-test-"));
  const claudeDir = join(tempDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  credPath = join(claudeDir, ".credentials.json");
  writeFileSync(
    credPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "access-scaduto",
        refreshToken: currentRefreshToken,
        expiresAt: Date.now() - 60_000, // scaduto da un minuto
      },
    }),
    { mode: 0o600 },
  );
});

afterAll(() => {
  server.stop(true);
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* scratch */ }
});

// ---------------------------------------------------------------------------
// Il test vero
// ---------------------------------------------------------------------------

describe("lock inter-processo sul refresh OAuth", () => {
  /**
   * ROSSO PRIMA DEL FIX. Questo test documenterebbe il problema originale:
   * senza lock, N processi fanno N richieste di refresh, e il primo che salva
   * invalida tutti gli altri. Con il lock, una sola richiesta arriva al server.
   */
  test(`${N_PROCESSES} processi concorrenti fanno UN SOLO rinnovo`, async () => {
    // Lancia tutti i processi insieme, senza aspettare l'uno prima dell'altro.
    const procs = Array.from({ length: N_PROCESSES }, () =>
      Bun.spawn(["bun", "--smol", WORKER_PATH], {
        env: {
          ...process.env,
          HOME: tempDir,
          OAUTH_TOKEN_URL_OVERRIDE: tokenUrl,
        },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

    // Raccoglie i risultati di tutti i processi.
    const results = await Promise.all(
      procs.map(async (proc) => {
        const [code, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { code, token: stdout.trim(), stderr };
      }),
    );

    // Tutti devono uscire con codice 0.
    for (const r of results) {
      expect(r.code).toBe(0);
    }

    // Tutti devono avere ottenuto un token.
    const tokens = results.map((r) => r.token);
    for (const tok of tokens) {
      expect(tok).toBeTruthy();
      expect(tok).not.toBe("access-scaduto");
    }

    // GARANZIA PRINCIPALE: una sola richiesta di rinnovo al server.
    // Senza lock, N processi farebbero N richieste.
    expect(requestCount).toBe(1);

    // Tutti i processi devono avere ottenuto lo stesso access token.
    const unique = new Set(tokens);
    expect(unique.size).toBe(1);
  }, 30_000);
});

describe("OAUTH_TOKEN_URL_OVERRIDE accetta solo il loopback", () => {
  // E' l'indirizzo a cui viene spedito il REFRESH TOKEN: senza vincolo, una
  // variabile d'ambiente qualunque lo manderebbe altrove e la risposta finirebbe
  // scritta nel file delle credenziali dell'utente. Il test che la usa alza un
  // server finto su 127.0.0.1, quindi il vincolo non gli costa niente.
  test("un indirizzo di loopback passa", () => {
    expect(tokenUrlFromEnv("http://127.0.0.1:41234/token")).toBe("http://127.0.0.1:41234/token");
    expect(tokenUrlFromEnv("http://localhost:8080/t")).toBe("http://localhost:8080/t");
    expect(tokenUrlFromEnv("http://[::1]:9/t")).toBe("http://[::1]:9/t");
  });

  test("qualunque altro host viene ignorato", () => {
    expect(tokenUrlFromEnv("https://evil.example/token")).toBeNull();
    // Il trucco classico: il loopback nel path o nella userinfo, non nell'host.
    expect(tokenUrlFromEnv("https://evil.example/127.0.0.1/token")).toBeNull();
    expect(tokenUrlFromEnv("https://127.0.0.1@evil.example/token")).toBeNull();
  });

  test("vuota o malformata: vale il default, non un buco", () => {
    expect(tokenUrlFromEnv(undefined)).toBeNull();
    expect(tokenUrlFromEnv("")).toBeNull();
    expect(tokenUrlFromEnv("non-un-url")).toBeNull();
    expect(OAUTH_TOKEN_URL_DEFAULT).toContain("platform.claude.com");
  });
});
