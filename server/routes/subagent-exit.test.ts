/**
 * @covers SUBAGENT-04, WORKTREE-14
 */
import { describe, it, expect } from "bun:test";
import { formatSubAgentExitBody, formatSubAgentExitMessage } from "./subagent-exit";
import type { SubAgentOutcome } from "../lib/claude-subagent-transcript";

const completed = (text: string): SubAgentOutcome => ({ status: "completed", partial: false, text });

describe("formatSubAgentExitBody", () => {
  it("prefers the child's final assistant text, trimmed", () => {
    expect(formatSubAgentExitBody({ outcome: completed("  fatto: 12 test verdi  ") }))
      .toBe("fatto: 12 test verdi");
  });

  it("reports a non-zero exit code when there is no output", () => {
    const outcome: SubAgentOutcome = { status: "failed", partial: false, text: "", reason: { code: "exit-code", exitCode: 137 } };
    expect(formatSubAgentExitBody({ outcome })).toBe("_(non ha finito il compito: uscito con codice 137)_");
  });

  it("treats whitespace-only output as no output", () => {
    const outcome: SubAgentOutcome = { status: "failed", partial: false, text: "   \n  ", reason: { code: "exit-code", exitCode: 1 } };
    expect(formatSubAgentExitBody({ outcome })).toBe("_(non ha finito il compito: uscito con codice 1)_");
  });

  it("uses the neutral note only for a completed turn that wrote no text", () => {
    expect(formatSubAgentExitBody({ outcome: completed("") })).toBe("_(terminato senza output)_");
  });

  it("names a prompt that never arrived instead of calling it a silent finish", () => {
    const body = formatSubAgentExitBody({ outcome: { status: "undelivered", partial: false, text: "", reason: { code: "no-prompt" } } });
    expect(body).toBe("_(il compito non gli è mai arrivato: il suo transcript non contiene il prompt)_");
    expect(body).not.toContain("senza output");
  });

  it("names an API failure with its line", () => {
    const outcome: SubAgentOutcome = {
      status: "failed", partial: false, text: "",
      reason: { code: "api-error", detail: "You've hit your monthly spend limit" },
    };
    expect(formatSubAgentExitBody({ outcome }))
      .toBe("_(non ha finito il compito: errore dell'API: You've hit your monthly spend limit)_");
  });

  it("quotes a partial text as the last line seen, never as the outcome", () => {
    const outcome: SubAgentOutcome = {
      status: "stopped", partial: true, text: "Sto mappando dove il tool_result finisce",
      reason: { code: "stopped-by-parent" },
    };
    expect(formatSubAgentExitBody({ outcome })).toBe(
      "_(fermato prima di finire il turno: fermato con stop_agent)_\n\n" +
        "Ultima riga vista, non un esito:\n\n> Sto mappando dove il tool_result finisce",
    );
  });

  it("speaks English when the chat's output language is English", () => {
    const outcome: SubAgentOutcome = { status: "lost", partial: false, text: "", reason: { code: "terminal-lost" } };
    expect(formatSubAgentExitBody({ outcome }, "en"))
      .toBe("_(lost before its turn ended: its terminal did not survive the restart)_");
  });
});

describe("formatSubAgentExitMessage", () => {
  it("names the sub-agent in a bold header above the body, with no emoji", () => {
    const msg = formatSubAgentExitMessage({ name: "i18n-unit-fase2", outcome: completed("consegnato") });
    expect(msg).toBe('**Sotto-agente "i18n-unit-fase2", esito:**\n\nconsegnato');
    expect(msg).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("embeds the status note when there is no result", () => {
    const outcome: SubAgentOutcome = { status: "failed", partial: false, text: "", reason: { code: "exit-code", exitCode: 2 } };
    const msg = formatSubAgentExitMessage({ name: "builder", outcome });
    expect(msg).toBe('**Sotto-agente "builder", esito:**\n\n_(non ha finito il compito: uscito con codice 2)_');
  });
});

describe("formatSubAgentExitMessage - the branch of an isolated child", () => {
  it("names the branch and how to read its commits", () => {
    const msg = formatSubAgentExitMessage({
      name: "builder", outcome: completed("consegnato"), branch: "topics/kind-tower",
    });
    expect(msg).toContain("Ramo: `topics/kind-tower`");
    expect(msg).toContain("git log main..topics/kind-tower");
  });

  it("leaves the message byte-identical when the child had no worktree", () => {
    // The line is added, it does not rewrite: a child that inherited the
    // parent's directory must produce exactly the report it produced before.
    const plain = formatSubAgentExitMessage({ name: "builder", outcome: completed("consegnato") });
    expect(plain).toBe(formatSubAgentExitMessage({ name: "builder", outcome: completed("consegnato"), branch: null }));
    expect(plain).toBe('**Sotto-agente "builder", esito:**\n\nconsegnato');
  });
});
