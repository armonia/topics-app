import { describe, expect, it } from "bun:test";
import {
  aliasPermission,
  beginPermission,
  cancelPermission,
  cancelPermissionsForSession,
  deliverDecision,
  endPermission,
  hasPendingPermission,
  pendingPermissionAgeMs,
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

  it("un id sconosciuto non si risolve MAI, nemmeno con una sola aperta", () => {
    // Qui c'era un'euristica: «se ce n'è una sola, il click è suo». Reggeva
    // finché non ce n'era davvero una sola — poi mandava la decisione a un
    // permesso che nessuno aveva guardato. Un sì dato al posto di un altro è il
    // peggiore degli errori possibili qui dentro.
    cleanup();
    beginPermission(SK, T1);
    expect(resolvePendingPermission(SK, "toolu_ignoto")).toBeNull();
    expect(resolvePendingPermission(SK, T1)).toBe(T1);
    cleanup();
  });

  it("un alias SCRITTO invece si risolve — è la corrispondenza, non un indovinello", () => {
    cleanup();
    beginPermission(SK, T1);
    aliasPermission(SK, T1, "riga_diversa");
    expect(resolvePendingPermission(SK, "riga_diversa")).toBe(T1);
    cleanup();
  });

  it("e l'alias muore con la sua richiesta", () => {
    cleanup();
    beginPermission(SK, T1);
    aliasPermission(SK, T1, "riga_diversa");
    endPermission(SK, T1);
    expect(resolvePendingPermission(SK, "riga_diversa")).toBeNull();
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
