/**
 * The `skill` tool — and why it is not a `read_file` in disguise.
 *
 * Skills live in the user's home (`~/.agents/skills`), OUTSIDE the
 * workspace: `read_file` would refuse them (and it is right to). This
 * tool is the only door, so the gate on the names is the thing worth testing.
 */
import { describe, it, expect } from "bun:test";
import { CODING_TOOLS, executeTool } from "./tools";

const ctx = { workspace: process.cwd() };

describe("tool skill", () => {
  it("è dichiarato con il nome esatto e un solo parametro obbligatorio", () => {
    const spec = CODING_TOOLS.find((t) => t.name === "skill");
    expect(spec).toBeDefined();
    expect(spec!.input_schema.required).toEqual(["name"]);
  });

  it("rifiuta un nome che tenta di uscire dalle cartelle note", async () => {
    const r = await executeTool("skill", { name: "../../../etc/passwd" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("sconosciuta");
  });

  it("un nome inesistente è un errore leggibile, non un'eccezione", async () => {
    const r = await executeTool("skill", { name: "skill-che-non-esiste-42" }, ctx);
    expect(r.isError).toBe(true);
  });

  it("nessun nome = errore, non il corpo di qualcos'altro", async () => {
    const r = await executeTool("skill", {}, ctx);
    expect(r.isError).toBe(true);
  });
});
