import { describe, expect, it } from "bun:test";
import { createLandingQueue } from "./landing-queue";

/** Un job che si sblocca a comando: serve a tenere la fila ferma e guardarla. */
function gate() {
  let open!: () => void;
  let boom!: (e: Error) => void;
  const p = new Promise<void>((res, rej) => { open = res; boom = rej; });
  return { p, open, boom };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("landing-queue", () => {
  it("serializza: due land sulla stessa chiave non si sovrappongono mai", async () => {
    const q = createLandingQueue();
    let live = 0;
    let maxLive = 0;
    const run = async () => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      await tick();
      live -= 1;
    };
    const tickets = Array.from({ length: 20 }, (_, i) => q.enqueue("repo", `t${i}`, run));
    await Promise.all(tickets.map((t) => q.whenSettled(t.taskId)));
    expect(maxLive).toBe(1);
  });

  it("la raffica non perde nessuno: N accodati ⇒ N esiti", async () => {
    const q = createLandingQueue();
    const done: string[] = [];
    const tickets = Array.from({ length: 20 }, (_, i) =>
      q.enqueue("repo", `t${i}`, async () => { await tick(); done.push(`t${i}`); }),
    );
    const settled = await Promise.all(tickets.map((t) => q.whenSettled(t.taskId)));
    expect(done).toHaveLength(20);
    expect(settled.every((s) => s?.phase === "settled")).toBe(true);
    // …e l'ordine è quello di arrivo: la fila è una fila.
    expect(done).toEqual(tickets.map((t) => t.taskId));
  });

  it("dichiara la posizione in coda, e la posizione scende man mano", async () => {
    const q = createLandingQueue();
    const g1 = gate();
    const g2 = gate();
    const a = q.enqueue("repo", "a", () => g1.p);
    const b = q.enqueue("repo", "b", () => g2.p);
    expect(a.ahead).toBe(0);
    expect(b.ahead).toBe(1);
    expect(q.pending("repo")).toBe(2);
    g1.open();
    await q.whenSettled("a");
    expect(q.status("b")?.ahead).toBe(0);
    expect(q.pending("repo")).toBe(1);
    g2.open();
    await q.whenSettled("b");
    expect(q.pending("repo")).toBe(0);
  });

  it("chiavi diverse scorrono in parallelo: un progetto non blocca l'altro", async () => {
    const q = createLandingQueue();
    const g = gate();
    q.enqueue("repo-a", "a", () => g.p);
    const b = q.enqueue("repo-b", "b", async () => {});
    expect(b.ahead).toBe(0);
    await q.whenSettled("b");
    expect(q.status("b")?.phase).toBe("settled");
    g.open();
    await q.whenSettled("a");
  });

  it("un job che esplode chiude il SUO ticket col motivo e la fila prosegue", async () => {
    const q = createLandingQueue();
    q.enqueue("repo", "a", async () => { throw new Error("git è esploso"); });
    q.enqueue("repo", "b", async () => {});
    const a = await q.whenSettled("a");
    const b = await q.whenSettled("b");
    expect(a?.phase).toBe("failed");
    expect(a?.error).toBe("git è esploso");
    expect(b?.phase).toBe("settled");
  });

  it("due click sulla stessa card = UN land: il secondo riceve il ticket del primo", async () => {
    const q = createLandingQueue();
    const g = gate();
    let runs = 0;
    const run = async () => { runs += 1; await g.p; };
    const first = q.enqueue("repo", "a", run);
    const second = q.enqueue("repo", "a", run);
    expect(second.queuedAt).toBe(first.queuedAt);
    expect(q.pending("repo")).toBe(1);
    g.open();
    await q.whenSettled("a");
    expect(runs).toBe(1);
    // Chiuso il primo, ri-landare la stessa card è di nuovo possibile.
    q.enqueue("repo", "a", run);
    await q.whenSettled("a");
    expect(runs).toBe(2);
  });

  it("l'esito resta interrogabile dopo che il land è finito", async () => {
    const q = createLandingQueue();
    q.enqueue("repo", "a", async () => {});
    await q.whenSettled("a");
    expect(q.status("a")?.phase).toBe("settled");
    expect(q.status("a")?.settledAt).not.toBeNull();
    expect(q.status("mai-visto")).toBeNull();
    expect(q.whenSettled("mai-visto")).toBeNull();
  });

  it("la storia è limitata: i ticket vecchi cadono, quelli aperti no", async () => {
    const q = createLandingQueue({ historyCap: 2 });
    for (const id of ["a", "b", "c"]) {
      q.enqueue("repo", id, async () => {});
      await q.whenSettled(id);
    }
    expect(q.status("a")).toBeNull();
    expect(q.status("c")?.phase).toBe("settled");
  });

  it("propaga outcome e reason dal run al ticket: landed", async () => {
    const q = createLandingQueue();
    q.enqueue("repo", "a", async () => ({ outcome: "landed" as const, reason: null }));
    const t = await q.whenSettled("a");
    expect(t?.outcome).toBe("landed");
    expect(t?.reason).toBeNull();
  });

  it("propaga outcome e reason dal run al ticket: unlanded con ragione", async () => {
    const q = createLandingQueue();
    const r = "checkout sporco: 1 file non committati";
    q.enqueue("repo", "a", async () => ({ outcome: "unlanded" as const, reason: r }));
    const t = await q.whenSettled("a");
    expect(t?.outcome).toBe("unlanded");
    expect(t?.reason).toBe(r);
  });

  it("outcome resta null se run non restituisce niente (comportamento legacy)", async () => {
    const q = createLandingQueue();
    q.enqueue("repo", "a", async () => { /* void */ });
    const t = await q.whenSettled("a");
    expect(t?.phase).toBe("settled");
    expect(t?.outcome).toBeNull();
    expect(t?.reason).toBeNull();
  });

  it("fase failed: outcome resta null, error porta il messaggio", async () => {
    const q = createLandingQueue();
    q.enqueue("repo", "a", async () => { throw new Error("worktree sporco"); });
    const t = await q.whenSettled("a");
    expect(t?.phase).toBe("failed");
    expect(t?.outcome).toBeNull();
    expect(t?.error).toBe("worktree sporco");
  });
});
