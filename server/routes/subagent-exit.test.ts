/**
 * @covers SUBAGENT-04, WORKTREE-14
 */
import { describe, it, expect } from "bun:test";
import { formatSubAgentExitBody, formatSubAgentExitMessage } from "./subagent-exit";

describe("formatSubAgentExitBody", () => {
  it("prefers the child's final assistant text, trimmed", () => {
    expect(formatSubAgentExitBody({ result: "  fatto: 12 test verdi  ", exitCode: 0 }))
      .toBe("fatto: 12 test verdi");
  });

  it("reports a non-zero exit code when there is no output", () => {
    expect(formatSubAgentExitBody({ result: "", exitCode: 137 }))
      .toBe("_(terminato con codice 137, nessun output recuperato)_");
  });

  it("treats whitespace-only output as no output", () => {
    expect(formatSubAgentExitBody({ result: "   \n  ", exitCode: 1 }))
      .toBe("_(terminato con codice 1, nessun output recuperato)_");
  });

  it("uses the neutral note for a clean but silent finish", () => {
    expect(formatSubAgentExitBody({ result: "", exitCode: 0 }))
      .toBe("_(terminato senza output)_");
  });

  it("uses the neutral note when exitCode is unknown (null)", () => {
    expect(formatSubAgentExitBody({ result: "", exitCode: null }))
      .toBe("_(terminato senza output)_");
  });

  it("real result wins even on a non-zero exit code", () => {
    expect(formatSubAgentExitBody({ result: "riepilogo del lavoro", exitCode: 1 }))
      .toBe("riepilogo del lavoro");
  });
});

describe("formatSubAgentExitMessage", () => {
  it("names the sub-agent in a bold header above the body", () => {
    const msg = formatSubAgentExitMessage({ name: "i18n-unit-fase2", result: "consegnato", exitCode: 0 });
    expect(msg).toBe('🤖 **Sotto-agente "i18n-unit-fase2", esito:**\n\nconsegnato');
  });

  it("embeds the status note when there is no result", () => {
    const msg = formatSubAgentExitMessage({ name: "builder", result: "", exitCode: 2 });
    expect(msg).toBe('🤖 **Sotto-agente "builder", esito:**\n\n_(terminato con codice 2, nessun output recuperato)_');
  });
});

describe("formatSubAgentExitMessage - the branch of an isolated child", () => {
  it("names the branch and how to read its commits", () => {
    const msg = formatSubAgentExitMessage({
      name: "builder", result: "consegnato", exitCode: 0, branch: "topics/kind-tower",
    });
    expect(msg).toContain("Ramo: `topics/kind-tower`");
    expect(msg).toContain("git log main..topics/kind-tower");
  });

  it("leaves the message byte-identical when the child had no worktree", () => {
    // The line is added, it does not rewrite: a child that inherited the
    // parent's directory must produce exactly the report it produced before.
    const plain = formatSubAgentExitMessage({ name: "builder", result: "consegnato", exitCode: 0 });
    expect(plain).toBe(formatSubAgentExitMessage({ name: "builder", result: "consegnato", exitCode: 0, branch: null }));
    expect(plain).toBe('🤖 **Sotto-agente "builder", esito:**\n\nconsegnato');
  });
});
