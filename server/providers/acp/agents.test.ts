/**
 * La tabella degli agenti e la sua variabile d'ambiente.
 *
 * L'invariante che conta: `ACP_AGENTS` malformato NON deve impedire al server
 * di partire. Una riga illeggibile si scarta e si va avanti — il costo di un
 * agente in meno è un provider assente, il costo di un'eccezione al boot è
 * l'app che non si apre.
 */
import { describe, expect, test } from "bun:test";
import { KNOWN_ACP_AGENTS, mergeAcpAgents, parseAcpAgentsEnv } from "./agents";

describe("KNOWN_ACP_AGENTS", () => {
  test("contiene solo agenti di cui conosciamo davvero la riga di comando", () => {
    expect(KNOWN_ACP_AGENTS.map((a) => a.name)).toEqual(["gemini", "jcode"]);
    expect(KNOWN_ACP_AGENTS[0]).toEqual({ name: "gemini", command: "gemini", args: ["--acp"] });
    expect(KNOWN_ACP_AGENTS[1]).toEqual({ name: "jcode", command: "jcode", args: ["acp"] });
  });
});

describe("parseAcpAgentsEnv", () => {
  test("assente o vuota → niente, senza scarti", () => {
    expect(parseAcpAgentsEnv(undefined)).toEqual({ agents: [], skipped: 0 });
    expect(parseAcpAgentsEnv("   ")).toEqual({ agents: [], skipped: 0 });
  });

  test("un array di voci valide si legge tutto", () => {
    const { agents, skipped } = parseAcpAgentsEnv(
      JSON.stringify([
        { name: "goose", command: "goose", args: ["acp"] },
        { name: "amp", command: "/opt/amp/bin/amp", args: ["--acp"], env: { AMP_TOKEN: "x" } },
      ]),
    );
    expect(skipped).toBe(0);
    expect(agents).toEqual([
      { name: "goose", command: "goose", args: ["acp"] },
      { name: "amp", command: "/opt/amp/bin/amp", args: ["--acp"], env: { AMP_TOKEN: "x" } },
    ]);
  });

  test("un oggetto singolo vale come lista da uno", () => {
    expect(parseAcpAgentsEnv(JSON.stringify({ command: "goose" })).agents).toEqual([
      { name: "goose", command: "goose", args: [] },
    ]);
  });

  test("senza name si usa il basename del comando", () => {
    expect(parseAcpAgentsEnv(JSON.stringify([{ command: "/Users/x/bin/goose" }])).agents[0]!.name).toBe("goose");
  });

  test("JSON rotto → nessun agente e uno scarto, MAI un'eccezione", () => {
    expect(() => parseAcpAgentsEnv("{non json")).not.toThrow();
    expect(parseAcpAgentsEnv("{non json")).toEqual({ agents: [], skipped: 1 });
  });

  test("voci senza command si scartano contandole", () => {
    const { agents, skipped } = parseAcpAgentsEnv(
      JSON.stringify([{ name: "senza-comando" }, { command: "  " }, null, "stringa", { command: "buono" }]),
    );
    expect(agents.map((a) => a.name)).toEqual(["buono"]);
    expect(skipped).toBe(4);
  });

  test("args ed env sporchi si ripuliscono invece di far cadere la voce", () => {
    const { agents } = parseAcpAgentsEnv(
      JSON.stringify([{ command: "x", args: ["--acp", 3, null, "--v"], env: { A: "1", B: 2 } }]),
    );
    expect(agents[0]!.args).toEqual(["--acp", "--v"]);
    expect(agents[0]!.env).toEqual({ A: "1" });
  });

  test("args non-array → lista vuota, non un crash", () => {
    expect(parseAcpAgentsEnv(JSON.stringify([{ command: "x", args: "--acp" }])).agents[0]!.args).toEqual([]);
  });
});

describe("mergeAcpAgents", () => {
  test("i dichiarati VINCONO sui noti a parità di nome (stanno correggendo la tabella)", () => {
    const merged = mergeAcpAgents(KNOWN_ACP_AGENTS, [
      { name: "gemini", command: "/usr/local/bin/gemini", args: ["--experimental-acp", "--yolo"] },
    ]);
    expect(merged).toHaveLength(KNOWN_ACP_AGENTS.length);
    expect(merged.find((a) => a.name === "gemini")!.command).toBe("/usr/local/bin/gemini");
  });

  test("i nomi nuovi si aggiungono in coda", () => {
    const merged = mergeAcpAgents(KNOWN_ACP_AGENTS, [{ name: "goose", command: "goose", args: [] }]);
    expect(merged.map((a) => a.name)).toEqual([...KNOWN_ACP_AGENTS.map((a) => a.name), "goose"]);
  });

  test("senza dichiarati resta la tabella nota, copiata (non l'originale readonly)", () => {
    const merged = mergeAcpAgents(KNOWN_ACP_AGENTS, []);
    expect(merged).toEqual([...KNOWN_ACP_AGENTS]);
    expect(merged).not.toBe(KNOWN_ACP_AGENTS as unknown as typeof merged);
  });
});
