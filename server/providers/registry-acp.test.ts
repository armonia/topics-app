/**
 * Il registro dei provider indicizzato per NOME, non per `type`.
 *
 * Fino a ieri le due cose coincidevano e nessuno se n'era accorto. ACP le
 * separa: N agenti (`gemini`, `goose`, …) condividono `type: "acp"`, quindi un
 * registro che deduplica su `config.type` spegne il primo agente nel momento in
 * cui registri il secondo — silenziosamente, perché `stop()` non fa rumore.
 * Questi test tengono ferma quella separazione, e insieme l'etichetta con cui
 * un nome arbitrario arriva nel picker.
  * @covers ACP-05
 */
import { describe, expect, test, afterEach } from "bun:test";
import { join } from "path";
import { providerNameForConfig } from "./types";
import type { AcpProviderConfig } from "./types";
import { getProvider, listProviders, registerProvider, removeProvider } from "./index";
import { labelFor } from "./snapshot-manager";

const FAKE_AGENT = join(import.meta.dir, "acp", "fake-agent.fixture.ts");

/** Un config ACP che punta all'agente finto: `start()` non spawna nulla finché
 *  non arriva un prompt, quindi registrarlo costa quanto una riga in una Map. */
function acpConfig(name: string): AcpProviderConfig {
  return { type: "acp", name, command: process.execPath, args: [FAKE_AGENT] };
}

const registered: string[] = [];
function register(config: AcpProviderConfig) {
  registered.push(config.name);
  return registerProvider(config);
}

afterEach(() => {
  // Il registro è stato di modulo: lasciarlo sporco farebbe fallire un ALTRO
  // file di test, che è il modo peggiore di scoprire un bug.
  while (registered.length) removeProvider(registered.pop()!);
});

describe("providerNameForConfig", () => {
  test("per i provider storici il nome È il type (nessun comportamento cambia)", () => {
    expect(providerNameForConfig({ type: "claude-code" } as any)).toBe("claude-code");
    expect(providerNameForConfig({ type: "codex" } as any)).toBe("codex");
    expect(providerNameForConfig({ type: "openclaw" } as any)).toBe("openclaw");
    expect(providerNameForConfig({ type: "claude" } as any)).toBe("claude");
    expect(providerNameForConfig({ type: "openai" } as any)).toBe("openai");
  });

  test("per ACP il nome è quello dell'agente, non 'acp'", () => {
    expect(providerNameForConfig(acpConfig("gemini"))).toBe("gemini");
  });
});

describe("registro con più agenti ACP", () => {
  test("due agenti convivono: registrare il secondo non spegne il primo", () => {
    const gemini = register(acpConfig("gemini"));
    const goose = register(acpConfig("goose"));

    expect(getProvider("gemini")).toBe(gemini);
    expect(getProvider("goose")).toBe(goose);
    const names = listProviders().map((p) => p.name);
    expect(names).toContain("gemini");
    expect(names).toContain("goose");
  });

  test("ri-registrare lo STESSO nome sostituisce (è il caso che la dedup deve ancora coprire)", () => {
    const primo = register(acpConfig("gemini"));
    const secondo = registerProvider(acpConfig("gemini"));
    expect(secondo).not.toBe(primo);
    expect(getProvider("gemini")).toBe(secondo);
    expect(listProviders().filter((p) => p.name === "gemini")).toHaveLength(1);
  });

  test("il provider si registra sotto il nome dell'agente, non sotto 'acp'", () => {
    register(acpConfig("gemini"));
    expect(() => getProvider("acp")).toThrow();
  });
});

describe("labelFor", () => {
  test("i nomi noti restano quelli scritti a mano", () => {
    expect(labelFor("claude-code")).toBe("Claude Code");
    expect(labelFor("openai")).toBe("OpenAI");
  });

  test("un agente ACP si presenta capitalizzato, non tutto minuscolo", () => {
    expect(labelFor("gemini")).toBe("Gemini");
    expect(labelFor("goose")).toBe("Goose");
  });

  test("un nome che collide con Object.prototype dà una STRINGA, non una funzione", () => {
    // I nomi ACP arrivano da ACP_AGENTS, cioè da fuori: senza il guard
    // `hasOwnProperty` questo restituiva `Object.prototype.toString`.
    expect(labelFor("toString")).toBe("ToString");
    expect(labelFor("constructor")).toBe("Constructor");
  });
});
