/**
 * THE CI PHASE: ACCEPTED WORK IS MEASURED TOGETHER WITH MAIN, IN BATCHES, THEN LANDS.
 *
 * Before 14/11/2026 a land merged the branch into main and nobody measured what
 * landed: the bar had read the delivered commit hours earlier, on an older main
 * (`tasks.ts`, "NOT a merge queue": 22 of 32 lands in a week were realigned
 * merges no check had seen). And every red after a person's yes went back
 * through that person.
 *
 * Here every land asked for (a person's Approva/Landa, the automatic land)
 * waits in a queue per project. The queue takes up to `maxBatch` cards, has
 * them merged onto `origin/main` in ONE integration commit, measures it once
 * with the board's CI rows, and:
 *   - green: lands the cards one after the other, through the usual land;
 *   - red with one card: that card goes back to its agent, its intent to land
 *     kept, so its next green delivery comes back here without a person;
 *   - red with more: the batch is halved and measured again until the card
 *     that breaks it is alone (the others land with their half);
 *   - a card that conflicts with main or with the batch goes back to its agent
 *     and the others go on without it;
 *   - unmeasured (GitHub silent, push refused): nothing moves, and the sweep
 *     asks again later.
 *
 * The queue lives in memory: the cards carry the intent (`tasks.land_intent`)
 * and the periodic sweep puts back whatever a restart dropped. Pure: git, the
 * CI and the land are the caller's.
 */

export type IntegrationVerdict = "pass" | "fail" | "unmeasured" | "empty";

export interface IntegrationMeasure {
  /** The cards whose branch is inside the measured commit, in the order they were merged. */
  measured: string[];
  /** Cards that could not be merged on top of main and the cards before them. */
  conflicts: Array<{ taskId: string; why: string }>;
  verdict: IntegrationVerdict;
  /** The integration commit, when one was built. */
  commit?: string | null;
  /** What failed or why nothing was measured: the CI log for a red. */
  why?: string;
}

export interface IntegrationQueueDeps {
  /** Build the integration commit for these cards (in order) and measure it with the CI. */
  measure(projectId: string, taskIds: string[]): Promise<IntegrationMeasure>;
  /** The usual land, awaited until it settles. */
  land(projectId: string, taskId: string): Promise<void>;
  /** Back to the agent with `why`, intent kept. */
  bounce(projectId: string, taskId: string, why: string): Promise<void>;
  /** The phase stops for this card and a person decides (a CI that never answers). */
  giveUp?(projectId: string, taskId: string, why: string): void;
  /** Is the card still waiting for this (in review, intent set, nothing changed)? Read before every step. */
  stillWanted(projectId: string, taskId: string): boolean;
  note?(taskId: string, text: string): void;
  log?(line: string): void;
  maxBatch?: number;
  /**
   * How long an idle queue waits for more cards before measuring: approvals come
   * in bursts (a person goes down the review column), and one CI run for the
   * burst is the whole point. Later arrivals batch by themselves behind the run.
   */
  collectMs?: number;
}

export interface IntegrationQueue {
  /** Put the card in its project's queue (no-op when it is already there) and start the queue if idle. */
  request(projectId: string, taskId: string): void;
  /** Cards queued or being measured on `projectId`. */
  pending(projectId: string): string[];
  /** Resolves when the project's queue is empty (tests, shutdown). */
  idle(projectId: string): Promise<void>;
}

export const DEFAULT_MAX_BATCH = 6;
export const DEFAULT_COLLECT_MS = 60_000;

export function createIntegrationQueue(deps: IntegrationQueueDeps): IntegrationQueue {
  const maxBatch = Math.max(1, deps.maxBatch ?? DEFAULT_MAX_BATCH);
  const collectMs = deps.collectMs ?? DEFAULT_COLLECT_MS;
  const log = deps.log ?? (() => undefined);
  const note = (taskId: string, text: string) => { try { deps.note?.(taskId, text); } catch { /* a note never stops the queue */ } };
  /** Per project: cards waiting, in arrival order. */
  const waiting = new Map<string, string[]>();
  /** Per project: cards inside the batch being measured. */
  const measuring = new Map<string, string[]>();
  /** The largest batch a card may be measured in: halved at every red it was part of. */
  const limit = new Map<string, number>();
  const running = new Map<string, Promise<void>>();
  /** Rounds in a row a card came back unmeasured: each one is a CI run paid for no verdict. */
  const silent = new Map<string, number>();
  const MAX_SILENT = 2;

  const lane = (projectId: string) => {
    let l = waiting.get(projectId);
    if (!l) { l = []; waiting.set(projectId, l); }
    return l;
  };

  /** The next batch: the first card's limit decides the size, so a bisected half is measured on its own. */
  function takeBatch(projectId: string): string[] {
    const l = lane(projectId);
    for (let i = l.length - 1; i >= 0; i--) if (!deps.stillWanted(projectId, l[i]!)) l.splice(i, 1);
    if (!l.length) return [];
    const size = Math.min(maxBatch, limit.get(l[0]!) ?? maxBatch);
    return l.splice(0, size);
  }

  async function round(projectId: string, batch: string[]): Promise<void> {
    measuring.set(projectId, batch);
    let out: IntegrationMeasure;
    try {
      out = await deps.measure(projectId, batch);
    } catch (err) {
      out = { measured: [], conflicts: [], verdict: "unmeasured", why: err instanceof Error ? err.message : String(err) };
    } finally {
      measuring.delete(projectId);
    }
    if (out.verdict !== "unmeasured") for (const id of batch) silent.delete(id);
    for (const c of out.conflicts) {
      if (!deps.stillWanted(projectId, c.taskId)) continue;
      log(`[integration] ${c.taskId.slice(0, 8)} in conflitto: torna all'agente`);
      limit.delete(c.taskId);
      await deps.bounce(projectId, c.taskId, c.why).catch((err) => log(`[integration] rimando fallito per ${c.taskId}: ${String(err)}`));
    }
    const sha = out.commit ? `\`${out.commit.slice(0, 8)}\`` : "il commit di integrazione";
    if (out.verdict === "pass") {
      for (const id of out.measured) {
        limit.delete(id);
        if (!deps.stillWanted(projectId, id)) continue;
        note(id, `CI verde su ${sha}: main più ${out.measured.length === 1 ? "questa card" : `queste ${out.measured.length} card`}, misurati insieme. Atterra adesso.`);
        await deps.land(projectId, id).catch((err) => log(`[integration] land fallito per ${id}: ${String(err)}`));
      }
      return;
    }
    if (out.verdict === "fail") {
      if (out.measured.length === 1) {
        const id = out.measured[0]!;
        limit.delete(id);
        if (!deps.stillWanted(projectId, id)) return;
        await deps.bounce(projectId, id, out.why ?? `la CI di ${sha} è rossa`).catch((err) => log(`[integration] rimando fallito per ${id}: ${String(err)}`));
        return;
      }
      // Halve: the two halves go back to the front, the first measured next.
      const half = Math.ceil(out.measured.length / 2);
      for (const id of out.measured) limit.set(id, Math.min(limit.get(id) ?? maxBatch, half));
      for (const id of out.measured) note(id, `CI rossa su ${sha} con ${out.measured.length} card insieme: la divido in due per trovare quella che la rompe.`);
      lane(projectId).unshift(...out.measured);
      return;
    }
    if (out.verdict === "unmeasured") {
      for (const id of out.measured.length ? out.measured : batch) {
        const n = (silent.get(id) ?? 0) + 1;
        silent.set(id, n);
        if (n >= MAX_SILENT && deps.giveUp) {
          silent.delete(id);
          deps.giveUp(projectId, id, `la CI non ha dato un esito ${n} volte di fila (${out.why ?? "nessun esito"})`);
          continue;
        }
        note(id, `CI non misurata${out.commit ? ` su ${sha}` : ""}: ${out.why ?? "nessun esito"}. Resta nella fase CI e riprovo alla prossima spazzata.`);
      }
      return;
    }
  }

  function run(projectId: string): Promise<void> {
    const cur = running.get(projectId);
    if (cur) return cur;
    const p = (async () => {
      await Bun.sleep(collectMs);
      for (;;) {
        const batch = takeBatch(projectId);
        if (!batch.length) break;
        await round(projectId, batch);
      }
    })().finally(() => { running.delete(projectId); });
    running.set(projectId, p);
    return p;
  }

  return {
    request(projectId, taskId) {
      if (lane(projectId).includes(taskId) || (measuring.get(projectId) ?? []).includes(taskId)) return;
      lane(projectId).push(taskId);
      void run(projectId);
    },
    pending(projectId) {
      return [...(measuring.get(projectId) ?? []), ...(waiting.get(projectId) ?? [])];
    },
    async idle(projectId) {
      while (running.get(projectId)) await running.get(projectId);
    },
  };
}
