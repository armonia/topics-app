/**
 * The loopback control endpoints of the daemon (`/__daemon/*`): health, idle, shutdown, restart-when-idle, primary switch and reclaim, and worktree GC.
 * Every one of them is gated by the allowed-host check, the local-transport check and the daemon token.
 */
import { handlePrimaryReclaim, handlePrimarySwitch } from "./primary-switch-trigger";
import { readState, uptimeMsSince } from "../services/daemon-state";
import { aiBridgeEnabled } from "../providers/claude-code";
import { nativeDetachedEnabled } from "../providers/native/detached-turn";
import { isAllowedHost, isLoopbackAddress, resolveAllowedOrigins } from "../lib/auth-gate";
import { isLocalTransport } from "../lib/tunnel";
import type { Server } from "bun";
import type { WSData } from "../types";
import type { AfterHttp } from "../boot/scope";
import { late } from "../boot/late";

export function createDaemonControl(scope: Pick<AfterHttp, "BOOT_COMMIT" | "abortHeadlessTurn" | "attesaQuiescenza" | "bundleProbe" | "ctx" | "dispatcherSvc" | "taskDispatcher" | "timingSafeEqualStr" | "waitForDispatcherQuiescent" | "whatIsStillWorking" | "worktreeGc">) {
  const { BOOT_COMMIT, abortHeadlessTurn, attesaQuiescenza, bundleProbe, ctx, dispatcherSvc, taskDispatcher, timingSafeEqualStr, waitForDispatcherQuiescent, whatIsStillWorking, worktreeGc } = scope;
  return async function daemonControl(req: Request, server: Server<WSData>, url: URL, pathname: string, method: string): Promise<Response | undefined> {
    // Phase B · DAEMON-02: token-authed LOOPBACK control endpoints.
    // We read the state file fresh on every call so a state-file rewrite
    // (e.g. token rotation in a future phase) takes effect immediately.
    //
    // LAN-OPEN-02: il "loopback" del commento non era nel codice — si guardava solo
    // il token. Finché ogni peer remoto doveva comunque presentarne uno per l'API
    // il divario restava teorico; da quando la LAN è aperta (change
    // `lan-open-same-origin`) non lo è più, perché il token del daemon è leggibile
    // da chiunque sia sulla rete via `/preview/…/.topics/daemon-state.json`. Il
    // peer va quindi respinto PRIMA di guardare il token, e il confronto è a tempo
    // costante. Costo zero per chi lo usa davvero: `cli/topics.ts`, la sonda del
    // guscio Tauri e la procedura di reload chiamano tutte da 127.0.0.1.
    if (pathname.startsWith("/__daemon/")) {
      // L'ASSE HOST, per primo, come in `evaluateAuth`. Loopback + token non
      // bastano contro il DNS rebinding: una pagina su un dominio che l'attaccante
      // fa risolvere a 127.0.0.1 arriva qui DA loopback, e il token del daemon e'
      // leggibile da chi e' sulla LAN (`/preview/…/.topics/daemon-state.json`).
      // Un `Host` assente passa per contratto: la CLI, i tool MCP e gli hook non
      // lo mandano, e sono gia' sulla macchina. Vedi `isAllowedHost`.
      if (!isAllowedHost(req.headers.get("host"), resolveAllowedOrigins())) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401, headers: { "content-type": "application/json" },
        });
      }
      // Attraverso il tunnel il peer e' 127.0.0.1: senza questa domanda,
      // gli endpoint del daemon sarebbero aperti a Internet.
      if (!isLocalTransport(req, server.requestIP(req)?.address ?? null, isLoopbackAddress)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401, headers: { "content-type": "application/json" },
        });
      }
      const fresh = readState();
      const auth = req.headers.get("authorization") || "";
      const match = auth.match(/^Bearer\s+([0-9a-f]{64})$/i);
      const token = match?.[1] ?? "";
      if (!fresh || token.length !== 64 || !timingSafeEqualStr(token, fresh.token)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401, headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && pathname === "/__daemon/healthz") {
        const bundle = bundleProbe.check();
        return new Response(JSON.stringify({
          pid: fresh.pid,
          startedAt: fresh.startedAt,
          uptime_ms: uptimeMsSince(fresh.startedAt),
          // What the browser would get right now: `ok:false` means the app
          // serves nothing, whatever the rest of this object says.
          bundle: { ok: bundle.ok, missing: bundle.reason, since: bundle.since },
          // A restart loses no turn: native turns run detached under the AI
          // broker, which keeps the CLI's too. The update scripts read this to
          // skip the wait for a window at zero turns (lossless-restart).
          losslessRestart: aiBridgeEnabled() && nativeDetachedEnabled(),
          // The commit this process booted on: what a client publish waits for.
          commit: BOOT_COMMIT,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && pathname === "/__daemon/shutdown") {
        // Reply first so the caller sees 202; SIGTERM ourselves a tick
        // later so the existing graceful-shutdown handler runs.
        setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
        return new Response(JSON.stringify({ ok: true }), {
          status: 202, headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && pathname === "/__daemon/idle") {
        // "Is a turn in flight?" - READ-ONLY. Whoever wants a conditional restart
        // (the Mac hub) must be able to ask first, without committing:
        // `restart-when-idle` opens a wait and then sends the SIGTERM, and the
        // only way to learn the state was to start it.
        //
        // This does NOT call `waitForDispatcherQuiescent`, does no
        // `drain`/`undrain` and sends no signal: it reads the predicates the gate
        // uses (`whatIsStillWorking`, which composes `describeInFlight` and
        // `chatsHolding`). A GET that changed their state would close the
        // dispatcher door or restart the server for someone who only wanted to
        // look: the test holds that still.
        const { busy: holding, cards, unadoptable, working, waitingOnPerson } = await whatIsStillWorking();
        return new Response(JSON.stringify({
          // Is anything WORKING? A chat blocked on a question nobody has answered
          // is alive and holds the restart for its chat minute (so `holding` names
          // it), but it is not a turn in flight: nothing computes while a person
          // thinks, and the question has no clock (RGATE-12). Reading `holding`
          // as "idle" kept a Mac awake for ten hours under one open panel.
          idle: !working,
          inFlight: taskDispatcher.busyCount(),
          // `null` = nothing is holding. Same sentence the gate puts in the log,
          // parked questions included.
          holding,
          // Whoever does not come back after a restart: the same sum the gate
          // passes to `quiescenceVerdict` as `unrecoverable`.
          unrecoverable: cards + unadoptable,
          // The chats waiting for a person (question or permission on screen).
          waitingOnPerson,
          alreadyWaiting: attesaQuiescenza.inProgress() !== null,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && pathname === "/__daemon/restart-when-idle") {
        // Graceful restart that WAITS for agent turns to finish first — the
        // safe way to apply a server fix without cutting a working agent
        // (use this instead of `kickstart -k`, which SIGKILLs mid-turn).
        // Reply 202 now; wait for quiescence, then SIGTERM ourselves so
        // gracefulShutdown runs and launchd/start-prod.sh relaunches.
        const busy = taskDispatcher.busyCount();
        // ASKING AGAIN JOINS THE WAIT, and the answer says so.
        //
        // A 202 identical to the first one is why a retry feels like a fix: on
        // 2026-09-10 this route was asked five times while one native chat turn
        // held the gate, and every answer read "accepted, 0 in flight" - true,
        // and useless, because what the second caller needs to know is that a
        // wait is ALREADY running and WHO is holding it.
        //
        // The SIGTERM is attached unconditionally, by every caller, and that is
        // deliberate: `gracefulShutdown` has a re-entrancy guard, so the second
        // signal is a logged no-op, whereas attaching it only when this caller
        // STARTED the wait would make the restart depend on which call site
        // opened it - and a future one that forgets to attach would leave a
        // wait that ends in nothing.
        const pending = attesaQuiescenza.inProgress();
        // `?zeroTurns=1`: the watcher asks this way when the production checkout
        // moved by a LAND, not by a save (RGATE-09). Then a chat that is working
        // defers like a card instead of being cut after its minute.
        if (url.searchParams.get("zeroTurns") === "1") late.restartAtZeroTurns = true;
        void waitForDispatcherQuiescent("restart-when-idle").then(() => {
          process.kill(process.pid, "SIGTERM");
        });
        const { busy: holding } = await whatIsStillWorking();
        return new Response(JSON.stringify({
          ok: true,
          inFlight: busy,
          alreadyWaiting: pending !== null,
          waitingForMs: pending ? Date.now() - pending.startedAt : 0,
          zeroTurns: late.restartAtZeroTurns,
          // `null` = nothing is holding, so the restart is a tick away.
          holding,
        }), {
          status: 202, headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && pathname === "/__daemon/primary-reclaim") {
        // `bun run primary reclaim`: takes the primary back after an uncertain switch (routes/primary-switch-trigger.ts).
        return handlePrimaryReclaim({ ctx });
      }
      if (method === "POST" && pathname === "/__daemon/primary-switch") {
        // `bun run primary switch <machine>`: hands this primary over (track T4, routes/primary-switch-trigger.ts).
        return handlePrimarySwitch(req, {
          ctx,
          dispatcher: taskDispatcher,
          release: (args) => dispatcherSvc.release(args),
          abortTurn: abortHeadlessTurn,
        });
      }
      if (method === "POST" && pathname === "/__daemon/worktree-gc") {
        // Run the worktree GC sweep on demand (the periodic one runs every 30m).
        // Reaps only what's provably safe; lands a closed task's clean unmerged
        // commits first. Returns the summary.
        //
        // `?dryRun=1` is the same pass, read-only: for every folder and row of the
        // worktree root it says the class, the action the contract would take and
        // the weight on disk (`weigh=0` skips the weighing). Nothing is written.
        if (url.searchParams.get("dryRun") === "1") {
          const plan = await worktreeGc.planWorktreeGc({ weigh: url.searchParams.get("weigh") !== "0" });
          return new Response(JSON.stringify({ ok: plan !== null, dryRun: true, plan }), {
            status: plan ? 200 : 500, headers: { "content-type": "application/json" },
          });
        }
        const summary = await worktreeGc.runWorktreeGc();
        return new Response(JSON.stringify({ ok: true, summary }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    }
    return undefined;
  };
}
