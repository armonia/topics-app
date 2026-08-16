#!/usr/bin/env bun
/**
 * `topics` — Phase H · minimal CLI binary.
 *
 * Distribution: `bun build cli/topics.ts --compile --outfile dist/topics`
 * then symlink to `/usr/local/bin/topics`.
 *
 * Subcommands:
 *
 *   topics open [path]                — POST /api/topics with the resolved
 *                                       path; prints the new topic id.
 *   topics auth status                — show whether a daemon is reachable +
 *                                       the gateway token's presence.
 *   topics auth login                 — open the dashboard so the user
 *                                       authenticates via the existing
 *                                       Supabase / OpenClaw flow.
 *   topics auth logout                — clear `~/.topics/cli.json`.
 *   topics daemon status              — read ~/.topics/daemon-state.json +
 *                                       ping /__daemon/healthz.
 *   topics daemon start               — spawn the bun server detached.
 *   topics daemon stop                — POST /__daemon/shutdown.
 *   topics kill                       — alias for `daemon stop`. Best-
 *                                       effort even when the bearer token
 *                                       is missing (sends SIGTERM directly
 *                                       to the pid in the lock file).
 *
 * No external deps. Reads the daemon state from `~/.topics/daemon-state.json`
 * the same way the Electron app does.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const TOPICS_HOME = process.env.TOPICS_HOME || join(homedir(), ".topics");

interface DaemonState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

interface DaemonHealth {
  pid: number;
  startedAt: string;
  uptime_ms: number;
}

function readDaemonState(): DaemonState | null {
  const path = join(TOPICS_HOME, "daemon-state.json");
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, "utf-8"));
    if (
      typeof obj?.pid === "number" &&
      typeof obj?.port === "number" &&
      typeof obj?.token === "string" &&
      typeof obj?.startedAt === "string"
    ) return obj;
  } catch {}
  return null;
}

/**
 * Lo schema con cui parlare al server locale.
 *
 * Il server accende TLS da solo quando trova i certificati
 * (`server.ts`: `useTls = !NO_TLS && certs/fullchain.pem && certs/key.pem`), e
 * i certificati ci sono dal 3 luglio. La CLI invece aveva `http://` scritto a
 * mano in tre punti: contro un'installazione reale ogni comando moriva sul
 * primo fetch, e la CLI non funzionava e basta. Non era una preferenza da
 * configurare — era la stessa domanda a cui il server risponde da solo.
 *
 * Si prova HTTPS e si ricade su HTTP, invece di leggere i certificati: la CLI
 * gira anche da un binario compilato altrove, dove la cartella `certs/` del
 * server non esiste. Chi vuole forzare la mano ha `TOPICS_SCHEME`.
 */
export function localBase(port: number, scheme: "https" | "http"): string {
  return `${scheme}://127.0.0.1:${port}`;
}

/**
 * `rejectUnauthorized: false` e' ristretto al loopback e a un certificato che
 * il server genera per se stesso: e' lo stesso `curl -k` che gia' usano gli
 * script del repo. Fuori da 127.0.0.1 sarebbe un MITM aperto — non generalizzare.
 */
function localFetchInit(init: RequestInit): RequestInit {
  return { ...init, tls: { rejectUnauthorized: false } } as RequestInit;
}

/**
 * Un fetch che non sa in anticipo se il server locale parla TLS: prova HTTPS,
 * e SOLO su un errore di trasporto (server che chiude, connessione rifiutata)
 * riprova in chiaro. Un 4xx/5xx e' una risposta: quello non si ritenta, perche'
 * lo schema era giusto.
 */
export async function fetchLocal(
  port: number,
  path: string,
  init: RequestInit,
  doFetch: typeof fetch = fetch,
): Promise<Response> {
  const forced = process.env.TOPICS_SCHEME;
  const order: Array<"https" | "http"> =
    forced === "http" ? ["http"] : forced === "https" ? ["https"] : ["https", "http"];
  let lastErr: unknown;
  for (const scheme of order) {
    try {
      return await doFetch(`${localBase(port, scheme)}${path}`, localFetchInit(init));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function daemonRequest(
  state: DaemonState,
  path: string,
  method: "GET" | "POST" = "GET",
): Promise<{ status: number; body: unknown }> {
  const res = await fetchLocal(state.port, path, {
    method,
    headers: { authorization: `Bearer ${state.token}` },
    signal: AbortSignal.timeout(3000),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function apiRequest<T>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  body?: unknown,
): Promise<{ status: number; body: T | null }> {
  const state = readDaemonState();
  // The public REST API doesn't use the daemon token; it's just localhost
  // + (optionally) GATEWAY_TOKEN for /api/agent/*. We use the daemon's
  // port if known, else PORT env, else 3333.
  const port = state?.port ?? Number(process.env.PORT || "3333");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(3000),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetchLocal(port, path, init);
  let parsed: T | null = null;
  try { parsed = (await res.json()) as T; } catch {}
  return { status: res.status, body: parsed };
}

function usage(): string {
  return `Usage: topics <command> [args]

Commands:
  open [path]            Create a new topic for <path> (default: cwd)
  auth status            Show daemon reachability + token state
  auth login             Open the dashboard for browser-based sign-in
  auth logout            Clear the local CLI cache
  daemon status          Show daemon pid + uptime
  daemon start           Spawn the server detached (foreground stays free)
  daemon stop            Graceful shutdown via /__daemon/shutdown
  kill                   Alias for "daemon stop" (SIGTERM fallback)

Env:
  TOPICS_HOME            Override ~/.topics (state files + logs)
  PORT                   Default API port when state file is absent (3333)
  TOPICS_SCHEME          Force "https" or "http" (default: try https, fall back)
`;
}

async function cmdOpen(args: string[]) {
  const targetPath = resolve(args[0] || process.cwd());
  if (!existsSync(targetPath)) {
    console.error(`error: path does not exist: ${targetPath}`);
    process.exit(1);
  }
  const name = `Open ${targetPath.split("/").pop() || targetPath}`;
  const { status, body } = await apiRequest<{ id: string; sessionKey?: string }>(
    "/api/topics", "POST", { name, projectPath: targetPath },
  );
  if (status !== 201 || !body?.id) {
    console.error(`error: server returned ${status}`);
    process.exit(1);
  }
  console.log(body.id);
}

async function cmdAuth(sub: string) {
  if (sub === "status") {
    const state = readDaemonState();
    if (!state) {
      console.log("status: daemon not running (no state file)");
      console.log(`looked at: ${join(TOPICS_HOME, "daemon-state.json")}`);
      return;
    }
    try {
      const { status, body } = await daemonRequest(state, "/__daemon/healthz");
      if (status === 200 && body && typeof body === "object") {
        const b = body as DaemonHealth;
        console.log(`status: online`);
        console.log(`pid:    ${b.pid}`);
        console.log(`uptime: ${Math.round((b.uptime_ms ?? 0) / 1000)}s`);
        console.log(`port:   ${state.port}`);
      } else {
        console.log(`status: state file present but daemon unreachable (HTTP ${status})`);
      }
    } catch (err: any) {
      console.log(`status: state file present but unreachable (${err?.message ?? err})`);
    }
    return;
  }
  if (sub === "login") {
    // Stessa ragione degli altri due: la dashboard locale sta su TLS. Aprire
    // http:// spediva l'utente su una porta che non risponde in chiaro.
    const url = process.env.TOPICS_DASHBOARD_URL || "https://localhost:3333";
    console.log(`opening ${url}`);
    // TOPICS_NO_OPEN lets tests (and headless callers) exercise the command
    // without hijacking the user's default browser with a real tab.
    if (process.env.TOPICS_NO_OPEN) return;
    const opener = process.platform === "darwin" ? "/usr/bin/open" :
                   process.platform === "win32" ? "cmd" : "/usr/bin/xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", url] : [url];
    spawn(opener, args, { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (sub === "logout") {
    const cliPath = join(TOPICS_HOME, "cli.json");
    if (existsSync(cliPath)) unlinkSync(cliPath);
    console.log("ok");
    return;
  }
  console.error(`unknown subcommand: auth ${sub}`);
  process.exit(2);
}

async function cmdDaemon(sub: string) {
  if (sub === "status") {
    return cmdAuth("status"); // identical surface
  }
  if (sub === "start") {
    // Spawn `bun run server.ts` detached. The repo path is whatever the
    // caller cd'd from; for a globally-installed CLI the user must have
    // cloned the repo somewhere — we honour TOPICS_REPO env.
    const repo = process.env.TOPICS_REPO || process.cwd();
    if (!existsSync(join(repo, "server.ts"))) {
      console.error(`error: server.ts not found at ${repo}. Set TOPICS_REPO.`);
      process.exit(1);
    }
    const child = spawn("bun", ["run", "server.ts"], {
      cwd: repo, detached: true, stdio: "ignore",
    });
    // Watch for an early crash so we don't claim success on a child that
    // immediately exits (e.g. port already in use, bad TOPICS_REPO).
    let earlyExit: number | null = null;
    child.once("exit", (code) => { earlyExit = code ?? -1; });
    // Poll the daemon's healthz for a few hundred ms before declaring
    // success — the child rewrites daemon-state.json once it's listening.
    const deadline = Date.now() + 4000;
    let online = false;
    while (Date.now() < deadline && earlyExit === null) {
      const fresh = readDaemonState();
      if (fresh && fresh.pid === child.pid) {
        try {
          const { status } = await daemonRequest(fresh, "/__daemon/healthz");
          if (status === 200) { online = true; break; }
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (earlyExit !== null) {
      console.error(`error: server exited early (code ${earlyExit})`);
      process.exit(1);
    }
    if (!online) {
      console.error(`error: server spawned (pid ${child.pid}) but never became reachable`);
      process.exit(1);
    }
    child.unref();
    console.log(`started detached (pid ${child.pid})`);
    return;
  }
  if (sub === "stop") {
    const state = readDaemonState();
    if (!state) {
      console.log("no daemon-state.json — nothing to stop");
      return;
    }
    try {
      const { status } = await daemonRequest(state, "/__daemon/shutdown", "POST");
      if (status === 202) {
        console.log("shutdown requested");
        return;
      }
      console.log(`shutdown endpoint returned ${status} — falling back to SIGTERM`);
    } catch {
      console.log("daemon unreachable — falling back to SIGTERM");
    }
    try {
      process.kill(state.pid, "SIGTERM");
      console.log(`SIGTERM sent to pid ${state.pid}`);
    } catch (err: any) {
      console.error(`failed to signal pid ${state.pid}: ${err?.message ?? err}`);
      process.exit(1);
    }
    return;
  }
  console.error(`unknown subcommand: daemon ${sub}`);
  process.exit(2);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(usage());
    return;
  }
  switch (cmd) {
    case "open":
      return cmdOpen(rest);
    case "auth":
      return cmdAuth(rest[0] ?? "status");
    case "daemon":
      return cmdDaemon(rest[0] ?? "status");
    case "kill":
      return cmdDaemon("stop");
    default:
      console.error(`unknown command: ${cmd}`);
      console.error(usage());
      process.exit(2);
  }
}

// Solo quando questo file E' il programma. Da quando espone `fetchLocal` e
// `localBase` e' anche un modulo importabile (dal suo test, per cominciare), e
// senza questa guardia bastava importarlo per far partire la CLI: con argv del
// test runner finiva su `unknown command` e `process.exit(2)`.
if (import.meta.main) {
  main().catch((err) => {
    console.error(`error: ${err?.message ?? err}`);
    process.exit(1);
  });
}
