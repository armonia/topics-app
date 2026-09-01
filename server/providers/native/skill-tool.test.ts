/**
 * Il tool `skill` — e il motivo per cui non è un `read_file` travestito.
 *
 * Le skill stanno in casa dell'utente (`~/.agents/skills`), FUORI dalla
 * workspace: `read_file` le rifiuterebbe (ed è giusto che lo faccia). Questo
 * tool è l'unica porta, quindi il cancello sui nomi è la cosa da provare.
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
