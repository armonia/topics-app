import { test, expect } from "bun:test";
import { resumeIdForNewSession } from "./terminal";

/**
 * `POST /api/terminal/sessions` buttava il `claudeSessionId`.
 *
 * Il client lo mandava (closedTabRecord.ts) e `createSession` sapeva già cosa
 * farne (`--resume <id>` invece di `--session-id <nuovo>`), ma l'handler
 * passava `undefined` come decimo argomento. Effetto: riaprire una tab Claude
 * Code chiusa faceva ripartire una sessione VUOTA con lo stesso aspetto, e non
 * esisteva il verso "apri questa sessione come pane terminale".
 * @covers CMD-03
 */
const UUID = "7b1e2a1f-2cf2-453c-a77b-5dc95d66e890";

test("un uuid su un tipo claude viene ripreso", () => {
  expect(resumeIdForNewSession(UUID, "claude-code")).toBe(UUID);
  expect(resumeIdForNewSession(UUID, "claude-code-team")).toBe(UUID);
  expect(resumeIdForNewSession(UUID.toUpperCase(), "claude-code")).toBe(UUID.toUpperCase());
  expect(resumeIdForNewSession(`  ${UUID}  `, "claude-code")).toBe(UUID);
});

test("sugli altri tipi l'id non significa niente e viene ignorato", () => {
  for (const type of ["shell", "codex", "opencode"] as const) {
    expect(resumeIdForNewSession(UUID, type)).toBeUndefined();
  }
});

test("assente o vuoto → sessione nuova (undefined), non stringa vuota", () => {
  expect(resumeIdForNewSession(undefined, "claude-code")).toBeUndefined();
  expect(resumeIdForNewSession(null, "claude-code")).toBeUndefined();
  expect(resumeIdForNewSession("", "claude-code")).toBeUndefined();
  expect(resumeIdForNewSession("   ", "claude-code")).toBeUndefined();
});

test("quello che non è un uuid non entra in un argv", () => {
  // Il valore arriva da un body HTTP e finisce in `--resume <id>`.
  for (const bad of [
    "--dangerously-skip-permissions",
    "$(whoami)",
    "../../etc/passwd",
    "7b1e2a1f-2cf2-453c-a77b-5dc95d66e89", // una cifra in meno
    "7b1e2a1f2cf2453ca77b5dc95d66e890", // senza trattini
    42,
    { id: UUID },
  ]) {
    expect(resumeIdForNewSession(bad, "claude-code")).toBeUndefined();
  }
});
