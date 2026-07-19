// Review-ready previews: spin up a live preview server from a task's worktree
// when it reaches review, point the task's output_url at the LOCAL deep-link
// (never a prod URL for undeployed code), attach a screenshot as evidence, and
// tear the server down when the task lands or is closed.
//
// Design (v1, 2026-07-20 — Attilio):
//   • ONE preview server per task, on demand, from the task's own branch
//     worktree (its cwd). No multi-branch merge-preview (overkill for v1).
//   • Port from a small pool (default 3400–3450), one per live preview.
//   • The command comes from the host (env override or a package.json heuristic)
//     via the injected `resolveCommand` — this module owns the LIFECYCLE only
//     (port pick, spawn, health-wait, screenshot orchestration, teardown), so
//     it stays pure and unit-testable with injected spawn/probe/screenshot.
//   • MAI un URL di prod: if we can't boot a preview and the task already carries
//     a non-local output_url, we CLEAR it and leave a review-note — the defect
//     that started this work (every output_url pointed at prod without the code).
//   • The screenshot + status land as `review-note` comments, a channel that does
//     NOT wake the agent (unlike a human POST /comments, which reject+resumes).

import { join } from "path";
import net from "net";

/** The task's branch worktree — the cwd the preview server runs in. */
export interface PreviewWorktree {
  id: string;
  absPath: string;
  branchName: string | null;
  projectId: string;
  mode: string;
}

/** Minimal handle over a spawned child (injectable so tests never spawn). */
export interface PreviewProcess {
  readonly pid: number | null;
  /** True while the process is still running. */
  alive(): boolean;
  kill(): void;
}

export interface PreviewCommand {
  /** argv to spawn (e.g. ["bun", "run", "dev"]). */
  cmd: string[];
  /** Path appended to http://localhost:<port> for the deep-link (default "/"). */
  deepLinkPath: string;
  /** Extra env for the child (merged over PORT). */
  env?: Record<string, string>;
}

export interface PreviewManagerDeps {
  /** Resolve the task's branch worktree, or null (no worktree ⇒ no preview). */
  worktreeOf(taskId: string): PreviewWorktree | null;
  /**
   * Decide HOW to start the preview for this worktree: argv + deep-link path.
   * null ⇒ this project can't be previewed (no start script / no override) —
   * the manager then skips spin-up and only enforces the no-prod-url guard.
   */
  resolveCommand(taskId: string, wt: PreviewWorktree): PreviewCommand | null;
  /** Spawn the command detached in `cwd` with `env`. Injected for tests. */
  spawn(cmd: string[], opts: { cwd: string; env: Record<string, string> }): PreviewProcess;
  /** HTTP GET a url; resolve true if the server answered (any status). */
  probe(url: string): Promise<boolean>;
  /** Render a PNG of `url` at `width` px to `outPath`. Best-effort → boolean. */
  screenshot(url: string, outPath: string, opts: { width: number }): Promise<boolean>;
  /** The task's current output_url (to detect a prod URL we must not keep). */
  currentOutputUrl(taskId: string): string | null;
  setOutputUrl(taskId: string, url: string | null): void;
  setPreviewImage(taskId: string, absPath: string): void;
  /** Add a `review-note` comment (does NOT wake the agent). */
  addReviewNote(taskId: string, args: { content: string; media?: string[] }): void;
  /** Surface the preview in the Processes panel (Stop button + logs). Optional. */
  registerProcess?(entry: { taskId: string; port: number; pid: number | null; command: string; cwd: string }): void;
  unregisterProcess?(taskId: string): void;
  /** Dir for screenshots (allowlisted): ~/.openclaw/media/task-previews. */
  mediaDir: string;
  /** Ensure `mediaDir` exists (injected so tests skip real fs). */
  ensureMediaDir(): void;
  /** [low, high] inclusive pool. Default [3400, 3450]. */
  portRange?: [number, number];
  /** Ms to wait for the server to answer before giving up. Default 40000. */
  readyTimeoutMs?: number;
  /** Poll interval while waiting for readiness. Default 500. */
  readyPollMs?: number;
  /** True if `port` is free to bind. Default: a real TCP connect probe. */
  portFree?(port: number): Promise<boolean>;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  log?(msg: string, err?: unknown): void;
}

interface LivePreview {
  taskId: string;
  port: number;
  url: string;
  proc: PreviewProcess;
  worktreePath: string;
  startedAt: number;
}

export interface PreviewManager {
  /**
   * Full delivery flow: (re)use or boot the preview, set output_url to the local
   * deep-link, capture a screenshot → previewImage + review-note. Enforces the
   * no-prod-url guard when no preview is possible. Best-effort — never throws.
   */
  prepareForReview(taskId: string): Promise<void>;
  /** Boot (or reuse) a preview server for the task. null ⇒ couldn't. */
  ensurePreview(taskId: string): Promise<{ url: string; port: number } | null>;
  /** Kill + forget the task's preview server. Idempotent, never throws. */
  teardown(taskId: string): Promise<void>;
  /** Tear every preview down (shutdown). */
  teardownAll(): Promise<void>;
  /** Introspection (tests / status). */
  list(): { taskId: string; port: number; url: string }[];
}

const DEFAULT_RANGE: [number, number] = [3400, 3450];

/** A url whose host is loopback — the only kind safe to advertise for a preview. */
export function isLocalUrl(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** Default TCP-connect port probe: free ⇒ nothing is listening. */
function defaultPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    let settled = false;
    const done = (free: boolean) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* ignore */ } resolve(free); };
    sock.once("connect", () => done(false)); // something answered ⇒ taken
    sock.once("error", () => done(true));      // refused ⇒ free
    setTimeout(() => done(true), 300);
  });
}

export function createPreviewManager(deps: PreviewManagerDeps): PreviewManager {
  const live = new Map<string, LivePreview>();
  const range = deps.portRange ?? DEFAULT_RANGE;
  const readyTimeoutMs = deps.readyTimeoutMs ?? 40_000;
  const readyPollMs = deps.readyPollMs ?? 500;
  const now = deps.now ?? (() => Date.now());
  const portFree = deps.portFree ?? defaultPortFree;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});

  function usedPorts(): Set<number> {
    return new Set(Array.from(live.values()).map((p) => p.port));
  }

  async function pickPort(): Promise<number | null> {
    const used = usedPorts();
    for (let port = range[0]; port <= range[1]; port++) {
      if (used.has(port)) continue;
      if (await portFree(port)) return port;
    }
    return null;
  }

  async function waitReady(url: string): Promise<boolean> {
    const deadline = now() + readyTimeoutMs;
    while (now() < deadline) {
      if (await deps.probe(url)) return true;
      await sleep(readyPollMs);
    }
    return false;
  }

  async function ensurePreview(taskId: string): Promise<{ url: string; port: number } | null> {
    // Reuse a still-alive server (re-review after a reject+fix).
    const existing = live.get(taskId);
    if (existing) {
      if (existing.proc.alive()) return { url: existing.url, port: existing.port };
      live.delete(taskId); // dead — fall through and recreate
      try { deps.unregisterProcess?.(taskId); } catch { /* ignore */ }
    }

    const wt = deps.worktreeOf(taskId);
    if (!wt || wt.mode !== "branch") return null;

    const command = deps.resolveCommand(taskId, wt);
    if (!command || command.cmd.length === 0) return null;

    const port = await pickPort();
    if (port == null) { log(`[preview] no free port in ${range[0]}-${range[1]} for ${taskId}`); return null; }

    let proc: PreviewProcess;
    try {
      deps.ensureMediaDir();
      proc = deps.spawn(command.cmd, {
        cwd: wt.absPath,
        env: { PORT: String(port), HOST: "127.0.0.1", BROWSER: "none", ...(command.env ?? {}) },
      });
    } catch (err) {
      log(`[preview] spawn failed for ${taskId}`, err);
      return null;
    }

    const probeUrl = `http://127.0.0.1:${port}/`;
    const ready = await waitReady(probeUrl);
    if (!ready) {
      log(`[preview] server for ${taskId} never became ready on :${port} — killing`);
      try { proc.kill(); } catch { /* ignore */ }
      return null;
    }

    const deepLink = command.deepLinkPath && command.deepLinkPath.startsWith("/") ? command.deepLinkPath : "/";
    const url = `http://localhost:${port}${deepLink}`;
    live.set(taskId, { taskId, port, url, proc, worktreePath: wt.absPath, startedAt: now() });
    try {
      deps.registerProcess?.({ taskId, port, pid: proc.pid, command: command.cmd.join(" "), cwd: wt.absPath });
    } catch { /* panel registration is best-effort */ }
    return { url, port };
  }

  async function prepareForReview(taskId: string): Promise<void> {
    try {
      const cur = deps.currentOutputUrl(taskId);

      // If the agent already left a LIVE local server (its own run_script dev
      // server), reuse it instead of double-booting — and don't override its
      // deep-link. Only fall through to our own preview when there's nothing
      // reachable to point at.
      let url: string | null = null;
      if (cur && isLocalUrl(cur) && (await deps.probe(cur))) {
        url = cur;
      } else {
        const res = await ensurePreview(taskId);
        if (res) { url = res.url; deps.setOutputUrl(taskId, url); }
      }

      if (!url) {
        // No preview possible. Never leave a prod URL standing for undeployed code.
        if (cur && !isLocalUrl(cur)) {
          deps.setOutputUrl(taskId, null);
          deps.addReviewNote(taskId, {
            content: `⚠️ output_url rimosso: puntava a ${cur}, ma il codice di questo task non è deployato lì. Nessuna anteprima viva disponibile per questo worktree.`,
          });
        }
        return;
      }

      // Evidence: screenshot at 1440px → previewImage (card thumb) + review-note.
      const outPath = join(deps.mediaDir, `${taskId.slice(0, 8)}.png`);
      let shot = false;
      try {
        deps.ensureMediaDir();
        shot = await deps.screenshot(url, outPath, { width: 1440 });
      } catch (err) { log(`[preview] screenshot failed for ${taskId}`, err); }

      if (shot) {
        try { deps.setPreviewImage(taskId, outPath); } catch (err) { log(`[preview] setPreviewImage failed for ${taskId}`, err); }
        deps.addReviewNote(taskId, { content: `Anteprima viva pronta — ${url}`, media: [outPath] });
      } else {
        deps.addReviewNote(taskId, { content: `Anteprima viva su ${url} (screenshot non catturato).` });
      }
    } catch (err) {
      log(`[preview] prepareForReview failed for ${taskId}`, err);
    }
  }

  async function teardown(taskId: string): Promise<void> {
    const p = live.get(taskId);
    if (!p) return;
    live.delete(taskId);
    try { p.proc.kill(); } catch (err) { log(`[preview] kill failed for ${taskId}`, err); }
    try { deps.unregisterProcess?.(taskId); } catch { /* ignore */ }
  }

  async function teardownAll(): Promise<void> {
    for (const taskId of Array.from(live.keys())) await teardown(taskId);
  }

  function listPreviews() {
    return Array.from(live.values()).map((p) => ({ taskId: p.taskId, port: p.port, url: p.url }));
  }

  return { prepareForReview, ensurePreview, teardown, teardownAll, list: listPreviews };
}
