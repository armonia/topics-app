import { describe, test, expect } from "bun:test";
import { decidePark, idleParkThresholdMs, refusalLabel, summarizeRefusals, type ParkCandidate, type ParkRefusal } from "./terminal-idle-park";

/**
 * Ogni test qui è un modo in cui parcheggiare farebbe DANNO.
 *
 * Un reaper su questo sottosistema ha già ucciso turni vivi una volta, e la
 * lezione è che il costo dei due errori non è simmetrico: non parcheggiare
 * spreca un po' di RAM, parcheggiare a sproposito interrompe il lavoro di
 * qualcuno o — peggio — lo rende irrecuperabile.
 *
 * @covers TERM-04
 */

const THRESHOLD = 30 * 60 * 1000;

const parkable = (over: Partial<ParkCandidate> = {}): ParkCandidate => ({
  id: "t1",
  type: "claude-code",
  claudeSessionId: "cs-1",
  busy: false,
  idleMs: THRESHOLD + 1,
  attachedClients: 0,
  hasTranscript: true,
  phase: "awaiting-user",
  ...over,
});

describe("decidePark", () => {
  test("il caso base: sessione Claude ferma al prompt, nessuno che guarda", () => {
    // È esattamente la fotografia delle tredici sessioni misurate: ferme da
    // giorni in `awaiting-user`, con la loro conversazione su disco.
    expect(decidePark(parkable(), THRESHOLD)).toEqual({ park: true });
  });

  describe("non si parcheggia ciò che non tornerebbe indietro", () => {
    test("una shell non ha `--resume`: il suo scrollback E' il suo stato", () => {
      expect(decidePark(parkable({ type: "shell" }), THRESHOLD)).toEqual({
        park: false,
        reason: "not-resumable-type",
      });
    });

    test("codex e' escluso: il percorso di uscita ne CANCELLA la riga invece di renderla dormiente", () => {
      // `canResume` in routes/terminal.ts vale solo per i tipi claude. Uccidere
      // una PTY codex non la parcheggia: la perde.
      expect(decidePark(parkable({ type: "codex" }), THRESHOLD)).toEqual({
        park: false,
        reason: "not-resumable-type",
      });
    });

    test("senza claude_session_id non c'e' niente da riprendere", () => {
      expect(decidePark(parkable({ claudeSessionId: undefined }), THRESHOLD)).toEqual({
        park: false,
        reason: "no-resume-id",
      });
    });

    test("senza transcript su disco `--resume` fallirebbe PER SEMPRE", () => {
      // È il caso peggiore: la sessione non torna, e la pane resta a sbattere
      // contro un resume che non può riuscire.
      expect(decidePark(parkable({ hasTranscript: false }), THRESHOLD)).toEqual({
        park: false,
        reason: "no-transcript",
      });
    });
  });

  describe("non si parcheggia un turno vivo", () => {
    test("la PTY sta scrivendo adesso", () => {
      expect(decidePark(parkable({ busy: true }), THRESHOLD)).toEqual({ park: false, reason: "busy" });
    });

    for (const phase of ["starting", "running", "tool-running", "awaiting-approval", "watching"] as const) {
      test(`fase '${phase}': turno in corso`, () => {
        expect(decidePark(parkable({ phase }), THRESHOLD)).toEqual({
          park: false,
          reason: "phase-active",
        });
      });
    }

    test("`awaiting-user` invece SI': e' la sessione ferma ad aspettare una persona", () => {
      // Deliberato. È la fase delle tredici sessioni misurate, cioe' il caso per
      // cui questo meccanismo esiste. Se fosse esclusa, non parcheggerebbe mai
      // niente.
      expect(decidePark(parkable({ phase: "awaiting-user" }), THRESHOLD)).toEqual({ park: true });
    });

    for (const phase of ["paused", "completed", "error", "dormant"] as const) {
      test(`fase '${phase}': a riposo, si puo' parcheggiare`, () => {
        expect(decidePark(parkable({ phase }), THRESHOLD)).toEqual({ park: true });
      });
    }
  });

  describe("non si parcheggia sotto gli occhi di qualcuno", () => {
    test("un client attaccato al WebSocket ferma tutto", () => {
      // Con il client di oggi una sessione che sparisce dal roster fa comparire
      // «Sessione scaduta»: farlo mentre qualcuno la guarda e' inaccettabile.
      expect(decidePark(parkable({ attachedClients: 1 }), THRESHOLD)).toEqual({
        park: false,
        reason: "watched",
      });
    });

    test("piu' client, stesso esito", () => {
      expect(decidePark(parkable({ attachedClients: 3 }), THRESHOLD)).toEqual({
        park: false,
        reason: "watched",
      });
    });
  });

  describe("in mancanza di dati NON si parcheggia", () => {
    test("inattivita' sconosciuta (`null`) non e' inattivita' lunga", () => {
      // `getClaudeSessionPtyIdleMs` restituisce null quando non c'e' una misura.
      // Trattarlo come "ferma da sempre" e' il modo classico di reapare cose vive.
      expect(decidePark(parkable({ idleMs: null }), THRESHOLD)).toEqual({
        park: false,
        reason: "idle-unknown",
      });
    });

    test("fase sconosciuta (`null`) non blocca, ma tutto il resto deve reggere", () => {
      // La fase manca per una sessione mai passata dal tracker. Da sola non e'
      // un motivo per rifiutare — gli altri gate (busy, watched, idle) coprono.
      expect(decidePark(parkable({ phase: null }), THRESHOLD)).toEqual({ park: true });
      expect(decidePark(parkable({ phase: null, busy: true }), THRESHOLD)).toEqual({
        park: false,
        reason: "busy",
      });
    });
  });

  describe("la soglia", () => {
    test("appena sotto: no", () => {
      expect(decidePark(parkable({ idleMs: THRESHOLD - 1 }), THRESHOLD)).toEqual({
        park: false,
        reason: "too-recent",
      });
    });
    test("esattamente sulla soglia: si'", () => {
      expect(decidePark(parkable({ idleMs: THRESHOLD }), THRESHOLD)).toEqual({ park: true });
    });
    test("zero (appena attiva): no", () => {
      expect(decidePark(parkable({ idleMs: 0 }), THRESHOLD)).toEqual({
        park: false,
        reason: "too-recent",
      });
    });
  });

  test("l'ordine dei rifiuti mette per primo il piu' grave", () => {
    // Una sessione senza transcript E occupata deve dire "no-transcript": e' il
    // motivo per cui non si potra' MAI parcheggiare, mentre "busy" e' passeggero.
    expect(decidePark(parkable({ hasTranscript: false, busy: true }), THRESHOLD)).toEqual({
      park: false,
      reason: "no-transcript",
    });
  });
});

describe("idleParkThresholdMs", () => {
  test("assente = spento (il default)", () => {
    expect(idleParkThresholdMs({})).toBeNull();
    expect(idleParkThresholdMs({ TOPICS_TERMINAL_IDLE_PARK_MS: "" })).toBeNull();
    expect(idleParkThresholdMs({ TOPICS_TERMINAL_IDLE_PARK_MS: "   " })).toBeNull();
  });

  test("un valore incomprensibile resta SPENTO, non «parcheggia subito»", () => {
    // Il fallimento silenzioso qui sarebbe: `Number("mezz'ora")` = NaN, ogni
    // confronto falso, e a seconda di come lo si scrive o non parcheggia mai o
    // parcheggia tutto. Meglio spegnersi e dirlo.
    expect(idleParkThresholdMs({ TOPICS_TERMINAL_IDLE_PARK_MS: "mezz'ora" })).toBeNull();
    expect(idleParkThresholdMs({ TOPICS_TERMINAL_IDLE_PARK_MS: "0" })).toBeNull();
    expect(idleParkThresholdMs({ TOPICS_TERMINAL_IDLE_PARK_MS: "-5000" })).toBeNull();
  });

  test("un valore valido passa", () => {
    expect(idleParkThresholdMs({ TOPICS_TERMINAL_IDLE_PARK_MS: "1800000" })).toBe(1_800_000);
  });

  test("sotto il minuto si alza al minuto", () => {
    // Con dieci secondi si parcheggerebbe una sessione fra un comando e l'altro.
    expect(idleParkThresholdMs({ TOPICS_TERMINAL_IDLE_PARK_MS: "10000" })).toBe(60_000);
  });
});


describe("il riepilogo dei rifiuti — una passata deve dire PERCHE'", () => {
  test("aggrega per motivo e mette prima il piu' frequente", () => {
    // Aggregato e non elencato: la riga resta lunga uguale con tre PTY o con
    // trenta, ed e' l'unica forma che si puo' lasciare accesa in un log.
    const riga = summarizeRefusals([
      { reason: "phase-active" },
      { reason: "watched" },
      { reason: "phase-active" },
    ]);
    expect(riga).toBe("3 non parcheggiate: 2 turno in corso, 1 qualcuno la sta guardando");
  });

  test("niente da dire quando non c'e' niente da dire", () => {
    expect(summarizeRefusals([])).toBe("");
  });

  test("OGNI motivo ha la sua etichetta: nessuno si stampa come `undefined`", () => {
    // E' il motivo per cui `skipped` e' tipato `ParkRefusal` e non `string`:
    // aggiungere un motivo senza etichetta deve rompere la compilazione, non
    // produrre una riga di log rotta a runtime.
    const tutti: ParkRefusal[] = [
      "not-resumable-type", "no-resume-id", "no-transcript", "busy",
      "watched", "phase-active", "idle-unknown", "too-recent", "sub-agent",
    ];
    for (const r of tutti) {
      expect(refusalLabel(r), `il motivo "${r}" non ha etichetta`).toBeTruthy();
    }
  });

  test("«sotto-agente» e' un rifiuto come gli altri, deciso dal chiamante", () => {
    // Non lo produce `decidePark` ma il chiamante, e finisce nella stessa lista:
    // fuori dall'union sarebbe l'unico motivo senza prosa.
    expect(summarizeRefusals([{ reason: "sub-agent" }])).toContain("orchestratore");
  });
});
