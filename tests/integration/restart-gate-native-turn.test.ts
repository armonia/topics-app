/**
 * IL CANCELLO DEL RIAVVIO SOPRA UN TURNO NATIVO FINTO.
 *
 * I test unitari di `server/lib/quiescence.ts` provano le regole una per una.
 * Qui si mette insieme la catena intera come la usa `waitForDispatcherQuiescent`
 * — il registro degli stream, la riga sul disco che dice se il turno e' finito,
 * il verdetto, il battito su file che tiene a bada il SIGTERM di
 * `start-prod.sh`, la notifica — perche' i difetti misurati non stavano in una
 * regola sbagliata: stavano in COSA il giro faceva con la regola giusta.
 *
 * Due misure che questo file fissa:
 *   · 2026-09-04 00:12 — un turno nativo su topic:a4d19786 trattiene
 *     `restart-when-idle`. Il rinvio esiste dal primo istante, ma veniva
 *     dichiarato solo dopo il tetto lungo: fino a li' nessun battito (quindi lo
 *     script poteva sparare il SIGTERM sul turno che il cancello proteggeva) e
 *     nessuna notifica alla sola persona che poteva finire l'attesa.
 *   · 2026-09-03 — 2160 secondi di attesa su topic:6b9605e5, il cui turno era
 *     gia' morto di `400 prompt is too long`: la voce era rimasta nel registro
 *     in memoria, e il cancello contava la voce invece del turno.
 *
 * Il db e' vero (bun:sqlite), il file del battito e' vero, l'orologio no: un
 * tetto si prova facendolo scadere, non aspettando un minuto.
 *
 * @covers RGATE-01, RGATE-02, RGATE-03
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { join } from "node:path";
import { testTmpDir } from "./helpers";
import {
  describeInFlight,
  quiescenceVerdict,
  reloadHeldNotice,
  unadoptableStreams,
  unfinishedStreams,
  type ReloadHeldNotice,
} from "../../server/lib/quiescence";
import { touchReloadDeferred, RELOAD_DEFERRED_FILE } from "../../server/lib/reload-deferred";

const TEST_HOME = testTmpDir("restart-gate");

beforeAll(() => {
  process.env.TOPICS_HOME = TEST_HOME;
  fs.mkdirSync(TEST_HOME, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

const CHAT_CAP_MS = 60_000;
const CAP_MS = 25 * 60_000;

interface FakeStream {
  sessionKey: string;
  messageId: string;
  survivesRestart: boolean;
}

/** Una riga di risposta come la scrive un turno: `partial` e' il perno. */
function makeDb(rows: Array<{ id: string; partial: number }>): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, partial INTEGER)");
  const ins = db.prepare("INSERT INTO messages (id, partial) VALUES (?, ?)");
  for (const r of rows) ins.run(r.id, r.partial);
  return db;
}

/**
 * La forma esatta del giro di `waitForDispatcherQuiescent`, con l'orologio in
 * mano al test. Torna cosa e' successo: quando il primo battito e' stato
 * scritto, quando (e quante volte) e' partita la notifica, e come e' finita.
 */
function runGate(opts: {
  db: Database;
  streams: FakeStream[];
  cards?: number;
  /** Quanti millisecondi dura la prova, a giri da 500 ms come in produzione. */
  forMs: number;
  /** Il turno smette da solo a questo istante (la riga viene finalizzata). */
  finishAt?: number;
}) {
  const { db, streams } = opts;
  const cards = opts.cards ?? 0;
  const stmt = db.prepare("SELECT partial FROM messages WHERE id = ?");
  const turnFinished = (messageId: string): boolean => {
    const row = stmt.get(messageId) as { partial?: number } | undefined;
    return row ? row.partial === 0 : false;
  };

  const heartbeatFile = join(TEST_HOME, RELOAD_DEFERRED_FILE);
  fs.rmSync(heartbeatFile, { force: true });

  let firstHeartbeatAt: number | null = null;
  let notice: { at: number; value: ReloadHeldNotice } | null = null;
  let notices = 0;
  let esito: "procedi" | "tagliato" | "ancora in attesa" = "ancora in attesa";
  let notified = false;

  for (let now = 0; now <= opts.forMs; now += 500) {
    if (opts.finishAt !== undefined && now >= opts.finishAt) {
      db.run("UPDATE messages SET partial = 0");
    }
    const live = unfinishedStreams(streams, turnFinished);
    const streamKeys = live.map((s) => s.sessionKey);
    const unadoptable = unadoptableStreams(live).length;
    const busy = describeInFlight({ cards, streamKeys, brokerOpenKeys: [] });
    const verdetto = quiescenceVerdict({
      busy, unrecoverable: cards + unadoptable,
      now, startedAt: 0, chatCapMs: CHAT_CAP_MS,
    });
    if (verdetto === "procedi") { esito = "procedi"; break; }
    if (verdetto === "scaduto") { esito = "tagliato"; break; }
    if (verdetto === "rinvia") {
      // Il battito vero: e' il file che `start-prod.sh` legge per non sparare
      // il proprio SIGTERM al posto nostro.
      touchReloadDeferred();
      if (firstHeartbeatAt === null && fs.existsSync(heartbeatFile)) firstHeartbeatAt = now;
      const noticeAfterMs = cards > 0 ? CAP_MS : CHAT_CAP_MS;
      if (!notified && now >= noticeAfterMs) {
        const avviso = reloadHeldNotice({
          waitedMs: now, noticeAfterMs, busy: busy ?? "",
          holderName: null, holderKind: "turn", waitId: "w-test",
        });
        if (avviso) {
          notified = true;
          notices += 1;
          notice = { at: now, value: avviso };
        }
      }
    }
  }
  return { firstHeartbeatAt, notice, notices, esito };
}

describe("restart-when-idle sopra un turno nativo (RGATE-01, RGATE-02)", () => {
  const nativo: FakeStream = { sessionKey: "topic:a4d19786", messageId: "m-nativo", survivesRestart: false };

  test("il rinvio e' dichiarato al PRIMO giro, non dopo il tetto lungo", () => {
    const out = runGate({ db: makeDb([{ id: "m-nativo", partial: 1 }]), streams: [nativo], forMs: 5_000 });
    expect(out.firstHeartbeatAt).toBe(0);
    expect(out.esito).toBe("ancora in attesa");
  });

  test("la notifica arriva al minuto, una sola volta, e nomina il topic", () => {
    const out = runGate({ db: makeDb([{ id: "m-nativo", partial: 1 }]), streams: [nativo], forMs: 5 * 60_000 });
    expect(out.notice?.at).toBe(CHAT_CAP_MS);
    expect(out.notices).toBe(1);
    expect(out.notice?.value.body).toContain("topic:a4d19786");
    expect(out.notice?.value.body).toContain("fermalo dalla chat");
  });

  test("e il turno non viene MAI tagliato, per quanto si aspetti", () => {
    const out = runGate({ db: makeDb([{ id: "m-nativo", partial: 1 }]), streams: [nativo], forMs: 60 * 60_000 });
    expect(out.esito).not.toBe("tagliato");
  });

  /**
   * L'altra meta', o sarebbe un blocco invece di un rinvio: appena il turno
   * finisce, il riavvio parte da solo.
   */
  test("finito il turno, il riavvio parte da solo", () => {
    const out = runGate({
      db: makeDb([{ id: "m-nativo", partial: 1 }]), streams: [nativo],
      forMs: 10 * 60_000, finishAt: 2 * 60_000,
    });
    expect(out.esito).toBe("procedi");
  });

  /**
   * Una CARD trattiene allo stesso modo, ma al minuto non sveglia nessuno: il
   * suo turno ha gia' un limite proprio (`dispatchTimeoutMin`), quindi
   * quell'attesa finisce da sola.
   */
  test("una card rinvia subito ma avvisa tardi", () => {
    const out = runGate({ db: makeDb([]), streams: [], cards: 1, forMs: 5 * 60_000 });
    expect(out.firstHeartbeatAt).toBe(0);
    expect(out.notice).toBeNull();
  });
});

describe("un turno morto non trattiene niente (RGATE-03)", () => {
  test("lo stream di un turno gia' finalizzato non conta come in streaming", () => {
    // topic:6b9605e5, morto di «prompt is too long»: la riga e' finalizzata,
    // la voce nel registro e' rimasta. allow-italian: cita il messaggio di errore
    const out = runGate({
      db: makeDb([{ id: "m-morto", partial: 0 }]),
      streams: [{ sessionKey: "topic:6b9605e5", messageId: "m-morto", survivesRestart: false }],
      forMs: 5_000,
    });
    expect(out.esito).toBe("procedi");
    expect(out.firstHeartbeatAt).toBeNull();
  });

  test("il morto non copre il vivo: se resta un turno aperto, si rinvia lo stesso", () => {
    const out = runGate({
      db: makeDb([{ id: "m-morto", partial: 0 }, { id: "m-vivo", partial: 1 }]),
      streams: [
        { sessionKey: "topic:6b9605e5", messageId: "m-morto", survivesRestart: false },
        { sessionKey: "topic:a4d19786", messageId: "m-vivo", survivesRestart: false },
      ],
      forMs: 2 * 60_000,
    });
    expect(out.esito).toBe("ancora in attesa");
    expect(out.notice?.value.body).toContain("topic:a4d19786");
    expect(out.notice?.value.body).not.toContain("topic:6b9605e5");
  });
});
