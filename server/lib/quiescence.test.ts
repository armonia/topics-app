/**
 * Il cancello di `restart-when-idle` guardava solo le CARD della board.
 *
 * Le tre prove che contano sono le tre fonti prese una alla volta: la seconda e
 * la terza sono quelle che prima non esistevano, e sono rosse contro
 * l'implementazione vecchia (`while (busyCount() > 0)`) per costruzione — con
 * `cards: 0` quel predicato usciva subito, cioè `null`, cioè «riavvia pure».
 */
import { test, expect, describe } from "bun:test";
import { describeInFlight, unadoptableStreams, providerSurvivesRestart } from "./quiescence";

const nothing = { cards: 0, streamKeys: [], brokerOpenKeys: [] };

describe("describeInFlight — che cosa trattiene un riavvio pianificato", () => {
  test("niente in volo ⇒ null, ed è l'unica risposta che autorizza il riavvio", () => {
    expect(describeInFlight(nothing)).toBeNull();
  });

  test("una card della board trattiene", () => {
    const out = describeInFlight({ ...nothing, cards: 3 });
    expect(out).toContain("3");
    expect(out).toContain("card");
  });

  /**
   * IL BUCO STORICO #1: una chat umana non è una card. `activeStreams` è
   * popolata da `startStream` per OGNI turno, dispacciato o no, ma il cancello
   * non la guardava. Con la logica vecchia questo caso valeva «idle».
   */
  test("una chat che sta streammando in questo processo trattiene", () => {
    const out = describeInFlight({ ...nothing, streamKeys: ["topic:9fe7a291"] });
    expect(out).not.toBeNull();
    expect(out).toContain("topic:9fe7a291");
    expect(out).toContain("streaming");
  });

  /**
   * IL BUCO STORICO #2, ed è il più insidioso: dopo un riavvio il turno vivo NON
   * ha nessuna rappresentazione in questo processo. La gamba di riadozione si
   * chiude in un attimo e `endStream` toglie la voce da `activeStreams`; da lì
   * in poi card e stream dicono «fermo» ed è vero — il figlio CLI però sta
   * ancora lavorando, e solo il broker lo sa.
   */
  test("un turno adottato, visibile SOLO al broker, trattiene", () => {
    const out = describeInFlight({ ...nothing, brokerOpenKeys: ["topic:9fe7a291"] });
    expect(out).not.toBeNull();
    expect(out).toContain("topic:9fe7a291");
    expect(out).toContain("broker");
  });

  test("più fonti insieme: si nomina la più economica e più certa", () => {
    const out = describeInFlight({ cards: 2, streamKeys: ["topic:aaa"], brokerOpenKeys: ["topic:bbb"] });
    // La frase finisce in un log letto da chi si chiede perché il suo
    // salvataggio non è ancora in produzione: una fonte sola, la prima.
    expect(out).toContain("card");
    expect(out).not.toContain("topic:aaa");
    expect(out).not.toContain("topic:bbb");
  });

  test("liste vuote non sono «qualcosa in volo»", () => {
    expect(describeInFlight({ cards: 0, streamKeys: [], brokerOpenKeys: [] })).toBeNull();
  });
});

/**
 * IL BUCO STORICO #3, ed è quello che ha ucciso topic:9f9e9629 il 20/08.
 *
 * Il cancello distingueva due categorie — card e chat — e dava alle chat
 * l'attesa corta appoggiandosi su una promessa: «la reload-resilience la
 * riadotta». Quella promessa la mantiene solo un turno che gira in un processo
 * FIGLIO: il SIGTERM non lo tocca, il broker lo tiene, al riavvio torna.
 *
 * Un turno del runtime nativo `topics` gira DENTRO il processo del server.
 * Quando il processo muore non c'è nessun figlio da riadottare: la promessa è
 * falsa, e il danno è identico a quello di una card tagliata — lavoro perso,
 * senza ritorno. Nel log del 20/08: `[quiescence] aspetto prima di riavviare —
 * 1 chat in streaming (topic:9f9e9629)`, sessanta secondi, SIGTERM, e una
 * risposta rimasta a metà frase.
 *
 * La categoria giusta quindi non è «chat vs card»: è «sopravvive vs non
 * sopravvive».
 */
describe("unadoptableStreams — quali chat NON tornano dopo un riavvio", () => {
  const s = (sessionKey: string, survivesRestart: boolean) => ({ sessionKey, survivesRestart });

  test("una chat su un provider che sa riadottare non trattiene a lungo", () => {
    expect(unadoptableStreams([s("topic:aaa", true)])).toEqual([]);
  });

  test("LA CHAT DEL 20/08: runtime nativo, nessuna riadozione possibile", () => {
    expect(unadoptableStreams([s("topic:9f9e9629", false)])).toEqual(["topic:9f9e9629"]);
  });

  test("si guarda una sessione alla volta: le due specie convivono", () => {
    expect(unadoptableStreams([s("topic:cli", true), s("topic:nativa", false)]))
      .toEqual(["topic:nativa"]);
  });

  test("nessuno stream, niente da trattenere", () => {
    expect(unadoptableStreams([])).toEqual([]);
  });
});

/**
 * IL PREDICATO A MONTE: chi decide `survivesRestart` quando lo stream nasce.
 *
 * Si chiede al provider e non al suo NOME. Un elenco di nomi ("topics" e' fragile,
 * "claude-code" e' solido) sarebbe una tabella da aggiornare a ogni runtime
 * nuovo, e il runtime che qualcuno dimenticasse di aggiungerci erediterebbe in
 * silenzio l'attesa corta — cioe' il difetto del 20/08 daccapo, con un altro
 * nome. `reattach` non e' un indizio del fatto che il turno sopravvive: e' il
 * metodo che lo fa sopravvivere.
 */
describe("providerSurvivesRestart — la domanda si fa al provider, non al nome", () => {
  test("chi sa riadottare sopravvive", () => {
    expect(providerSurvivesRestart({ reattach: async () => "live" })).toBe(true);
  });

  test("chi non sa riadottare no: il turno vive nel processo del server", () => {
    expect(providerSurvivesRestart({})).toBe(false);
  });

  test("un provider assente non promette niente", () => {
    expect(providerSurvivesRestart(undefined)).toBe(false);
    expect(providerSurvivesRestart(null)).toBe(false);
  });

  /**
   * Il campo c'e' ma non e' chiamabile: e' una promessa che nessuno puo'
   * mantenere, e vale come assente.
   */
  test("un `reattach` che non e' una funzione non conta", () => {
    expect(providerSurvivesRestart({ reattach: true })).toBe(false);
  });
});
