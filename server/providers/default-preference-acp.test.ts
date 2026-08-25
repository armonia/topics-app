/**
 * Gli sconosciuti nella graduatoria del default.
 *
 * `PROVIDER_PREFERENCE_ORDER` è una lista di cinque nomi scritti a mano, e
 * nessun agente ACP ci sta dentro. Finché era anche l'elenco degli AMMESSI,
 * gemini non poteva diventare il default automatico nemmeno essendo l'unico
 * provider connesso: `find` non lo trovava, e il ramo di ripiego sceglieva il
 * primo connesso in ordine di REGISTRAZIONE, cioè per caso.
 *
 * La regola giusta è più semplice di com'era: la lista è l'ordine dei NOTI, chi
 * non c'è cade dopo i noti e prima dell'ultimo ripiego.
 * @covers CHAT-DEF-02
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  registerProvider,
  removeProvider,
  recomputeDefault,
  getDefaultProviderName,
  listProviders,
} from "./index";

/** Un agente ACP che si registra sempre: `command` con "/" salta `Bun.which`. */
const FAKE_ACP = {
  type: "acp" as const,
  name: "gemini",
  command: process.execPath,
  args: ["--version"],
};

function clearRegistry() {
  for (const { name } of listProviders()) removeProvider(name);
}

describe("recomputeDefault — chi non è in tabella", () => {
  beforeEach(() => {
    delete process.env.AI_PROVIDER;
    clearRegistry();
  });
  afterEach(() => {
    delete process.env.AI_PROVIDER;
    clearRegistry();
  });

  test("un agente ACP da solo DIVENTA il default", () => {
    registerProvider(FAKE_ACP);
    recomputeDefault();
    expect(getDefaultProviderName()).toBe("gemini");
  });

  test("ma resta dietro ai noti: claude-code connesso vince comunque", () => {
    registerProvider(FAKE_ACP);
    registerProvider({ type: "claude-code" });
    recomputeDefault();
    expect(getDefaultProviderName()).toBe("claude-code");
  });

  test("passa DAVANTI a un noto disconnesso, non dietro", () => {
    // Un `claude` senza chiave è registrato ma `connected === false`: il default
    // non deve fermarsi su di lui solo perché il suo nome è in tabella.
    registerProvider({ type: "claude", apiKey: "" });
    registerProvider(FAKE_ACP);
    recomputeDefault();
    expect(getDefaultProviderName()).toBe("gemini");
  });

  test("l'override esplicito vince anche su di lui", () => {
    process.env.AI_PROVIDER = "gemini";
    registerProvider({ type: "claude-code" });
    registerProvider(FAKE_ACP);
    recomputeDefault();
    expect(getDefaultProviderName()).toBe("gemini");
  });

  test("niente di connesso: si tiene il default corrente invece di azzerarlo", () => {
    registerProvider({ type: "claude", apiKey: "" });
    recomputeDefault();
    // Nessun provider connesso → resta l'unico registrato, così `getProvider()`
    // non esplode al boot.
    expect(getDefaultProviderName()).toBe("claude");
  });
});
