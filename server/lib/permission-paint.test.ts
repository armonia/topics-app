/**
 * @covers PERM-02
 */
import { describe, it, expect } from "bun:test";
import { decidePermissionPaint } from "./permission-paint";

const REQ = { toolName: "Bash", input: {}, requestedAt: 1 };

const call = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: "Bash", status: "running", ...extra });
const toolBlock = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: "tool",
  toolCall: { id, name: "Bash", status: "running", ...extra },
});

describe("decidePermissionPaint — su quale riga", () => {
  it("la riga c'è: si dipinge su quella, senza alias", () => {
    const row = { tool_calls: JSON.stringify([call("tu_1"), call("tu_2")]) };
    const d = decidePermissionPaint(row, "tu_2", "Bash");
    expect(d.targetId).toBe("tu_2");
    expect(d.aliasTo).toBeNull();
  });

  it("id sconosciuto: ripiega sull'ULTIMA riga in attesa con lo stesso nome, e la SCRIVE come alias", () => {
    const row = { tool_calls: JSON.stringify([call("old", { status: "running" }), call("new", { status: "pending" })]) };
    const d = decidePermissionPaint(row, "tu_mai_visto", "Bash");
    // Ultima, non prima: lo stesso strumento ricorre nello stesso turno e chi
    // aspetta è l'ultimo. Invertire il find qui deve far cadere questo caso.
    expect(d.targetId).toBe("new");
    expect(d.aliasTo).toBe("new");
  });

  it("una riga già CONCLUSA non è un bersaglio: nessun dirottamento", () => {
    const row = { tool_calls: JSON.stringify([call("done", { status: "success" })]) };
    const d = decidePermissionPaint(row, "tu_mai_visto", "Bash");
    expect(d.targetId).toBe("tu_mai_visto");
    expect(d.aliasTo).toBeNull();
  });

  it("un altro strumento in attesa non attira il pannello", () => {
    const row = { tool_calls: JSON.stringify([{ id: "r", name: "Read", status: "running" }]) };
    const d = decidePermissionPaint(row, "tu_mai_visto", "Bash");
    expect(d.targetId).toBe("tu_mai_visto");
    expect(d.aliasTo).toBeNull();
  });

  it("nessuna riga persistita: si tiene il toolUseId della CLI", () => {
    const d = decidePermissionPaint(undefined, "tu_1", "Bash");
    expect(d).toEqual({ targetId: "tu_1", aliasTo: null, alreadyPainted: false });
  });
});

describe("decidePermissionPaint — è già a schermo?", () => {
  it("pannello completo sulla riga: non si ridipinge", () => {
    const row = {
      tool_calls: JSON.stringify([call("tu_1", { status: "awaiting_permission", permissionRequest: REQ })]),
    };
    expect(decidePermissionPaint(row, "tu_1", "Bash").alreadyPainted).toBe(true);
  });

  it("status giusto ma richiesta MANCANTE: il pannello non c'è, si ridipinge", () => {
    const row = { tool_calls: JSON.stringify([call("tu_1", { status: "awaiting_permission" })]) };
    expect(decidePermissionPaint(row, "tu_1", "Bash").alreadyPainted).toBe(false);
  });

  it("richiesta presente ma status tornato running: si ridipinge", () => {
    const row = { tool_calls: JSON.stringify([call("tu_1", { status: "running", permissionRequest: REQ })]) };
    expect(decidePermissionPaint(row, "tu_1", "Bash").alreadyPainted).toBe(false);
  });

  it("I BLOCCHI BATTONO tool_calls: blocchi fermi + tool_calls in ordine ⇒ si ridipinge", () => {
    // Il caso del 7 agosto: `tool_calls` diceva «dipinto», i blocchi — che sono
    // quelli che il client disegna — no. Leggere tool_calls per primo qui
    // rimette la riga a girare per sempre senza pannello.
    const row = {
      tool_calls: JSON.stringify([call("tu_1", { status: "awaiting_permission", permissionRequest: REQ })]),
      blocks: JSON.stringify([toolBlock("tu_1", { status: "running" })]),
    };
    expect(decidePermissionPaint(row, "tu_1", "Bash").alreadyPainted).toBe(false);
  });

  it("i blocchi battono tool_calls anche al contrario: blocchi dipinti ⇒ non si ridipinge", () => {
    const row = {
      tool_calls: JSON.stringify([call("tu_1", { status: "running" })]),
      blocks: JSON.stringify([toolBlock("tu_1", { status: "awaiting_permission", permissionRequest: REQ })]),
    };
    expect(decidePermissionPaint(row, "tu_1", "Bash").alreadyPainted).toBe(true);
  });

  it("blocchi presenti ma SENZA questa riga: si ripiega su tool_calls", () => {
    const row = {
      tool_calls: JSON.stringify([call("tu_1", { status: "awaiting_permission", permissionRequest: REQ })]),
      blocks: JSON.stringify([toolBlock("altro", { status: "running" })]),
    };
    expect(decidePermissionPaint(row, "tu_1", "Bash").alreadyPainted).toBe(true);
  });

  it("un blocco non-tool non conta come pannello", () => {
    const row = {
      blocks: JSON.stringify([{ kind: "text", toolCall: { id: "tu_1", status: "awaiting_permission", permissionRequest: REQ } }]),
    };
    expect(decidePermissionPaint(row, "tu_1", "Bash").alreadyPainted).toBe(false);
  });

  it("«già dipinto» si giudica sul BERSAGLIO, non sul toolUseId della CLI", () => {
    const row = {
      tool_calls: JSON.stringify([call("riga", { status: "awaiting_permission", permissionRequest: REQ })]),
    };
    const d = decidePermissionPaint(row, "tu_mai_visto", "Bash");
    // Il ripiego per nome NON aggancia una riga già in attesa: quella riga ha
    // status awaiting_permission, non running/pending.
    expect(d.targetId).toBe("tu_mai_visto");
    expect(d.alreadyPainted).toBe(false);
  });
});

describe("decidePermissionPaint — nel dubbio si ridipinge", () => {
  it("tool_calls illeggibile: nessun dirottamento e si ridipinge", () => {
    const d = decidePermissionPaint({ tool_calls: "{non json" }, "tu_1", "Bash");
    expect(d).toEqual({ targetId: "tu_1", aliasTo: null, alreadyPainted: false });
  });

  it("blocchi illeggibili: si ripiega su tool_calls invece di esplodere", () => {
    const row = {
      tool_calls: JSON.stringify([call("tu_1", { status: "awaiting_permission", permissionRequest: REQ })]),
      blocks: "]]non json",
    };
    expect(decidePermissionPaint(row, "tu_1", "Bash").alreadyPainted).toBe(true);
  });

  it("tool_calls non è un array: si ridipinge", () => {
    const d = decidePermissionPaint({ tool_calls: "{}" }, "tu_1", "Bash");
    expect(d).toEqual({ targetId: "tu_1", aliasTo: null, alreadyPainted: false });
  });

  it("campi vuoti: si ridipinge", () => {
    expect(decidePermissionPaint({ tool_calls: null, blocks: null }, "tu_1", "Bash").alreadyPainted).toBe(false);
  });
});
