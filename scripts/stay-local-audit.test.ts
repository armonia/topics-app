import { describe, expect, test } from "bun:test";
import { classifyOrigin, classifyStayLocal } from "./stay-local-audit";

describe("classifyStayLocal", () => {
  test("KEEP: text names a mac-only launch agent path", () => {
    expect(classifyStayLocal({ text: "Fix the plist under ~/Library/LaunchAgents", description: null })).toBe("KEEP");
  });

  test("KEEP: description names /Users/ even when text does not", () => {
    expect(classifyStayLocal({ text: "Investigate a crash", description: "Logs live at /Users/me/Library/Logs" })).toBe("KEEP");
  });

  test("KEEP: text names the tray icon with no literal path (b3e19133-style card)", () => {
    expect(classifyStayLocal({ text: "Fix the tray icon menu not refreshing", description: null })).toBe("KEEP");
  });

  test("KEEP: description names the local hub port", () => {
    expect(classifyStayLocal({ text: "Pairing fails", description: "The hub on :3360 refuses the handshake" })).toBe("KEEP");
  });

  test("DROP: neither text nor description names a mac-only path or feature", () => {
    expect(classifyStayLocal({ text: "Add a retry to the fetch helper", description: "Flaky under load" })).toBe("DROP");
  });
});

describe("classifyOrigin", () => {
  test("dispatcher: the mac-only-path empty-run comment", () => {
    const comments = [{ kind: "service", content: "La corsa su «Nodo» è finita senza nessun commit: la card usa file che stanno solo su questo Mac. La rimetto in coda qui, «solo Mac»." }];
    expect(classifyOrigin(comments)).toBe("dispatcher");
  });

  test("person: the generic reason comment tasks.ts writes for a human-set pin", () => {
    const comments = [{ kind: "service", content: "«Solo Mac», senza scadenza: pin manuale, nessuna ragione scritta." }];
    expect(classifyOrigin(comments)).toBe("person");
  });

  test("person: a typed reason still reads as a person's pin", () => {
    const comments = [{ kind: "service", content: "«Solo Mac», senza scadenza: usa il tray, non si sposta." }];
    expect(classifyOrigin(comments)).toBe("person");
  });

  test("unknown: no service comment names either reason", () => {
    expect(classifyOrigin([{ kind: "comment", content: "qualunque altra cosa" }])).toBe("unknown");
    expect(classifyOrigin([])).toBe("unknown");
  });
});
