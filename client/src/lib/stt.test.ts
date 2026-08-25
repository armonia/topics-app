/**
 * The sentence an empty voice note gets, carrying the two numbers that say
 * whether the microphone opened at all.
 *
 * @covers CHAT-04
 */
import { describe, it, expect } from "bun:test";
import { messaggioNotaVuota } from "./stt";

describe("messaggioNotaVuota", () => {
  // I due microfoni della app avevano lo stesso guasto e davano due risposte
  // diverse: la chat parlava (fe635287), il campo task della board taceva. Una
  // frase sola in un posto solo e' cio' che impedisce che succeda di nuovo.
  it("ZERO spezzoni dice che il microfono non ha aperto affatto", () => {
    const m = messaggioNotaVuota(0, 0, 'audio/mp4');
    expect(m).toContain('0 spezzoni');
    expect(m).toContain('0 byte');
    expect(m).toContain('audio/mp4');
  });

  it("pochi byte in uno spezzone dice che ha registrato silenzio", () => {
    const m = messaggioNotaVuota(1, 44, 'audio/webm;codecs=opus');
    expect(m).toContain('1 spezzoni');
    expect(m).toContain('44 byte');
  });

  it("senza mime non lascia un buco nella frase", () => {
    expect(messaggioNotaVuota(0, 0, '')).toContain('formato ignoto');
  });

  it("i due numeri ci sono SEMPRE: sono la diagnosi, non un contorno", () => {
    // La negazione utile: un messaggio generico («nota vocale vuota») non
    // distingue un permesso negato da un silenzio registrato, e sono due
    // riparazioni diverse.
    for (const [sp, by] of [[0, 0], [1, 44], [7, 511]] as const) {
      const m = messaggioNotaVuota(sp, by, 'audio/mp4');
      expect(m).toContain(`${sp} spezzoni`);
      expect(m).toContain(`${by} byte`);
    }
  });
});
