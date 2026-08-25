import { describe, expect, it } from "bun:test";
import {
  aliasPermission,
  allowPendingPermissions,
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

/**
 * Gli id qui sotto sono LORO, e non `T1`/`T2`: una decisione consegnata mentre
 * nessuna gamba è registrata resta in dispensa per il suo TTL, e
 * `cancelPermissionsForSession` non la ritira (guarda le richieste aperte, e
 * quella è già chiusa). Riusando gli id, il caso successivo che aspetta un
 * `cancelled` su `SK/T1` si vedrebbe servire l'`allow` di qui — un rosso che
 * parla di un'altra cosa.
 *
 * @covers PERM-01
 */
const F1 = "toolu_free_1";
const F2 = "toolu_free_2";
const F3 = "toolu_free_3";
const F4 = "toolu_free_4";

describe("allowPendingPermissions — quando la sessione diventa libera", () => {
  it("consente TUTTE quelle aperte su quella sessione, e dice quali", async () => {
    beginPermission(SK, F1);
    beginPermission(SK, F2);
    const l1 = waitForDecision(SK, F1, { timeoutMs: 5000 });
    const l2 = waitForDecision(SK, F2, { timeoutMs: 5000 });

    const served = allowPendingPermissions(SK);

    expect(served.map((s) => s.toolUseId).sort()).toEqual([F1, F2].sort());
    expect(await l1).toBe("allow");
    expect(await l2).toBe("allow");
    expect(sessionHasPendingPermission(SK)).toBe(false);
  });

  it("riporta anche l'id della RIGA a schermo, o il pannello resterebbe disegnato", async () => {
    beginPermission(SK, F3);
    // Il caso del ripiego per nome: la richiesta è indicizzata con l'id della
    // CLI, ma il pannello è stato dipinto su un'altra riga. Chi richiude deve
    // sapere QUALE riga spegnere — e gli alias muoiono con la richiesta, quindi
    // dopo la consegna non sarebbero più recuperabili.
    aliasPermission(SK, F3, "riga_diversa");
    const leg = waitForDecision(SK, F3, { timeoutMs: 5000 });

    const served = allowPendingPermissions(SK);

    expect(served).toHaveLength(1);
    expect(served[0].toolUseId).toBe(F3);
    expect(served[0].rowIds).toEqual(["riga_diversa"]);
    expect(await leg).toBe("allow");
  });

  it("non tocca le altre sessioni", async () => {
    beginPermission(SK, F4);
    beginPermission("topic:altra", F4);
    const mia = waitForDecision(SK, F4, { timeoutMs: 5000 });

    allowPendingPermissions(SK);

    expect(await mia).toBe("allow");
    expect(sessionHasPendingPermission(SK)).toBe(false);
    expect(sessionHasPendingPermission("topic:altra")).toBe(true);
    cleanup("topic:altra");
  });

  it("nessuna aperta → lista vuota, nessun effetto", () => {
    cleanup();
    expect(allowPendingPermissions(SK)).toEqual([]);
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
