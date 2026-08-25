/**
 * Which terminal phases are worth a banner, when a tab counts as actually
 * visible, and the key that stops the same event ringing twice.
 *
 * @covers MUTE-01
 */
import { describe, test, expect } from "bun:test";
import {
  decideTerminalBanner,
  isBannerPhase,
  isRealPhaseTransition,
  isTabActivelyVisible,
  isTerminalPaneSelected,
  statusBody,
  terminalDedupeKey,
  terminalPanelId,
  type TerminalNotifyInput,
} from "./terminalNotify";

// Minimal builder — a valid transition into awaiting-user, focus off, notify-
// when-focused off. Each test overrides just the fields it exercises.
function input(over: Partial<TerminalNotifyInput> = {}): TerminalNotifyInput {
  return {
    terminalId: "t1",
    phase: "awaiting-user",
    prevPhase: "running",
    rev: 1,
    name: "My Session",
    isFocusedAndVisible: false,
    notifyEvenWhenFocused: false,
    ...over,
  };
}

describe("isBannerPhase — actionable/terminal set only", () => {
  test("fires for the four actionable phases", () => {
    for (const p of ["awaiting-user", "awaiting-approval", "completed", "error"] as const) {
      expect(isBannerPhase(p)).toBe(true);
    }
  });
  test("does NOT fire for working / quiet phases (no every-turn spam)", () => {
    for (const p of ["starting", "running", "tool-running", "paused", "dormant"] as const) {
      expect(isBannerPhase(p)).toBe(false);
    }
  });
});

describe("isTabActivelyVisible — tab AND window focus", () => {
  test("active tab + focused window → actively visible (suppress)", () => {
    expect(isTabActivelyVisible(true, true)).toBe(true);
  });
  test("active tab + BACKGROUNDED window → NOT visible (banner must fire)", () => {
    // The regression this guards: a backgrounded Topics window whose last-active
    // tab is this session used to suppress the very banner the user needs.
    expect(isTabActivelyVisible(true, false)).toBe(false);
  });
  test("inactive tab → never visible, regardless of window focus", () => {
    expect(isTabActivelyVisible(false, true)).toBe(false);
    expect(isTabActivelyVisible(false, false)).toBe(false);
  });
  test("windowHasFocus defaults to true (DOM-less callers keep tab-only behaviour)", () => {
    expect(isTabActivelyVisible(true)).toBe(true);
    expect(isTabActivelyVisible(false)).toBe(false);
  });
});

describe("terminalPanelId / terminalDedupeKey", () => {
  test("panel id matches createPaneId('terminal', id)", () => {
    expect(terminalPanelId("abc")).toBe("terminal:abc");
  });
  test("dedupe key is <terminalId>:<phase>:<rev>", () => {
    expect(terminalDedupeKey("abc", "completed", 7)).toBe("abc:completed:7");
  });
});

describe("decideTerminalBanner — transition gating", () => {
  test("fires on a genuine transition into an actionable phase", () => {
    const d = decideTerminalBanner(input());
    expect(d).not.toBeNull();
    expect(d!.title).toBe("My Session");
    expect(d!.body).toBe("In attesa di te");
    expect(d!.level).toBe("ok");
    expect(d!.dedupeKey).toBe("t1:awaiting-user:1");
  });

  test("suppresses the first frame (no prevPhase) — reconnect baseline", () => {
    expect(decideTerminalBanner(input({ prevPhase: undefined }))).toBeNull();
  });

  test("suppresses a same-phase repeat frame", () => {
    expect(decideTerminalBanner(input({ prevPhase: "awaiting-user", phase: "awaiting-user" }))).toBeNull();
  });

  test("suppresses a transition into a non-actionable phase", () => {
    expect(decideTerminalBanner(input({ prevPhase: "awaiting-user", phase: "running" }))).toBeNull();
    expect(decideTerminalBanner(input({ prevPhase: "running", phase: "tool-running" }))).toBeNull();
  });
});

describe("decideTerminalBanner — focus suppression", () => {
  test("suppresses when the tab is focused+visible and override off", () => {
    expect(decideTerminalBanner(input({ isFocusedAndVisible: true }))).toBeNull();
  });
  test("fires when focused+visible but notifyEvenWhenFocused is on", () => {
    const d = decideTerminalBanner(input({ isFocusedAndVisible: true, notifyEvenWhenFocused: true }));
    expect(d).not.toBeNull();
  });
  test("fires when not focused regardless of the override", () => {
    expect(decideTerminalBanner(input({ isFocusedAndVisible: false }))).not.toBeNull();
  });
});

describe("decideTerminalBanner — title resolution", () => {
  test("prefers the session name", () => {
    expect(decideTerminalBanner(input({ name: "Auto Name" }))!.title).toBe("Auto Name");
  });
  test("falls back to the owning topic name when unnamed", () => {
    expect(decideTerminalBanner(input({ name: undefined, fallbackTitle: "My Topic" }))!.title).toBe("My Topic");
  });
  test("falls back to a generic label with neither", () => {
    expect(decideTerminalBanner(input({ name: undefined, fallbackTitle: undefined }))!.title).toBe("Claude Code");
  });
});

describe("decideTerminalBanner — body + level per phase", () => {
  test("awaiting-user → your-turn body, ok level", () => {
    const d = decideTerminalBanner(input({ phase: "awaiting-user" }))!;
    expect(d.body).toBe("In attesa di te");
    expect(d.level).toBe("ok");
  });

  test("completed → completed body, ok level", () => {
    const d = decideTerminalBanner(input({ prevPhase: "running", phase: "completed" }))!;
    expect(d.body).toBe("Lavoro completato");
    expect(d.level).toBe("ok");
  });

  test("error → error body, warn level", () => {
    const d = decideTerminalBanner(input({ prevPhase: "running", phase: "error" }))!;
    expect(d.body).toBe("Errore, intervieni");
    expect(d.level).toBe("warn");
  });

  test("awaiting-approval with prompt → prompt as body, warn level", () => {
    const d = decideTerminalBanner(
      input({
        prevPhase: "tool-running",
        phase: "awaiting-approval",
        pendingApproval: { kind: "bash", prompt: "Run `rm -rf build`?", requestedAt: 0 },
      }),
    )!;
    expect(d.body).toBe("Run `rm -rf build`?");
    expect(d.level).toBe("warn");
  });

  test("awaiting-approval WITHOUT a prompt → generic status body", () => {
    const d = decideTerminalBanner(input({ prevPhase: "tool-running", phase: "awaiting-approval" }))!;
    expect(d.body).toBe("Serve un'approvazione");
  });

  test("approval prompt whitespace is collapsed (multi-line plan reads on one line)", () => {
    const d = decideTerminalBanner(
      input({
        prevPhase: "tool-running",
        phase: "awaiting-approval",
        pendingApproval: { kind: "plan", prompt: "Step 1\n\n  Step 2\t\tStep 3", requestedAt: 0 },
      }),
    )!;
    expect(d.body).toBe("Step 1 Step 2 Step 3");
  });

  test("a very long approval prompt is truncated with an ellipsis", () => {
    const long = "x".repeat(500);
    const d = decideTerminalBanner(
      input({
        prevPhase: "tool-running",
        phase: "awaiting-approval",
        pendingApproval: { kind: "other", prompt: long, requestedAt: 0 },
      }),
    )!;
    expect(d.body.length).toBe(180);
    expect(d.body.endsWith("…")).toBe(true);
  });
});

describe("decideTerminalBanner — dedupe key carries rev", () => {
  test("same phase, different rev → distinct keys (a genuine re-entry can fire)", () => {
    const a = decideTerminalBanner(input({ prevPhase: "running", phase: "completed", rev: 3 }))!;
    const b = decideTerminalBanner(input({ prevPhase: "running", phase: "completed", rev: 4 }))!;
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });
});

describe("statusBody — una frase sola per due superfici", () => {
  // Il notificatore delle chat aveva la sua copia a mano di queste frasi, ed
  // erano gia' andate in deriva: «in attesa di te» contro «In attesa di te»,
  // «errore — interventi richiesti» contro «Errore — intervieni». Adesso legge
  // da qui: se qualcuno cambia una frase, cambia su entrambe le superfici.
  test("copre le quattro fasi che meritano un banner", () => {
    expect(statusBody("awaiting-user")).toBe("In attesa di te");
    expect(statusBody("awaiting-approval")).toBe("Serve un'approvazione");
    expect(statusBody("completed")).toBe("Lavoro completato");
    expect(statusBody("error")).toBe("Errore, intervieni");
  });

  test("una fase che non merita un banner non ha corpo", () => {
    expect(statusBody("running")).toBe("");
    expect(statusBody("tool-running")).toBe("");
  });
});

describe("il nome non si spacca sui due punti", () => {
  // Il guasto: titolo e corpo viaggiavano impacchettati in «Etichetta: stato» e
  // si riseparavano sul primo ": ". Una sessione chiamata «Fix: login rotto»
  // diventava titolo «Fix», corpo «login rotto: In attesa di te». Qui si pinna
  // il verso giusto — titolo e corpo nascono separati e restano interi.
  test("un nome con i due punti arriva intero nel titolo", () => {
    const d = decideTerminalBanner(input({ name: "Fix: login rotto" }))!;
    expect(d.title).toBe("Fix: login rotto");
    expect(d.body).toBe("In attesa di te");
  });
});

// Il caso che mancava del tutto: un terminale dentro una finestra progetto non
// compare MAI come pane di livello App — `focusedPanelId` resta `project:<path>`
// (lo dice state/projectFocus.ts). Il vecchio confronto secco era quindi sempre
// falso e il banner partiva mentre l'utente guardava quel terminale.
describe("isTerminalPaneSelected — anche i terminali dentro un progetto", () => {
  test("pane di primo livello: match esatto", () => {
    expect(isTerminalPaneSelected("t1", "terminal:t1")).toBe(true);
    expect(isTerminalPaneSelected("t1", "terminal:t2")).toBe(false);
  });

  test("niente focus → falso (non si zittisce niente)", () => {
    expect(isTerminalPaneSelected("t1", null)).toBe(false);
    expect(isTerminalPaneSelected("t1", undefined)).toBe(false);
    expect(isTerminalPaneSelected("t1", "")).toBe(false);
  });

  test("mai per substring: un id che CONTIENE il nostro non lo seleziona", () => {
    // Il bug che il percorso pty aveva ancora: `focused.includes(id)` faceva
    // zittire il banner di `t1` a un pane completamente diverso.
    expect(isTerminalPaneSelected("t1", "terminal:t1-backup")).toBe(false);
    expect(isTerminalPaneSelected("t1", "browser:ctx-terminal:t1")).toBe(false);
  });

  test("dentro un progetto: vero solo se la tab interna attiva è QUESTO terminale", () => {
    const focused = terminalPanelId("t1");
    expect(
      isTerminalPaneSelected("t1", "project:%2Fwork%2Fapp", { "/work/app": focused }),
    ).toBe(true);
    // Progetto a fuoco, ma dentro sei su un'altra tab → il banner deve partire.
    expect(
      isTerminalPaneSelected("t1", "project:%2Fwork%2Fapp", { "/work/app": "chat:c9" }),
    ).toBe(false);
    // Tab interna giusta, ma il progetto a fuoco è un ALTRO.
    expect(
      isTerminalPaneSelected("t1", "project:%2Fwork%2Fother", { "/work/app": focused }),
    ).toBe(false);
  });

  test("path con spazi e caratteri percent-encoded", () => {
    // Il pane id porta il path encodato, la mappa il path grezzo: se il
    // confronto non li riconcilia, ogni progetto con uno spazio nel path perde
    // la soppressione.
    expect(
      isTerminalPaneSelected("t1", "project:%2FUsers%2Fa%20b%2Fproj", {
        "/Users/a b/proj": terminalPanelId("t1"),
      }),
    ).toBe(true);
  });

  test("mappa assente o vuota → nessun crash, semplicemente falso", () => {
    expect(isTerminalPaneSelected("t1", "project:%2Fwork%2Fapp")).toBe(false);
    expect(isTerminalPaneSelected("t1", "project:%2Fwork%2Fapp", {})).toBe(false);
    expect(isTerminalPaneSelected("t1", "project:%2Fwork%2Fapp", { "/work/app": null })).toBe(false);
  });
});

describe('isRealPhaseTransition — il bootstrap non deve riannunciare il passato', () => {
  // `session:state` è per-transizione, ma alla connessione il server rimanda lo
  // SNAPSHOT di ogni sessione. Senza questa guardia, un client appena avviato
  // (nessuna fase precedente in memoria) vede ogni chat ferma in
  // `awaiting-user` come appena arrivata lì, e spara un banner per ognuna.
  // Misurato il 2026-08-02: sei riavvii dell'app, sei raffiche di notifiche per
  // lavoro finito giorni prima. Il ramo terminale era protetto, quello delle
  // chat no — pur avendo un commento che diceva il contrario.
  test('primo frame: nessuna transizione, solo baseline', () => {
    expect(isRealPhaseTransition(undefined, 'awaiting-user')).toBe(false);
    expect(isRealPhaseTransition(undefined, 'completed')).toBe(false);
    expect(isRealPhaseTransition(undefined, 'error')).toBe(false);
  });

  test('ripetizione della stessa fase: non è una transizione', () => {
    expect(isRealPhaseTransition('awaiting-user', 'awaiting-user')).toBe(false);
  });

  test('un cambio vero è una transizione', () => {
    expect(isRealPhaseTransition('running', 'awaiting-user')).toBe(true);
    expect(isRealPhaseTransition('tool-running', 'error')).toBe(true);
  });

  test('la sessione che nasce e finisce mentre siamo scollegati non banna: è il prezzo accettato', () => {
    // Documentato di proposito: il compromesso è non riannunciare tutto il
    // passato a ogni avvio. Se un giorno si volesse il contrario, questo test
    // è il posto dove la decisione va cambiata consapevolmente.
    expect(isRealPhaseTransition(undefined, 'awaiting-user')).toBe(false);
  });
});
