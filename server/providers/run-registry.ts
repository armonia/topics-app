/**
 * In-flight runs of an HTTP provider, keyed by runId and tagged with the
 * session that started them, so `abort(sessionKey)` without a runId stops ONLY
 * that session's runs instead of every session's.
 */
export class RunRegistry {
  private controllers = new Map<string, AbortController>();
  private sessionKeys = new Map<string, string>();

  /** Registers a new run and returns its id and controller. */
  start(sessionKey: string): { runId: string; controller: AbortController } {
    const runId = crypto.randomUUID();
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    this.sessionKeys.set(runId, sessionKey);
    return { runId, controller };
  }

  /** Forgets a finished run without aborting it. */
  finish(runId: string): void {
    this.controllers.delete(runId);
    this.sessionKeys.delete(runId);
  }

  /** Aborts one run, or every run of the session when no runId is given. */
  abort(sessionKey: string, runId?: string): void {
    if (runId) {
      this.controllers.get(runId)?.abort();
      this.finish(runId);
      return;
    }
    for (const [id, key] of [...this.sessionKeys]) {
      if (key !== sessionKey) continue;
      this.controllers.get(id)?.abort();
      this.finish(id);
    }
  }

  abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.sessionKeys.clear();
  }
}
