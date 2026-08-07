import { describe, expect, it } from "bun:test";
import {
  beginPermission,
  cancelPermission,
  cancelPermissionsForSession,
  deliverDecision,
  endPermission,
  hasPendingPermission,
  pendingPermissionAgeMs,
  pendingPermissionVerdict,
  PermissionWaitError,
  resolvePendingPermission,
  sessionHasPendingPermission,
  waitForDecision,
} from "./permission-bridge";

const SK = "topic:test-perm";
const T1 = "toolu_1";
const T2 = "toolu_2";

function cleanup(sessionKey = SK) {
  cancelPermissionsForSession(sessionKey, "cleanup");
}

describe("il giro normale", () => {
  it("il click sblocca la gamba che stava aspettando", async () => {
    cleanup();
    beginPermission(SK, T1);
    const leg = waitForDecision(SK, T1, { timeoutMs: 2000 });
    expect(deliverDecision(SK, T1, "allow")).toBe(true);
    expect(await leg).toBe("allow");
    expect(hasPendingPermission(SK, T1)).toBe(false);
  });

  it("una decisione arrivata PRIMA della gamba non si perde", async () => {
    cleanup();
    // Il bridge polla: fra una gamba e l'altra c'è una fessura in cui nessun
    // waiter è registrato. Un click che cade lì dentro deve sopravvivere.
    beginPermission(SK, T1);
    expect(deliverDecision(SK, T1, "allow_always")).toBe(true);
    expect(await waitForDecision(SK, T1, { timeoutMs: 2000 })).toBe("allow_always");
    cleanup();
  });

  it("una gamba scaduta è normale amministrazione, non una fine", async () => {
    cleanup();
    beginPermission(SK, T1);
    await expect(waitForDecision(SK, T1, { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
    // La RICHIESTA è ancora aperta: solo la gamba è scaduta.
    expect(hasPendingPermission(SK, T1)).toBe(true);
    cleanup();
  });
});

describe("due richieste insieme — il motivo per cui la chiave non è la sessione", () => {
  it("rispondere a una non risponde all'altra", async () => {
    cleanup();
    beginPermission(SK, T1);
    beginPermission(SK, T2);
    const leg1 = waitForDecision(SK, T1, { timeoutMs: 2000 });
    const leg2 = waitForDecision(SK, T2, { timeoutMs: 2000 });
    deliverDecision(SK, T2, "deny");
    expect(await leg2).toBe("deny");
    expect(hasPendingPermission(SK, T1)).toBe(true);
    deliverDecision(SK, T1, "allow");
    expect(await leg1).toBe("allow");
    cleanup();
  });

  it("con due aperte il ripiego per sessione NON indovina", async () => {
    cleanup();
    beginPermission(SK, T1);
    beginPermission(SK, T2);
    // Un id che non è nessuna delle due: preferisco non rispondere che
    // rispondere a quella sbagliata.
    expect(resolvePendingPermission(SK, "toolu_ignoto")).toBeNull();
    cleanup();
  });

  it("con UNA sola aperta il ripiego la trova", () => {
    cleanup();
    beginPermission(SK, T1);
    expect(resolvePendingPermission(SK, "toolu_ignoto")).toBe(T1);
    expect(resolvePendingPermission(SK, T1)).toBe(T1);
    cleanup();
  });
});

describe("consegnare nel vuoto", () => {
  it("senza una richiesta aperta non si consegna niente", () => {
    cleanup();
    // Se tornasse true, la rotta crederebbe di aver risposto a qualcosa e non
    // proverebbe le altre strade (la domanda del bridge, il piano, stdin).
    expect(deliverDecision(SK, "toolu_mai_visto", "allow")).toBe(false);
  });
});

describe("chiusure", () => {
  it("l'annullamento di sessione sblocca TUTTE le gambe con un errore leggibile", async () => {
    cleanup();
    beginPermission(SK, T1);
    beginPermission(SK, T2);
    const l1 = waitForDecision(SK, T1, { timeoutMs: 5000 });
    const l2 = waitForDecision(SK, T2, { timeoutMs: 5000 });
    cancelPermissionsForSession(SK, "turno interrotto");
    await expect(l1).rejects.toBeInstanceOf(PermissionWaitError);
    await expect(l2).rejects.toMatchObject({ code: "cancelled" });
    expect(sessionHasPendingPermission(SK)).toBe(false);
  });

  it("l'annullamento singolo tocca solo la sua", async () => {
    cleanup();
    beginPermission(SK, T1);
    beginPermission(SK, T2);
    const l1 = waitForDecision(SK, T1, { timeoutMs: 5000 });
    cancelPermission(SK, T1, "riga sparita");
    await expect(l1).rejects.toMatchObject({ code: "cancelled" });
    expect(hasPendingPermission(SK, T2)).toBe(true);
    cleanup();
  });

  it("non mescola le sessioni", () => {
    cleanup();
    cleanup("topic:altra");
    beginPermission(SK, T1);
    beginPermission("topic:altra", T1);
    cancelPermissionsForSession(SK, "solo la mia");
    expect(sessionHasPendingPermission(SK)).toBe(false);
    expect(sessionHasPendingPermission("topic:altra")).toBe(true);
    cleanup("topic:altra");
  });
});

describe("il TTL copre la RICHIESTA, non la gamba", () => {
  it("le gambe successive non rimettono a zero l'orologio", () => {
    cleanup();
    const t0 = 1_000_000;
    expect(beginPermission(SK, T1, 1000, t0)).toBe(true);
    expect(beginPermission(SK, T1, 1000, t0 + 500)).toBe(true);
    expect(beginPermission(SK, T1, 1000, t0 + 1500)).toBe(false);
    endPermission(SK, T1);
  });

  it("l'età è quella della più VECCHIA, o l'esenzione non finirebbe mai", () => {
    cleanup();
    const t0 = 1_000_000;
    beginPermission(SK, T1, 60_000, t0);
    beginPermission(SK, T2, 60_000, t0 + 5_000);
    expect(pendingPermissionAgeMs(SK, t0 + 10_000)).toBe(10_000);
    cleanup();
  });

  it("nessuna richiesta → età null", () => {
    cleanup();
    expect(pendingPermissionAgeMs(SK)).toBeNull();
  });
});

describe("pendingPermissionVerdict — la regola dello spazzino, pura", () => {
  it("niente aperto: regole normali", () => {
    expect(pendingPermissionVerdict({ ageMs: null })).toBe("none");
  });

  it("pannello a schermo e figlio vivo: il silenzio È la richiesta", () => {
    expect(pendingPermissionVerdict({ ageMs: 60_000, childAlive: true })).toBe("defer");
  });

  it("un provider che non sa dirlo vale VIVO — uccidere un turno sano è il guasto da evitare", () => {
    expect(pendingPermissionVerdict({ ageMs: 60_000 })).toBe("defer");
  });

  it("figlio morto sotto il pannello: si chiude, o `defer` sarebbe eterno", () => {
    expect(pendingPermissionVerdict({ ageMs: 60_000, childAlive: false })).toBe("close");
  });

  it("oltre il TTL si chiude comunque", () => {
    expect(pendingPermissionVerdict({ ageMs: 10_000, ttlMs: 5_000, childAlive: true })).toBe("close");
  });
});
