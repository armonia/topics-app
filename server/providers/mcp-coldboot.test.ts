/**
 * `isColdBootServer` — la regola che decide se un server MCP globale entra in una
 * sessione di chat.
 *
 * Il rischio da tenere basso qui è il FALSO POSITIVO: escludere un server che
 * serviva è peggio che tenerne uno lento, perché l'utente perde una capacità senza
 * capire perché. Quindi la regola è strettissima — `stdio` + un runner che scarica
 * (`npx`/`bunx`/`npm exec`) + il flag di auto-conferma — e questi test la tengono lì.
  * @covers CCLI-11
 */
import { describe, expect, test } from "bun:test";
import { isColdBootServer } from "./mcp-inheritance";

describe("isColdBootServer — esclude solo chi si riavvia davvero", () => {
  test("npx -y: scarica e fa cold-boot a ogni spawn", () => {
    expect(isColdBootServer({ type: "stdio", command: "npx", args: ["-y", "wigolo"] })).toBe(true);
    expect(isColdBootServer({ command: "npx", args: ["--yes", "qualcosa"] })).toBe(true);
    // Il runner può arrivare con un path assoluto.
    expect(isColdBootServer({ command: "/opt/homebrew/bin/npx", args: ["-y", "x"] })).toBe(true);
  });

  test("gli altri runner che scaricano contano allo stesso modo", () => {
    expect(isColdBootServer({ command: "bunx", args: ["-y", "x"] })).toBe(true);
    expect(isColdBootServer({ command: "npm", args: ["exec", "-y", "x"] })).toBe(true);
  });

  test("http non ha un processo da far ripartire", () => {
    expect(isColdBootServer({ type: "http", url: "https://mcp.example.com" })).toBe(false);
    // Anche se per qualche ragione portasse un command.
    expect(isColdBootServer({ type: "http", command: "npx", args: ["-y", "x"] })).toBe(false);
  });

  test("un binario locale parte e resta: non è cold-boot", () => {
    expect(isColdBootServer({ type: "stdio", command: "node", args: ["/Users/x/server.js"] })).toBe(false);
    expect(isColdBootServer({ command: "/usr/local/bin/my-mcp", args: [] })).toBe(false);
    expect(isColdBootServer({ command: "bun", args: ["run", "server.ts"] })).toBe(false);
  });

  test("npx SENZA auto-conferma non parte nemmeno: non è il caso che ci interessa", () => {
    // Si fermerebbe a chiedere conferma; è `-y` che rende il download silenzioso
    // e quindi ripetibile a ogni spawn.
    expect(isColdBootServer({ command: "npx", args: ["wigolo"] })).toBe(false);
  });

  test("input malformato non fa esplodere lo scoping", () => {
    expect(isColdBootServer(null)).toBe(false);
    expect(isColdBootServer(undefined)).toBe(false);
    expect(isColdBootServer("npx -y wigolo")).toBe(false);
    expect(isColdBootServer({})).toBe(false);
    expect(isColdBootServer({ command: "npx" })).toBe(false);
    expect(isColdBootServer({ command: "npx", args: "non-un-array" })).toBe(false);
  });

  test("i server globali veri di questa macchina: solo wigolo cade nella regola", () => {
    const globali = {
      exa: { type: "http" },
      context7: { type: "http" },
      gateway: { type: "http" },
      wigolo: { type: "stdio", command: "npx", args: ["-y", "wigolo"] },
      "topics-board": { type: "stdio", command: "node", args: ["/Users/x/topics-board/index.js"] },
    };
    const esclusi = Object.entries(globali).filter(([, d]) => isColdBootServer(d)).map(([n]) => n);
    expect(esclusi).toEqual(["wigolo"]);
  });
});
