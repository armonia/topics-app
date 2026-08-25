/**
 * task-tab-context.test — gli id delle tab di un task.
 *
 * Due proprietà, e sono tutta la sostanza del "manifesto": nomi diversi devono
 * dare tab diverse (altrimenti la seconda pagina consegnata sovrascrive la
 * prima, che è il bug di partenza), e nessuna delle forme può collidere con le
 * altre — compreso il gemello nel workspace, che deve restare riconducibile
 * alla sua tab o il login salvato non lo eredita.
 *
 * @covers RETIRE-07
 */
import { describe, it, expect } from "bun:test";
import {
  slugTabName,
  taskTabContextId,
  workspaceTwinContextId,
  taskTabContextIdOf,
  isTaskContextId,
  WORKSPACE_TWIN_SUFFIX,
} from "./task-tab-context";

const TASK = "bd4edfcb-a9ee-4169-a1fe-ffcbdfa89c92";
const TOPIC = "125aafd5-1111-2222-3333-444444444444";

describe("slugTabName", () => {
  it("normalizza in [a-z0-9-] senza trattini ai bordi", () => {
    expect(slugTabName("Report Lighthouse")).toBe("report-lighthouse");
    expect(slugTabName("  App!!  ")).toBe("app");
    expect(slugTabName("a//b__c")).toBe("a-b-c");
  });

  it("torna vuoto per ciò che non è un nome (il chiamante ricade sul default)", () => {
    expect(slugTabName("")).toBe("");
    expect(slugTabName("   ")).toBe("");
    expect(slugTabName("!!!")).toBe("");
    expect(slugTabName(undefined)).toBe("");
    expect(slugTabName(42)).toBe("");
  });

  it("tronca a 32 e non lascia mai un trattino finale", () => {
    const s = slugTabName("x".repeat(31) + " coda");
    expect(s.length).toBeLessThanOrEqual(32);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("taskTabContextId", () => {
  it("senza nome: UNA tab per (task, topic) — è la vecchia tab che ri-naviga", () => {
    const a = taskTabContextId(TASK, TOPIC);
    expect(a).toBe(`task-${TASK.slice(0, 8)}-a${TOPIC.slice(0, 8)}`);
    expect(taskTabContextId(TASK, TOPIC, "   ")).toBe(a);
  });

  it("nomi diversi ⇒ tab diverse; stesso nome ⇒ stessa tab", () => {
    const app = taskTabContextId(TASK, TOPIC, "App");
    const report = taskTabContextId(TASK, TOPIC, "Report");
    expect(app).not.toBe(report);
    expect(taskTabContextId(TASK, TOPIC, "app")).toBe(app);
  });

  it("una tab con nome non collide né col default né con una tab del client", () => {
    const named = taskTabContextId(TASK, TOPIC, "App");
    expect(named).not.toBe(taskTabContextId(TASK, TOPIC));
    expect(named).not.toBe(`task-${TASK.slice(0, 8)}-0`); // conio del client: <seq> numerico
  });

  it("un secondo agente sullo stesso task ha la SUA tab senza nome", () => {
    const other = "999aaaaa-0000-0000-0000-000000000000";
    expect(taskTabContextId(TASK, TOPIC)).not.toBe(taskTabContextId(TASK, other));
  });
});

describe("gemello nel workspace", () => {
  it("va e torna", () => {
    const tab = taskTabContextId(TASK, TOPIC, "Report");
    const twin = workspaceTwinContextId(tab);
    expect(twin).toBe(`${tab}${WORKSPACE_TWIN_SUFFIX}`);
    expect(taskTabContextIdOf(twin)).toBe(tab);
    expect(taskTabContextIdOf(tab)).toBe(tab);
  });

  it("non si somma a se stesso", () => {
    const twin = workspaceTwinContextId(taskTabContextId(TASK, TOPIC));
    expect(workspaceTwinContextId(twin)).toBe(twin);
  });

  it("nessuno slug può fabbricare il gemello di un'altra tab", () => {
    // «report ws» finirebbe su `report-ws` con un suffisso `-ws`: è per questo
    // che il suffisso è `_ws`, che lo slug non può produrre.
    const sneaky = taskTabContextId(TASK, TOPIC, "report ws");
    const twinOfReport = workspaceTwinContextId(taskTabContextId(TASK, TOPIC, "report"));
    expect(sneaky).not.toBe(twinOfReport);
    expect(taskTabContextIdOf(sneaky)).toBe(sneaky);
  });

  it("il gemello resta riconoscibile come roba di un task", () => {
    expect(isTaskContextId(workspaceTwinContextId(taskTabContextId(TASK, TOPIC)))).toBe(true);
    expect(isTaskContextId("term-abc")).toBe(false);
    expect(isTaskContextId("")).toBe(false);
  });
});
