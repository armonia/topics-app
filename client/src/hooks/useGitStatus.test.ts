import { test, expect, describe } from "bun:test";
import { desiredInterval, recordFetchFailure } from "./useGitStatus";

/**
 * Il passo del poll dello stato git.
 *
 * Il caso che conta e' il PRIMO errore. Il piu' comune e' anche il piu'
 * effimero: il server tiene l'allowlist dei progetti in una cache da 5
 * secondi, quindi una cartella appena aperta puo' prendersi un 400 mentre la
 * risposta giusta e' li' un attimo dopo. Con il vecchio calcolo
 * (`base * 2^streak`) il primo errore portava il ritentativo a 30 secondi, e
 * si guardava un pannello in errore per mezzo minuto senza motivo.
 *
 * @covers FILE-02
 */
describe("desiredInterval", () => {
  test("senza errori e' il passo normale", () => {
    expect(desiredInterval({ wsChannels: 0, errorStreak: 0 })).toBe(15000);
  });

  test("con il WS attivo il poll si rilassa", () => {
    // Gli aggiornamenti arrivano dal push: il poll e' solo una rete.
    expect(desiredInterval({ wsChannels: 1, errorStreak: 0 })).toBe(60000);
  });

  test("il primo ritentativo e' CORTO, non un multiplo del passo", () => {
    expect(desiredInterval({ wsChannels: 0, errorStreak: 1 })).toBe(2000);
    // E resta corto anche col WS attivo: qui non stiamo rilassando, stiamo
    // riprovando una cosa che probabilmente e' gia' a posto.
    expect(desiredInterval({ wsChannels: 1, errorStreak: 1 })).toBe(2000);
  });

  test("gli errori che continuano diradano davvero", () => {
    expect(desiredInterval({ wsChannels: 0, errorStreak: 2 })).toBe(4000);
    expect(desiredInterval({ wsChannels: 0, errorStreak: 3 })).toBe(8000);
    expect(desiredInterval({ wsChannels: 0, errorStreak: 5 })).toBe(32000);
  });

  test("e c'e' un tetto: non si smette mai di riprovare, ma nemmeno si insiste", () => {
    // Il poll non va MAI a zero: prima un errore azzerava il timer e lo stato
    // di quel progetto restava congelato fino al rimontaggio del pannello.
    expect(desiredInterval({ wsChannels: 0, errorStreak: 20 })).toBe(120000);
    expect(desiredInterval({ wsChannels: 0, errorStreak: 999 })).toBe(120000);
  });
});

/**
 * The autofetch switches off at the second failed fetch in a row, and it keeps
 * its own count. While the count lived in `errorStreak`, every successful status
 * poll reset it, a few seconds apart, and the failing fetch ran again every 3
 * minutes forever.
 */
describe("autofetch", () => {
  test("due fetch falliti lo spengono anche se in mezzo il poll di stato riesce", () => {
    const store = { errorStreak: 0, fetchErrorStreak: 0, fetchDisabled: false };
    recordFetchFailure(store);
    store.errorStreak = 0; // a successful status poll, as `load` does
    recordFetchFailure(store);
    expect(store.fetchDisabled).toBe(true);
  });

  test("un fetch fallito non dirada il poll di stato", () => {
    const store = { errorStreak: 0, fetchErrorStreak: 0, fetchDisabled: false, wsChannels: 0 };
    recordFetchFailure(store);
    expect(store.fetchDisabled).toBe(false);
    expect(desiredInterval(store)).toBe(desiredInterval({ wsChannels: 0, errorStreak: 0 }));
  });
});
