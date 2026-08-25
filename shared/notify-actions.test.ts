/**
 * @covers NOTIF-ACT-01
 */
import { describe, expect, test } from "bun:test";
import {
  buildNotifyActionBundle,
  buildNotifyActions,
  decodeNotifyAction,
  isBoardActionPath,
  MAX_NOTIFY_ACTIONS,
  notifyActionRequest,
} from "./notify-actions";

const REF = { projectId: "topics-app-1a2b3c", taskId: "fb6e1fc5-0caa-4a2d-98a4-0c4be95c0542" };

describe("buildNotifyActions", () => {
  test("domanda con due opzioni → due tasti, etichettati col testo dell'opzione", () => {
    const actions = buildNotifyActions({ kind: "review-ready", question: { options: ["Landa su main", "Rivedi"] } });
    expect(actions.map((a) => a.title)).toEqual(["Landa su main", "Rivedi"]);
    expect(actions.map((a) => decodeNotifyAction(a.id))).toEqual([
      { kind: "answer", text: "Landa su main" },
      { kind: "answer", text: "Rivedi" },
    ]);
  });

  test("finché c'è una domanda aperta, «Approva» NON è tra i tasti", () => {
    const actions = buildNotifyActions({ kind: "review-ready", question: { options: ["Sì", "No"] } });
    expect(actions.some((a) => a.id === "approve")).toBe(false);
  });

  test("più opzioni del tetto → NESSUN tasto (una scelta troncata è peggio di nessuna)", () => {
    const many = Array.from({ length: MAX_NOTIFY_ACTIONS + 1 }, (_, i) => `opzione ${i}`);
    expect(buildNotifyActions({ kind: "review-ready", question: { options: many } })).toEqual([]);
  });

  test("review senza domanda → «Approva», lo stesso tasto della card", () => {
    expect(buildNotifyActions({ kind: "review-ready" })).toEqual([{ id: "approve", title: "Approva" }]);
    expect(buildNotifyActions({ kind: "review-ready", question: null })).toEqual([
      { id: "approve", title: "Approva" },
    ]);
  });

  test("una domanda SENZA opzioni non è una consegna da approvare: nessun tasto", () => {
    // Il caso che il tipo costringe a distinguere. `question` presente = il task
    // sta CHIEDENDO: approvare non è una risposta, chiude la conversazione al
    // posto suo. Senza opzioni non c'è nemmeno un tasto onesto da offrire →
    // resta il click che apre il task.
    expect(buildNotifyActions({ kind: "review-ready", question: { options: [] } })).toEqual([]);
    expect(buildNotifyActions({ kind: "review-ready", question: {} })).toEqual([]);
    // Opzioni tutte bianche = zero opzioni, non tasti muti.
    expect(buildNotifyActions({ kind: "review-ready", question: { options: ["  ", ""] } })).toEqual([]);
  });

  test("parcheggiato → rimetti in coda", () => {
    expect(buildNotifyActions({ kind: "parked" })).toEqual([{ id: "requeue", title: "Rimetti in coda" }]);
  });
});

describe("decodeNotifyAction", () => {
  test("l'id porta il testo per intero — nessun registro in memoria da perdere al riavvio", () => {
    const [action] = buildNotifyActions({ kind: "review-ready", question: { options: ["Landa su main, poi fermati"] } });
    // Round-trip attraverso una serializzazione (è quello che fa la push).
    const roundTripped = JSON.parse(JSON.stringify(action)) as typeof action;
    expect(decodeNotifyAction(roundTripped.id)).toEqual({ kind: "answer", text: "Landa su main, poi fermati" });
  });

  test("testi con caratteri che romperebbero un id ingenuo", () => {
    for (const text of ["a:b", "50% ok?", "virgola, e / slash", "accentata è", "emoji 🚀"]) {
      const [action] = buildNotifyActions({ kind: "review-ready", question: { options: [text] } });
      expect(decodeNotifyAction(action.id)).toEqual({ kind: "answer", text });
    }
  });

  test("id sconosciuto o rotto → null, mai un'azione a caso", () => {
    expect(decodeNotifyAction("")).toBeNull();
    expect(decodeNotifyAction(null)).toBeNull();
    expect(decodeNotifyAction("boom")).toBeNull();
    expect(decodeNotifyAction("answer:")).toBeNull();
    expect(decodeNotifyAction("answer:%E0%A4%A")).toBeNull(); // percent-encoding invalido
  });
});

describe("notifyActionRequest", () => {
  test("rispondere è un reject che PORTA il testo (la semantica della card)", () => {
    expect(notifyActionRequest({ kind: "answer", text: "Landa su main" }, REF)).toEqual({
      method: "POST",
      path: `/api/boards/${REF.projectId}/tasks/${REF.taskId}/review`,
      body: { decision: "reject", comment: "Landa su main" },
    });
  });

  test("approvare e rimettere in coda usano gli endpoint della board", () => {
    expect(notifyActionRequest({ kind: "approve" }, REF)?.body).toEqual({ decision: "approve" });
    const requeue = notifyActionRequest({ kind: "requeue" }, REF);
    expect(requeue).toEqual({
      method: "PATCH",
      path: `/api/boards/${REF.projectId}/tasks/${REF.taskId}`,
      body: { status: "todo" },
    });
  });

  test("senza progetto o senza task non c'è nessuna chiamata", () => {
    expect(notifyActionRequest({ kind: "approve" }, { projectId: "", taskId: "t" })).toBeNull();
    expect(notifyActionRequest({ kind: "approve" }, { projectId: "p", taskId: "" })).toBeNull();
  });

  test("ogni path composto passa il cancello di chi la richiesta la riceve", () => {
    const verbs = [{ kind: "answer", text: "x" }, { kind: "approve" }, { kind: "requeue" }] as const;
    for (const verb of verbs) expect(isBoardActionPath(notifyActionRequest(verb, REF)?.path)).toBe(true);
  });
});

describe("isBoardActionPath", () => {
  test("fuori dalla board non si esegue niente", () => {
    expect(isBoardActionPath("/api/topics/x")).toBe(false);
    expect(isBoardActionPath("https://altrove.example/api/boards/p/tasks/t")).toBe(false);
    expect(isBoardActionPath("/api/boards/p/tasks/t/../../../publish")).toBe(false);
    expect(isBoardActionPath(undefined)).toBe(false);
    expect(isBoardActionPath(42)).toBe(false);
  });
});

describe("buildNotifyActionBundle", () => {
  test("tasti e richieste già composte, in coppia, per chi non sa decodificare", () => {
    const bundle = buildNotifyActionBundle({ kind: "review-ready", question: { options: ["Landa su main"] } }, REF);
    expect(bundle.actions).toHaveLength(1);
    const id = bundle.actions[0].id;
    expect(bundle.requests[id]).toEqual({
      method: "POST",
      path: `/api/boards/${REF.projectId}/tasks/${REF.taskId}/review`,
      body: { decision: "reject", comment: "Landa su main" },
    });
    // Ogni tasto disegnato ha la sua richiesta: nessun bottone che non fa niente.
    for (const a of bundle.actions) expect(bundle.requests[a.id]).toBeTruthy();
  });

  test("senza riferimento al task il bundle è vuoto: nessun tasto che non fa niente", () => {
    const bundle = buildNotifyActionBundle({ kind: "parked" }, { projectId: "", taskId: "" });
    expect(bundle.actions).toEqual([]);
    expect(bundle.requests).toEqual({});
  });
});
