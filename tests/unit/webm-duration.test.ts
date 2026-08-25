/**
 * La misura su cui si regge il cancello della clip di consegna.
 *
 * `clipDiConsegna` rifiuta un video oltre i 20s, e quel rifiuto vale quanto il
 * numero che legge: un parser che sbaglia la scala dei tempi di un fattore due
 * lascerebbe passare una clip da 40s dicendo «20». Qui i .webm sono costruiti a
 * mano, byte per byte, così l'attesa è un numero DICHIARATO e non l'output del
 * parser stesso.
 *
 * I tre casi che contano: la durata scritta nell'header, la stessa con una
 * scala dei tempi diversa dal default, e l'header senza durata — dove il numero
 * deve uscire dai cluster e DIRLO.
  * @covers MEDIA-02
 */
import { describe, it, expect } from "bun:test";
import { misuraWebm } from "../e2e/helpers/webm-duration";

const ID_EBML = [0x1a, 0x45, 0xdf, 0xa3];
const ID_SEGMENT = [0x18, 0x53, 0x80, 0x67];
const ID_INFO = [0x15, 0x49, 0xa9, 0x66];
const ID_TIMECODE_SCALE = [0x2a, 0xd7, 0xb1];
const ID_DURATION = [0x44, 0x89];
const ID_CLUSTER = [0x1f, 0x43, 0xb6, 0x75];
const ID_TIMECODE = [0xe7];

/** Dimensione in vint, nella codifica più corta che la contiene. */
function vint(n: number): Buffer {
  for (let len = 1; len <= 8; len++) {
    if (n < Math.pow(2, 7 * len) - 1) {
      const out = Buffer.alloc(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      out[0] |= 0x80 >> (len - 1);
      return out;
    }
  }
  throw new Error(`vint: ${n} non ci sta in 8 byte`);
}

function uint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  do {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return Buffer.from(out);
}

function f64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n, 0);
  return b;
}

function elem(id: number[], body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id), vint(body.length), body]);
}

function cluster(timecode: number): Buffer {
  return elem(ID_CLUSTER, elem(ID_TIMECODE, uint(timecode)));
}

/** Un .webm minimo ma VALIDO: header EBML, Segment, e dentro quel che serve. */
function webm(dentroIlSegment: Buffer[]): Buffer {
  return Buffer.concat([
    elem(ID_EBML, Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d])), // DocType "webm"
    elem(ID_SEGMENT, Buffer.concat(dentroIlSegment)),
  ]);
}

describe("misuraWebm", () => {
  it("legge la durata dichiarata nell'header", () => {
    const info = elem(
      ID_INFO,
      Buffer.concat([elem(ID_TIMECODE_SCALE, uint(1_000_000)), elem(ID_DURATION, f64(12_345))]),
    );
    const misura = misuraWebm(webm([info, cluster(0), cluster(9_000)]));
    expect(misura.fonte).toBe("duration");
    expect(misura.ms).toBeCloseTo(12_345, 3);
  });

  it("applica la scala dei tempi: i tick non sono millisecondi", () => {
    // Mezzo millisecondo per tick: 40 000 tick sono 20 secondi, non 40.
    const info = elem(
      ID_INFO,
      Buffer.concat([elem(ID_TIMECODE_SCALE, uint(500_000)), elem(ID_DURATION, f64(40_000))]),
    );
    expect(misuraWebm(webm([info])).ms).toBeCloseTo(20_000, 3);
  });

  it("senza TimecodeScale il tick vale un millisecondo", () => {
    const info = elem(ID_INFO, elem(ID_DURATION, f64(8_500)));
    expect(misuraWebm(webm([info])).ms).toBeCloseTo(8_500, 3);
  });

  it("header senza durata: ripiega sull'ultimo cluster e lo dichiara", () => {
    const info = elem(ID_INFO, elem(ID_TIMECODE_SCALE, uint(1_000_000)));
    const misura = misuraWebm(webm([info, cluster(0), cluster(4_200), cluster(9_800)]));
    expect(misura.fonte).toBe("clusters");
    expect(misura.ms).toBeCloseTo(9_800, 3);
  });

  it("una durata a zero non conta come dichiarata", () => {
    // Un muxer interrotto lascia lo zero al posto della durata. Prenderlo per
    // buono direbbe «clip di 0s», cioè un budget sempre rispettato.
    const info = elem(
      ID_INFO,
      Buffer.concat([elem(ID_TIMECODE_SCALE, uint(1_000_000)), elem(ID_DURATION, f64(0))]),
    );
    const misura = misuraWebm(webm([info, cluster(3_300)]));
    expect(misura.fonte).toBe("clusters");
    expect(misura.ms).toBeCloseTo(3_300, 3);
  });

  it("un file che non è un webm alza invece di rispondere zero", () => {
    expect(() => misuraWebm(Buffer.from("non sono un video, sono un testo"))).toThrow();
  });

  it("un webm senza Segment alza", () => {
    expect(() => misuraWebm(elem(ID_EBML, Buffer.from([0x00])))).toThrow(/Segment/);
  });
});
