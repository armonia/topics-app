/**
 * Uno script `running` riletto dal disco si riadotta solo se e' LO STESSO
 * processo, non solo lo stesso numero.
 *
 * PERCHE' ESISTE. Il pid degli script lanciati da Topics viene persistito e, al
 * boot, riadottato con un solo `isPidAlive(pid)`. Il server puo' restare giu'
 * ore: in quel tempo il sistema ricicla i numeri, e la voce riadottata finiva
 * in pannello con un bottone Stop che manda SIGTERM a un processo di qualcun
 * altro. Il commento di `saveState` nominava questo pericolo da sempre, e il
 * disambiguatore (`ps -o lstart=`) esisteva gia' per il SIGKILL ritardato: non
 * era cablato qui.
 *
 * La corsa vera non si fabbrica (non si ricicla un pid a comando), quindi il
 * verdetto e' puro e la sonda si passa. Il caso «stesso pid, lstart diverso» E'
 * il pid riciclato.
 */
import { describe, expect, test } from "bun:test";
import { readoptVerdict } from "./processes";

const LSTART = "Fri Aug 15 09:12:03 2026";
const OTHER = "Fri Aug 15 11:40:55 2026";

describe("readoptVerdict", () => {
  test("stesso pid, stesso start-time: e' il nostro, si riadotta", () => {
    expect(readoptVerdict({ pid: 4242, pidLstart: LSTART, probe: () => LSTART })).toBe("adopt");
  });

  /** La barra: il difetto in una riga. Prima questo tornava "adopt". */
  test("stesso pid, start-time DIVERSO: e' un pid riciclato, non si tocca", () => {
    expect(readoptVerdict({ pid: 4242, pidLstart: LSTART, probe: () => OTHER })).toBe("dead");
  });

  test("il pid non esiste piu': morto", () => {
    expect(readoptVerdict({ pid: 4242, pidLstart: LSTART, probe: () => undefined })).toBe("dead");
  });

  test("senza timbro si rinuncia: uno stato vecchio non puo' provare la sua identita'", () => {
    expect(readoptVerdict({ pid: 4242, probe: () => LSTART })).toBe("dead");
  });

  test("nessun pid: morto", () => {
    expect(readoptVerdict({ pid: null, probe: () => LSTART })).toBe("dead");
    expect(readoptVerdict({ pid: 0, pidLstart: LSTART, probe: () => LSTART })).toBe("dead");
  });

  test("su un processo VERO il timbro e' stabile fra due letture", async () => {
    // La sonda vera non deve essere rumorosa: se `lstart` cambiasse fra due
    // letture, il verdetto direbbe "riciclato" per ogni processo sano.
    const proc = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      const read = (): string | undefined => {
        const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(proc.pid)]);
        const out = new TextDecoder().decode(r.stdout).trim();
        return out || undefined;
      };
      const first = read();
      expect(first).toBeTruthy();
      await new Promise((r) => setTimeout(r, 1100));
      expect(readoptVerdict({ pid: proc.pid, pidLstart: first, probe: read })).toBe("adopt");
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 15_000);
});
