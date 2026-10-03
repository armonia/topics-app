/**
 * AICTRL-05 + MSEL-06: lo switch non blocca piu' l'invio. Un bersaglio che il motore non raggiunge va diretto, e la fascia del selettore dice perche'. Resta un caso solo: la chat legacy legata al motore stesso (`provider: "topics"`) col motore giu', dove un «diretto» non esiste. allow-italian: l'invariante del file
 * Qui si esegue la composizione di ChatPane: lo snapshot letto dallo store SENZA abbonarsi, dato in pasto al cancello. Store vero e funzione vera. allow-italian: dice cosa viene eseguito davvero
 * ChatPane e ChatInput non montano in un test unitario (store, WS, hook di sessione): il filo resta una lettura di sorgente, secondaria. allow-italian: perche' il filo non e' eseguito
 * @covers AICTRL-05, MSEL-06
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getProvidersSnapshotState } from "../../lib/providersSnapshotStore";
import { topicsRoutingBlocked } from "../../lib/topicsRoutingGate";
import CHAT_IT from "../../lib/i18n-chat-it";
import CHAT_EN from "../../lib/i18n-chat-en";
import type { ProviderSelection } from "../../lib/effortTiers";
import type { ProvidersSnapshot } from "../../types";

const base = { isDefault: false, requirements: [] as ProvidersSnapshot["providers"][number]["requirements"], fetchedAt: "2026-09-22T00:00:00Z" };
const snapshot = (providers: ProvidersSnapshot["providers"]): ProvidersSnapshot =>
  ({ providers, defaultProvider: null, generatedAt: "2026-09-22T00:00:00Z" });

/** La decisione di ChatPane: stessi operandi, stessa lettura dello store. allow-italian: nomina la porta vera che questa riga riproduce */
const paneVerdict = (
  topicsRouting: boolean | null,
  override: ProviderSelection | null,
  defaultProviderLabel: string | undefined,
  live: ProvidersSnapshot | null,
): boolean => topicsRoutingBlocked(topicsRouting, override, defaultProviderLabel, live ?? getProvidersSnapshotState().snapshot);

describe("il gate del send legge lo store senza abbonarsi", () => {
  test("lo store risponde anche a freddo, e il gate regge uno snapshot mai arrivato", () => {
    const state = getProvidersSnapshotState();
    expect(state).toHaveProperty("snapshot");
    expect(paneVerdict(false, null, undefined, null)).toBe(false);
    expect(paneVerdict(null, null, undefined, null)).toBe(false);
  });

  test("ON con il motore nativo caduto: il send parte, diretto", () => {
    const live = snapshot([
      { ...base, name: "claude-code", status: "ready", models: ["claude-sonnet-5"] },
      { ...base, name: "topics", status: "error", models: [] },
    ]);
    expect(paneVerdict(true, { provider: "claude-code", model: "claude-sonnet-5" }, undefined, live)).toBe(false);
  });

  test("ON con override su un provider mai instradabile (Codex): il send parte, diretto", () => {
    const live = snapshot([
      { ...base, name: "codex", status: "ready", models: ["gpt-5"] },
      { ...base, name: "topics", status: "ready", models: ["claude-sonnet-5"] },
    ]);
    expect(paneVerdict(true, { provider: "codex", model: "gpt-5" }, undefined, live)).toBe(false);
    expect(paneVerdict(null, { provider: "codex", model: "gpt-5" }, undefined, live)).toBe(false);
  });

  test("la chat legacy legata al motore, col motore giu': l'unico send bloccato", () => {
    const live = snapshot([
      { ...base, name: "claude-code", status: "ready", models: ["claude-sonnet-5"] },
      { ...base, name: "topics", status: "error", models: [] },
    ]);
    expect(paneVerdict(null, null, "topics", live)).toBe(true);
  });

  test("il motivo e' una chiave sola, tradotta in entrambe le lingue, e la vecchia chiave del blocco e' uscita", () => {
    expect(CHAT_IT["chat.topicsEngine.down"]).toBeTruthy();
    expect(CHAT_EN["chat.topicsEngine.down"]).toBeTruthy();
    expect((CHAT_IT as Record<string, string>)["chat.topicsRouting.blocked"]).toBeUndefined();
    expect((CHAT_EN as Record<string, string>)["chat.topicsRouting.blocked"]).toBeUndefined();
  });
});

describe("il filo fra le due superfici e la decisione", () => {
  const chatPane = readFileSync(join(import.meta.dir, "ChatPane.tsx"), "utf8");
  const chatInput = readFileSync(join(import.meta.dir, "ChatInput.tsx"), "utf8");

  test("ChatPane controlla PRIMA di comporre il turno, e non si abbona allo snapshot", () => {
    const guard = chatPane.slice(chatPane.indexOf("const handleSendMessage"), chatPane.indexOf("Instant auto-name"));
    expect(guard).toContain("topicsRoutingBlocked(");
    expect(guard).toContain("getProvidersSnapshotState().snapshot");
    expect(guard).toContain("tr('chat.topicsEngine.down')");
    expect(chatPane).not.toContain("useProvidersSnapshot(");
  });

  test("ChatInput non disabilita piu' l'invio ne' mostra un banner rosso per lo switch", () => {
    expect(chatInput).not.toContain("topicsRoutingBlocked(");
    expect(chatInput).not.toContain("topicsRoutingIsBlocked");
    expect(chatInput).not.toContain("chat.topicsRouting.blocked");
  });
});
