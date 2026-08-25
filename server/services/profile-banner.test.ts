/**
 * Il banner, provato come documento e non come stringa.
 *
 * Le due domande che contano sono: è XML valido anche col nome peggiore che
 * qualcuno possa avere, e i numeri che mostra sono quelli delle statistiche
 * (non delle costanti rimaste nel modello). Il resto — dove cade una `<text>` —
 * è geometria, e si guarda con gli occhi.
 *
 * @covers PROFILE-05
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

/**
 * Numeri SINTETICI, scelti a mano: tondi dove non serve altro, con i decimali
 * dove il test deve provare una formattazione (il costo). NON rigenerarli dal
 * DB vivo — questo file finisce in un repo pubblico, e le statistiche d'uso di
 * un'installazione reale non ci devono entrare. Servono solo a coprire i casi
 * di `compact` (miliardi, migliaia, arrotondamento) e la larghezza della card.
 */
const STATS: ProfileStats = {
  sessions: { total: 500, open: 10 },
  // Tondi anche qui, e LONTANI da qualunque misura vera: un numero sintetico
  // che sfiora quello reale si legge come reale, e in un repo pubblico e' la
  // stessa fuga con un decimale di differenza.
  messages: { total: 20_000, assistant: 12_000 },
  // Non tondissimo di proposito: `5_000_000_000` si abbrevia in «5B» e smette
  // di provare il ramo col decimale, che e' meta' del lavoro di `compact`.
  tokens: { total: 5_400_000_000, chat: 5_300_000_000, agents: 100_000_000 },
  cost: { measuredUsd: 1234.56, uncertainRows: 12 },
  tasks: { total: 1500, done: 1100, inProgress: 5 },
  projects: 6,
  agentHours: 60,
  activity: {
    firstSeen: "2026-01-01T00:00:00.000Z",
    activeDays: 120,
    streakDays: 7,
    last30: Array.from({ length: 30 }, (_, i) => ({
      date: `2026-07-${String(i + 1).padStart(2, "0")}`,
      tokens: i * 1000,
    })),
  },
};

describe("compact", () => {
  test("abbrevia in su e scrive per intero in giù", () => {
    expect(compact(8_500_000_000)).toBe("8.5B");
    expect(compact(1_100)).toBe("1.1K");
    expect(compact(14_500)).toBe("15K"); // sopra 10K si arrotonda al migliaio
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
    const svg = renderBanner(STATS, { name: "pippo" });
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

  test("i numeri delle statistiche arrivano sul disegno, abbreviati", () => {
    // Si chiamava «i numeri VERI»: erano davvero quelli di un'installazione
    // reale, ed e' il motivo per cui sono stati sostituiti. Cio' che il test
    // prova non cambia — che ogni cifra esca dal calcolo e passi da `compact`.
    const svg = renderBanner(STATS);
    expect(svg).toContain("500 sessions");    // sessioni
    expect(svg).toContain("1.1K");            // task chiusi
    expect(svg).toContain("5.4B");            // token, col ramo decimale
    expect(svg).toContain("120 active days"); // giorni attivi
    expect(svg).toContain("7d streak");
  });

  test("il costo misurato è per esteso, e il `+` dichiara le righe escluse", () => {
    expect(renderBanner(STATS)).toContain("$1234.56+ measured spend");
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
    expect(/<title id="t">j · Topics stats<\/title>/.test(svg)).toBe(true);
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
