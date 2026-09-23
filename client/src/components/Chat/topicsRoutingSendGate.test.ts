/**
 * AICTRL-05: il blocco del send e il banner che ne dice il motivo leggono UNA decisione sola, con gli stessi operandi e una chiave i18n sola. allow-italian: l'invariante fra le due superfici
 * Qui si esegue la composizione di ChatPane: lo snapshot letto dallo store SENZA abbonarsi, dato in pasto al cancello. Store vero e funzione vera, quindi un cambio di forma dello store diventa rosso. allow-italian: dice cosa viene eseguito davvero
 * ChatPane e ChatInput non montano in un test unitario (store, WS, hook di sessione): il filo resta una lettura di sorgente, secondaria. allow-italian: perche' il filo non e' eseguito
 * @covers AICTRL-05
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
    // Switch spento: nessuno snapshot puo' bloccare niente. allow-italian: la regola che le due righe sotto provano
    expect(paneVerdict(false, null, undefined, null)).toBe(false);
    expect(paneVerdict(null, null, undefined, null)).toBe(false);
  });

  test("ON con il motore nativo caduto: il send e' bloccato", () => {
    const live = snapshot([
      { ...base, name: "claude-code", status: "ready", models: ["claude-sonnet-5"] },
      { ...base, name: "topics", status: "error", models: [] },
    ]);
    expect(paneVerdict(true, { provider: "claude-code", model: "claude-sonnet-5" }, undefined, live)).toBe(true);
  });

  test("ON con override per messaggio su un provider mai instradabile: bloccato lo stesso", () => {
    // L'override del turno e' la porta laterale: guardando solo il provider pinnato, basterebbe un override per eseguire fuori dal motore. allow-italian: nomina il buco che questo test chiude
    const live = snapshot([
      { ...base, name: "codex", status: "ready", models: ["gpt-5"] },
      { ...base, name: "topics", status: "ready", models: ["claude-sonnet-5"] },
    ]);
    expect(paneVerdict(true, { provider: "codex", model: "gpt-5" }, undefined, live)).toBe(true);
    expect(paneVerdict(false, { provider: "codex", model: "gpt-5" }, undefined, live)).toBe(false);
  });

  test("ON e tutto raggiungibile: si scrive normalmente", () => {
    const live = snapshot([
      { ...base, name: "claude-code", status: "ready", models: ["claude-sonnet-5"] },
      { ...base, name: "topics", status: "ready", models: ["claude-sonnet-5"] },
    ]);
    expect(paneVerdict(true, { provider: "claude-code", model: "claude-sonnet-5" }, undefined, live)).toBe(false);
  });

  test("il motivo e' una chiave sola, tradotta in entrambe le lingue", () => {
    expect(CHAT_IT["chat.topicsRouting.blocked"]).toBeTruthy();
    expect(CHAT_EN["chat.topicsRouting.blocked"]).toBeTruthy();
  });
});

describe("il filo fra le due superfici e la decisione", () => {
  const chatPane = readFileSync(join(import.meta.dir, "ChatPane.tsx"), "utf8");
  const chatInput = readFileSync(join(import.meta.dir, "ChatInput.tsx"), "utf8");

  test("ChatPane blocca PRIMA di comporre il turno, e non si abbona allo snapshot", () => {
    const guard = chatPane.slice(chatPane.indexOf("const handleSendMessage"), chatPane.indexOf("Instant auto-name"));
    expect(guard).toContain("topicsRoutingBlocked(");
    expect(guard).toContain("getProvidersSnapshotState().snapshot");
    expect(guard).toContain("tr('chat.topicsRouting.blocked')");
    expect(chatPane).not.toContain("useProvidersSnapshot(");
  });

  test("ChatInput disabilita l'invio e mostra il motivo dallo snapshot gia' abbonato", () => {
    expect(chatInput).toContain("topicsRoutingBlocked(topicsRouting");
    expect(chatInput).toContain("topicsRoutingIsBlocked &&");
    const disabled = chatInput.slice(chatInput.indexOf("const isDisabled ="));
    expect(disabled.slice(0, 120)).toContain("topicsRoutingIsBlocked");
  });
});
