/**
 * Il banner, provato come documento e non come stringa.
 *
 * Le due domande che contano sono: è XML valido anche col nome peggiore che
 * qualcuno possa avere, e i numeri che mostra sono quelli delle statistiche
 * (non delle costanti rimaste nel modello). Il resto — dove cade una `<text>` —
 * è geometria, e si guarda con gli occhi.
 */

import { describe, expect, test } from "bun:test";
import { renderBanner, compact, esc, sparkPath } from "./profile-banner";
import type { ProfileStats } from "./profile-stats";

/**
 * Un controllo di buona formazione scritto a mano, perché in questo repo non
 * ci sono né jsdom né happy-dom (è una scelta dichiarata in più test del
 * client) e `DOMParser` non esiste sotto Bun.
 *
 * Verifica le due sole cose che possono rompersi qui: i tag si chiudono nello
 * stesso ordine in cui si aprono, e fra un tag e l'altro non compaiono `<` o
 * `&` nudi. Un nome non escapato sbaglia entrambe.
 */
function benFormato(xml: string): string[] {
  const errori: string[] = [];
  const stack: string[] = [];
  const tag = /<(\/?)([a-zA-Z][\w:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let ultimo = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml)) !== null) {
    const testo = xml.slice(ultimo, m.index);
    if (/[<>]/.test(testo)) errori.push(`testo con < o > non escapato: ${testo.slice(0, 40)}`);
    if (/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(testo)) errori.push(`& nudo: ${testo.slice(0, 40)}`);
    ultimo = m.index + m[0].length;
    const [, chiude, nome, , autochiuso] = m;
    if (autochiuso) continue;
    if (chiude) {
      if (stack.pop() !== nome) errori.push(`</${nome}> non chiude ciò che era aperto`);
    } else {
      stack.push(nome!);
    }
  }
  if (stack.length) errori.push(`tag mai chiusi: ${stack.join(", ")}`);
  return errori;
}

const STATS: ProfileStats = {
  sessions: { total: 737, open: 10 },
  messages: { total: 14_697, assistant: 10_535 },
  tokens: { total: 9_629_422_233, chat: 9_552_704_812, agents: 76_717_421 },
  cost: { measuredUsd: 3287.04, uncertainRows: 12 },
  tasks: { total: 1272, done: 1146, inProgress: 7 },
  projects: 8,
  agentHours: 78.1,
  activity: {
    firstSeen: "2026-02-05T13:15:00.406Z",
    activeDays: 101,
    streakDays: 5,
    last30: Array.from({ length: 30 }, (_, i) => ({
      date: `2026-07-${String(i + 1).padStart(2, "0")}`,
      tokens: i * 1000,
    })),
  },
};

describe("compact", () => {
  test("abbrevia in su e scrive per intero in giù", () => {
    expect(compact(9_629_422_233)).toBe("9.6B");
    expect(compact(1_146)).toBe("1.1K");
    expect(compact(14_697)).toBe("15K");
    expect(compact(912)).toBe("912");
    expect(compact(0)).toBe("0");
  });

  test("non lascia il decimale a zero: `9.0M` è rumore", () => {
    expect(compact(9_000_000)).toBe("9M");
  });
});

describe("esc", () => {
  test("copre i cinque caratteri che rompono XML, e `&` per prima", () => {
    expect(esc(`Tizio & <Caio> "d'accordo"`)).toBe(
      "Tizio &amp; &lt;Caio&gt; &quot;d&apos;accordo&quot;",
    );
  });
});

describe("sparkPath", () => {
  test("con tutti i giorni a zero non disegna niente invece di una linea piatta bugiarda", () => {
    expect(sparkPath(Array.from({ length: 30 }, () => ({ tokens: 0 })), 100, 30)).toBeNull();
  });

  test("il punto più alto tocca il bordo superiore e il più basso quello inferiore", () => {
    const p = sparkPath([{ tokens: 0 }, { tokens: 10 }], 100, 30)!;
    expect(p.line).toBe("M0.0,30.0 L100.0,0.0");
  });

  test("un solo giorno non è una curva", () => {
    expect(sparkPath([{ tokens: 5 }], 100, 30)).toBeNull();
  });
});

describe("renderBanner", () => {
  test("è un documento XML ben formato", () => {
    const svg = renderBanner(STATS, { name: "zorahrel" });
    expect(benFormato(svg)).toEqual([]);
    expect(svg.startsWith("<svg xmlns=")).toBe(true);
  });

  test("un nome ostile non produce né markup né documento rotto", () => {
    const svg = renderBanner(STATS, { name: `</text><script>alert(1)</script>` });
    expect(svg).not.toContain("<script>");
    expect(benFormato(svg)).toEqual([]);
  });

  test("una `&` nel nome resta un carattere, non un'entità rotta", () => {
    const svg = renderBanner(STATS, { name: "Rossi & Figli" });
    expect(benFormato(svg)).toEqual([]);
    expect(svg).toContain("Rossi &amp; Figli");
  });

  test("mostra i numeri VERI delle statistiche", () => {
    const svg = renderBanner(STATS);
    expect(svg).toContain("737");   // sessioni
    expect(svg).toContain("1.1K");  // task chiusi
    expect(svg).toContain("9.6B");  // token
    expect(svg).toContain("101");   // giorni attivi
    expect(svg).toContain("5d streak");
  });

  test("il costo misurato è per esteso, e il `+` dichiara le righe escluse", () => {
    expect(renderBanner(STATS)).toContain("$3287.04+ measured spend");
    const senzaIncerte = renderBanner({ ...STATS, cost: { measuredUsd: 12, uncertainRows: 0 } });
    expect(senzaIncerte).toContain("$12.00 measured spend");
    expect(senzaIncerte).not.toContain("$12.00+");
  });

  test("senza costo misurato non dice «$0.00»: dice che l'installazione è tua", () => {
    expect(renderBanner({ ...STATS, cost: { measuredUsd: 0, uncertainRows: 0 } })).toContain("self-hosted");
  });

  test("i due temi cambiano davvero il fondo", () => {
    expect(renderBanner(STATS, { theme: "dark" })).toContain("#0d1117");
    expect(renderBanner(STATS, { theme: "light" })).toContain("#ffffff");
  });

  test("porta un testo alternativo: in un README un'immagine muta è una riga vuota", () => {
    const svg = renderBanner(STATS, { name: "j" });
    expect(/<title id="t">j — Topics stats<\/title>/.test(svg)).toBe(true);
    expect(svg).toContain('role="img"');
  });

  test("su statistiche a zero resta un documento valido (installazione appena nata)", () => {
    const zero: ProfileStats = {
      sessions: { total: 0, open: 0 },
      messages: { total: 0, assistant: 0 },
      tokens: { total: 0, chat: 0, agents: 0 },
      cost: { measuredUsd: 0, uncertainRows: 0 },
      tasks: { total: 0, done: 0, inProgress: 0 },
      projects: 0,
      agentHours: 0,
      activity: { firstSeen: null, activeDays: 0, streakDays: 0, last30: [] },
    };
    expect(benFormato(renderBanner(zero))).toEqual([]);
  });
});
