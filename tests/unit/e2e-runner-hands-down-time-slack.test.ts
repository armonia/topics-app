/**
 * Il banco e2e decide il fattore di slack UNA volta e lo passa giù.
 *
 * `tests/helpers/time-slack.ts` legge `TOPICS_TEST_TIME_SLACK` una volta per
 * processo, e i worker di Playwright vengono forkati dal runner: l'env che
 * leggono è quello scritto in `globalSetup`. Ma solo se qualcuno lo scrive, e
 * per mesi nessuno lo faceva — `grep` dell'env in `.github/workflows/ci.yml`
 * dava zero, e ogni attesa e2e scadeva su un budget nudo mentre gli altri due
 * runner il fattore lo misuravano da tempo.
 *
 * Qui si prova la FUNZIONE, non la forma del sorgente: `handDownTimeSlack`
 * prende l'env e la macchina come parametri, quindi il caso «runner appena
 * nato» e il caso «macchina sepolta» si scrivono in una riga l'uno. Che il fork
 * erediti davvero l'env è stato verificato lanciando la suite (runner x3.0,
 * worker `TIME_SLACK=3`) e resta leggibile nel log di CI, che è il motivo per
 * cui la riga si stampa sempre.
 *
 * @covers E2E-GATE-11
 */
import { describe, it, expect } from "bun:test";
import { handDownTimeSlack } from "../e2e/helpers/time-slack-handoff";
import { TIME_SLACK_ENV } from "../../shared/test-time-slack";

describe("il banco e2e passa giù il fattore di slack", () => {
  it("scrive il fattore misurato nell'env che i worker erediteranno", () => {
    const env: Record<string, string | undefined> = {};
    const { slack } = handDownTimeSlack(env, { load: 12, cores: 4 });
    expect(slack).toBe(4);
    expect(env[TIME_SLACK_ENV]).toBe("4");
  });

  it("su una macchina scarica non allarga niente, e lo scrive lo stesso", () => {
    // Il caso del runner appena nato: il fattore è 1, cioè la leva non si
    // accende. Scriverlo comunque è ciò che permette al log di dirlo.
    const env: Record<string, string | undefined> = {};
    const { slack, note } = handDownTimeSlack(env, { load: 0.4, cores: 4 });
    expect(slack).toBe(1);
    expect(env[TIME_SLACK_ENV]).toBe("1");
    expect(note).toContain("x1.0");
  });

  it("un valore forzato a mano vince sulla misura", () => {
    const env: Record<string, string | undefined> = { [TIME_SLACK_ENV]: "3" };
    expect(handDownTimeSlack(env, { load: 40, cores: 4 }).slack).toBe(3);
    expect(env[TIME_SLACK_ENV]).toBe("3");
  });

  it("la riga da stampare porta il numero E la misura da cui viene", () => {
    // Senza il carico accanto, un «x1.0» non distingue «macchina scarica» da
    // «la sonda non ha letto niente».
    expect(handDownTimeSlack({}, { load: 6, cores: 12 }).note).toBe("time slack x1.0, load 6.0/12");
  });

  it("global-setup lo chiama, e lo chiama dopo aver seminato", () => {
    // L'unica cosa che resta statica: il PUNTO della chiamata. Misurare in cima
    // al processo è il difetto che rendeva la leva finta, e non c'è modo di
    // provarlo da dentro la funzione.
    const src = Bun.file(new URL("../e2e/global-setup.ts", import.meta.url)).text();
    return src.then((s) => {
      const call = s.indexOf("handDownTimeSlack()");
      const seeding = s.indexOf("Could not seed baseline data");
      expect(call).toBeGreaterThan(0);
      expect(call).toBeGreaterThan(seeding);
    });
  });
});
