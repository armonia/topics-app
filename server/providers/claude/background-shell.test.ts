/**
 * @covers BGSHELL-01
 */
import { describe, expect, it } from "bun:test";
import {
  parseBackgroundShellId,
  parseShellOutput,
  parseShellStatus,
} from "./background-shell";

describe("parseBackgroundShellId", () => {
  it("legge la frase che il CLI usa davvero", () => {
    expect(parseBackgroundShellId("Command running in background with ID: bash_1")).toBe("bash_1");
  });

  it("regge la forma JSON, se un giorno arriva", () => {
    expect(parseBackgroundShellId('{"shell_id":"abc-123","status":"running"}')).toBe("abc-123");
    expect(parseBackgroundShellId('{"bash_id":"xyz"}')).toBe("xyz");
  });

  it("prende l'id nudo quando non c'è etichetta", () => {
    expect(parseBackgroundShellId("started bash_42 in the background")).toBe("bash_42");
  });

  it("non inventa un id dal nulla", () => {
    expect(parseBackgroundShellId("")).toBeNull();
    expect(parseBackgroundShellId(undefined)).toBeNull();
    expect(parseBackgroundShellId("done")).toBeNull();
  });
});

describe("parseShellStatus", () => {
  it("legge i tag di BashOutput", () => {
    expect(parseShellStatus("<status>running</status>")).toEqual({ status: "running" });
    expect(parseShellStatus("<status>completed</status>\n<exit_code>0</exit_code>")).toEqual({
      status: "completed",
      exitCode: 0,
    });
  });

  it("un completed con exit code non-zero È un fallimento", () => {
    // L'etichetta dice «completed» anche quando il comando è morto male:
    // quello che conta per chi guarda il pannello è il codice.
    expect(parseShellStatus("<status>completed</status>\n<exit_code>1</exit_code>")).toEqual({
      status: "failed",
      exitCode: 1,
    });
  });

  it("mappa gli alias", () => {
    expect(parseShellStatus("<status>killed</status>")?.status).toBe("killed");
    expect(parseShellStatus("<status>error</status>")?.status).toBe("failed");
    expect(parseShellStatus('{"status":"in_progress"}')?.status).toBe("running");
  });

  it("silenzio ≠ finita: null, così chi chiama tiene quello che sapeva", () => {
    expect(parseShellStatus("qualche riga di output")).toBeNull();
    expect(parseShellStatus("<status>boh</status>")).toBeNull();
    expect(parseShellStatus(undefined)).toBeNull();
  });
});

describe("parseShellOutput", () => {
  it("toglie i metadati e srotola i canali", () => {
    const raw = [
      "<status>running</status>",
      "<timestamp>2026-07-29T10:00:00Z</timestamp>",
      "<stdout>",
      "compilato in 2s",
      "</stdout>",
      "<stderr>warning: deprecato</stderr>",
    ].join("\n");
    const out = parseShellOutput(raw);
    expect(out).toContain("compilato in 2s");
    expect(out).toContain("warning: deprecato");
    expect(out).not.toContain("<status>");
    expect(out).not.toContain("running");
    expect(out).not.toContain("<stdout>");
  });

  it("un risultato senza tag passa intatto", () => {
    expect(parseShellOutput("riga uno\nriga due")).toBe("riga uno\nriga due");
    expect(parseShellOutput(undefined)).toBe("");
  });
});
