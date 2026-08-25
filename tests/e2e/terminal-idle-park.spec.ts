import { expect } from "@playwright/test";
import { test } from "./fixtures/terminal.fixture";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
import {
  resetTerminalWorkspace,
  seedTerminalTopic,
  cleanupTerminalTopic,
  gotoTerminalProject,
} from "./helpers/terminal-workspace";
import { hermetic } from "./fixtures/hermetic";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { claudeProjectDirName } from "../../server/lib/claude-transcript-path";
import { join } from "path";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);
/**
 * IL TERMINALE HA BISOGNO DI PIU' DEI 30 SECONDI DI DEFAULT.
 *
 * Non e' generosita': e' una misura. Questi casi aprono una PTY vera, aspettano
 * il ponte WebSocket e poi che xterm.js dipinga - da soli fanno 19 secondi, cioe'
 * gia' due terzi del tetto. Dentro uno shard, con un solo worker e la macchina
 * carica, arrivano a 36-42 e sforano.
 *
 * Misurato il 17/08 su TRE corse complete della suite: i test del terminale
 * cadevano in tutte e tre (`TERM-01`, `TERM-02`, `TERM-04`, reconnect,
 * idle-park), ma bersagli DIVERSI ogni volta e tutti verdi rieseguiti da soli.
 * Un rosso che cambia bersaglio non e' una regressione: e' un tetto troppo
 * stretto per il lavoro che c'e' dentro.
 *
 * 75 secondi, non un numero rotondo a caso: il peggiore misurato e' 42s sotto
 * carico, e questo lascia il margine per una macchina piu' lenta senza
 * trasformare un test appeso in cinque minuti di attesa. Se un giorno un caso
 * qui dentro impiega davvero 75 secondi, il problema non e' il tetto.
 *
 * @covers TERM-01
 */
test.describe.configure({ timeout: 75_000 });


/**
 * Il parcheggio delle sessioni ferme, dai due lati.
 *
 * COS'È. Le chat hanno un reaper di inattività (15 min) e un tetto di vita (2
 * ore); i terminali agente non avevano né l'uno né l'altro. Misurate il
 * 2026-08-02: tredici `claude --resume` vive da tre giorni e cinque ore, ~15% di
 * CPU e 0,9 GB per sessioni ferme a un prompt. Il parcheggio uccide la PTY e
 * lascia la riga `dormant`; lo stato vero è su disco ed è ciò che `--resume`
 * rilegge.
 *
 * PERCHÉ LE DUE METÀ VANNO PROVATE INSIEME. Il server da solo produce una
 * regressione: una sessione che sparisce dal roster fa comparire alla sua pane
 * l'overlay «Sessione scaduta» col bottone Ricarica. Sarebbe un risparmio che si
 * paga in tredici tab da ricliccare. La seconda metà — `SingleTerminalPane`, che
 * rianima quando la pane torna attiva — è ciò che lo rende invisibile, e un test
 * che guardasse solo il server la darebbe per scontata.
 *
 * CHI si parcheggia lo decide `server/lib/terminal-idle-park.ts`, puro e con 28
 * test suoi (compreso il caso peggiore: nessun transcript su disco → `--resume`
 * fallirebbe per sempre → non si parcheggia). Qui si prova l'EFFETTO.
 *
 * Lo sweep si fa scattare con `POST /api/test/terminal/park-idle`, che chiama la
 * stessa funzione del server con una soglia scelta da qui: in produzione è un
 * timer al minuto con mezz'ora di soglia, e aspettarla sarebbe un test da mezz'ora.
 */

type SessionRow = {
  id: string;
  type: string;
  /** Il cwd RISOLTO dal server. Su macOS `/tmp` diventa `/private/tmp`, e da lì dipende il nome della cartella del transcript. */
  cwd: string;
  claudeSessionId?: string;
  status?: string;
};

test.describe("Parcheggio delle sessioni terminale ferme", () => {
  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    ({ topicId, topicName } = await seedTerminalTopic(request, "park"));
  });

  test.beforeEach(async ({ request }) => {
    await resetTerminalWorkspace(request, topicId);
  });

  test.afterAll(async ({ request }) => {
    await cleanupTerminalTopic(request, topicId);
  });

  /** Crea una sessione claude-code e attende che abbia un id da `--resume`. */
  async function createResumableSession(
    request: import("@playwright/test").APIRequestContext,
    name: string,
  ): Promise<SessionRow> {
    const res = await request.post(`${E2E_BASE}/api/terminal/sessions`, {
      data: { cwd: "/tmp", type: "claude-code", name },
    });
    expect(res.ok(), "la creazione della sessione claude-code deve riuscire").toBe(true);
    const created = (await res.json()) as SessionRow;

    // `claudeSessionId` arriva nella risposta della POST, non nell'elenco: la
    // forma tipizzata di `GET /sessions` omette quel campo (lo dice
    // terminal-session-resume.spec.ts, che per questo asserisce il VALORE solo
    // sulle risposte POST). Pollare la lista non lo troverebbe mai — ci ho
    // perso una passata.
    //
    // E' la precondizione del parcheggio: senza, `decidePark` rifiuta con
    // `no-resume-id` e questi test proverebbero il rifiuto invece del caso.
    expect(
      created.claudeSessionId,
      "senza claude_session_id non c'e' niente da parcheggiare",
    ).toBeTruthy();

    return created;
  }

  /**
   * Semina il TRANSCRIPT della sessione, e restituisce come toglierlo.
   *
   * PERCHÉ serve. `decidePark` rifiuta con `no-transcript` finché quel file non
   * c'è, ed è il gate più importante: parcheggiare senza vorrebbe dire che
   * `--resume` fallirebbe PER SEMPRE, cioè la sessione non tornerebbe mai. Ma
   * qui la CLI il file non lo scrive: nell'ambiente E2E `claude` non arriva mai
   * a inizializzarsi (la cartella `~/.claude/projects/-tmp` non compare
   * nemmeno), quindi senza seminarlo questi test misurerebbero quel rifiuto
   * invece del caso che vogliono provare. L'ho scoperto solo perché lo sweep ora
   * DICE perché ha rifiutato.
   *
   * DOVE, e perché non è la home vera. `claudeTranscriptPath` compone il
   * percorso con `homedir()`, cioè con la HOME del PROCESSO che la chiama: nel
   * server di test quella è la home ISOLATA (`start-test-server.sh` esporta
   * `HOME=$DATA_DIR/.home`), nel processo di questo test è quella dell'utente.
   * Usare l'helper da qui seminava quindi nel posto sbagliato mentre il gate
   * guardava nell'altro — `no-transcript` a ripetizione, e quattro `.jsonl`
   * vuoti lasciati nel `~/.claude` dell'utente prima che me ne accorgessi. Il
   * percorso si compone su `E2E_HOME`, che è la home che il server sta davvero
   * usando: così questo test non tocca niente fuori dalla sua `DATA_DIR`.
   *
   * Si cancella solo il file scritto, e la directory solo se l'abbiamo creata
   * noi — mai ricorsivamente, mai qualcosa che non abbiamo scritto.
   */
  // Le pulizie da fare comunque. Un test che fallisce a meta' non deve lasciare
  // file sotto il ~/.claude dell'utente: e' successo alla prima passata rossa, e
  // ho dovuto togliere a mano quattro .jsonl vuoti. L'afterEach li toglie sempre.
  const pendingCleanups: Array<() => void> = [];
  test.afterEach(() => {
    while (pendingCleanups.length) pendingCleanups.pop()!();
  });

  function seedTranscript(session: SessionRow): () => void {
    // Il cwd viene dalla RISPOSTA del server, non scritto a mano: è quello che
    // finisce nella mappa in memoria, ed è su quello che il gate compone il
    // percorso.
    const file = join(
      E2E_HOME,
      ".claude",
      "projects",
      claudeProjectDirName(session.cwd),
      `${session.claudeSessionId}.jsonl`,
    );
    const dir = dirname(file);
    const dirWasOurs = !existsSync(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "");
    const cleanup = () => {
      try { if (existsSync(file)) unlinkSync(file); } catch { /* best effort */ }
      // `rmdir` non ricorsiva: fallisce se dentro c'è dell'altro, ed è la
      // garanzia che non porteremo via il lavoro di nessuno.
      try { if (dirWasOurs) rmdirSync(dir); } catch { /* non era vuota: si lascia */ }
    };
    pendingCleanups.push(cleanup);
    return cleanup;
  }


  /**
   * Porta la sessione a una fase A RIPOSO, con l'hook `Stop`.
   *
   * Una sessione appena creata è in `starting`, e `decidePark` rifiuta con
   * `phase-active` — giustamente: un avvio in corso non si parcheggia. Qui la
   * CLI non arriva mai a uscire da `starting` da sola (nell'ambiente E2E
   * `claude` non si inizializza), quindi la si fa transitare come fa l'app
   * VERA: l'hook che Claude Code invia a fine turno.
   *
   * Non è una scorciatoia sul gate — il gate resta quello di produzione. È il
   * modo di arrivare allo stato che in produzione arriva da solo.
   */
  async function settleToRestingPhase(
    request: import("@playwright/test").APIRequestContext,
    session: SessionRow,
  ): Promise<void> {
    // Il token vive nella HOME del server (isolata nei test), scritto al boot.
    const tokenPath = join(E2E_HOME, ".claude", "topics-app", "hook-token");
    expect(existsSync(tokenPath), `il server non ha scritto il token degli hook (${tokenPath})`).toBe(true);
    const token = readFileSync(tokenPath, "utf-8").trim();

    const res = await request.post(`${E2E_BASE}/api/claude-hooks/Stop`, {
      headers: { authorization: `Bearer ${token}` },
      data: { session_id: session.claudeSessionId, cwd: session.cwd },
    });
    expect(res.ok(), "l'hook Stop deve essere accettato").toBe(true);
  }

  type SweepResult = { parked: string[]; skipped: Array<{ id: string; reason: string }> };

  /**
   * Fa girare lo sweep con la soglia data.
   *
   * Restituisce anche i RIFIUTI col loro motivo: senza, un test che non vede il
   * parcheggio non sa distinguere «il gate ha fatto il suo lavoro» da «lo sweep
   * e' rotto», e i messaggi di fallimento non direbbero niente di utile.
   */
  async function sweep(
    request: import("@playwright/test").APIRequestContext,
    thresholdMs: number,
  ): Promise<SweepResult> {
    const res = await request.post(`${E2E_BASE}/api/test/terminal/park-idle`, {
      data: { thresholdMs },
    });
    expect(res.ok(), "la route di test deve essere armata (TOPICS_E2E=1)").toBe(true);
    return (await res.json()) as SweepResult;
  }

  const why = (r: SweepResult, id: string) =>
    r.skipped.find((s) => s.id === id)?.reason ?? "(non elencata)";

  /**
   * Questo ambiente riesce a tenere VIVA una sessione claude?
   *
   * Lo sweep guarda la mappa in memoria delle sessioni, che si popola solo se il
   * bridge ha davvero avviato una PTY. Dove il binario `claude` non c'è — i
   * runner di CI — il server conia comunque un `claudeSessionId` e restituisce
   * 200, ma la sessione non entra mai in quella mappa: lo sweep non la vede né
   * fra le parcheggiate né fra le rifiutate, e i test qui sotto misurerebbero
   * l'assenza di `claude` invece dei gate.
   *
   * Si rileva UNA volta, con la stessa macchina che i test usano: se dopo uno
   * sweep l'id non compare da nessuna parte, la PTY non c'è.
   */
  let claudePtyAvailable: boolean | null = null;

  async function ensureClaudePty(
    request: import("@playwright/test").APIRequestContext,
  ): Promise<boolean> {
    if (claudePtyAvailable !== null) return claudePtyAvailable;
    const res = await request.post(`${E2E_BASE}/api/terminal/sessions`, {
      data: { cwd: "/tmp", type: "claude-code", name: "E2E-Park-Probe" },
    });
    if (!res.ok()) {
      claudePtyAvailable = false;
      return false;
    }
    const probe = (await res.json()) as SessionRow;
    const seen = await sweep(request, 0);
    claudePtyAvailable =
      seen.parked.includes(probe.id) || seen.skipped.some((s) => s.id === probe.id);
    await request.delete(`${E2E_BASE}/api/terminal/sessions/${probe.id}`).catch(() => {});
    return claudePtyAvailable;
  }

  const NO_CLAUDE =
    "in questo ambiente il bridge non tiene viva una PTY `claude` " +
    "(su CI il binario non c'è): lo sweep non vedrebbe la sessione, e il test " +
    "misurerebbe quello invece dei gate. La decisione è coperta comunque da " +
    "server/lib/terminal-idle-park.test.ts, che non ha bisogno di un ambiente.";

  /**
   * PERCHÉ QUI NON C'È IL CASO POSITIVO.
   *
   * L'ultimo gate è `idle-unknown`: senza una misura dell'inattività della PTY
   * (`terminalActivity.lastAt`) non si parcheggia, e la misura esiste solo se la
   * PTY ha prodotto output almeno una volta. In questo ambiente la CLI non
   * arriva mai a scrivere niente — `claude` non si inizializza sotto il server
   * di test, come mostra il fatto che non compare neppure la cartella del suo
   * transcript — quindi una sessione creata da qui non può, per costruzione,
   * arrivare a essere parcheggiabile.
   *
   * Fingerlo sarebbe peggio del non averlo: significherebbe iniettare
   * `lastAt` a mano e provare che il codice fa quello che gli si è appena
   * detto di fare. Quello che si può provare è più utile, e sta qui sotto: che
   * su una sessione VERA ogni gate scatta, in ordine, col suo motivo. La
   * decisione in sé — inclusa la combinazione che porta al parcheggio — ha 28
   * test in `server/lib/terminal-idle-park.test.ts`, dove i fatti si possono
   * comporre senza fingere un ambiente.
   */
  test("senza una misura di inattivita' NON si parcheggia", async ({ request }) => {
    test.skip(!(await ensureClaudePty(request)), NO_CLAUDE);
    // È la regola che tiene in piedi tutto il resto: un `null` non è "ferma da
    // sempre". Trattarlo come tale è il modo classico di reapare qualcosa di
    // vivo, ed è successo davvero in questo repo.
    const session = await createResumableSession(request, "E2E-Park-NoIdle");
    seedTranscript(session);
    await settleToRestingPhase(request, session);

    const result = await sweep(request, 0);
    expect(
      result.parked,
      "senza sapere da quanto e' ferma, non si tocca",
    ).not.toContain(session.id);
    expect(why(result, session.id)).toBe("idle-unknown");

    await request.delete(`${E2E_BASE}/api/terminal/sessions/${session.id}`).catch(() => {});
  });

  test("i gate scattano in ORDINE: il piu' grave per primo", async ({ request }) => {
    test.skip(!(await ensureClaudePty(request)), NO_CLAUDE);
    // Su una sessione vera, togliendo un ostacolo alla volta, il motivo del
    // rifiuto avanza. E' la prova che i gate sono cablati davvero — non che
    // esistono nel modulo puro, ma che lo sweep li applica a cio' che ha in mano.
    const session = await createResumableSession(request, "E2E-Park-Order");

    // 1. Appena creata: manca il transcript. E' il rifiuto piu' grave, perche'
    //    e' l'unico irreversibile (--resume fallirebbe per sempre).
    expect(why(await sweep(request, 0), session.id)).toBe("no-transcript");

    // 2. Col transcript, resta la fase: sta ancora avviandosi.
    seedTranscript(session);
    expect(why(await sweep(request, 0), session.id)).toBe("phase-active");

    // 3. A turno finito, resta l'unica cosa che qui non si puo' produrre: la
    //    misura dell'inattivita'.
    await settleToRestingPhase(request, session);
    expect(why(await sweep(request, 0), session.id)).toBe("idle-unknown");

    await request.delete(`${E2E_BASE}/api/terminal/sessions/${session.id}`).catch(() => {});
  });

  test("una sessione GUARDATA non si parcheggia", async ({ request, page }) => {
    test.skip(!(await ensureClaudePty(request)), NO_CLAUDE);
    // Il gate `watched` e' quello che tiene il meccanismo invisibile: con il
    // client di oggi una sessione che sparisce dal roster fa comparire
    // «Sessione scaduta», e farlo sotto gli occhi di qualcuno e' inaccettabile.
    const session = await createResumableSession(request, "E2E-Park-Watched");
    // Senza transcript il rifiuto sarebbe `no-transcript` e non proverebbe
    // niente sul gate `watched`, che e' cio' che questo test guarda.
    const cleanupTranscript = seedTranscript(session);
    await settleToRestingPhase(request, session);

    // Si apre la pane: il WebSocket della sessione diventa un client attaccato.
    await gotoTerminalProject(page, topicName);
    const ws = await page.evaluateHandle((id) => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(`${proto}//${location.host}/ws/terminal/${id}`);
    }, session.id);
    await expect
      .poll(() => ws.evaluate((s: WebSocket) => s.readyState), { timeout: 10_000 })
      .toBe(1 /* OPEN */);

    const result = await sweep(request, 0);
    expect(
      result.parked,
      "una sessione con un client attaccato non deve essere parcheggiata",
    ).not.toContain(session.id);
    expect(why(result, session.id), "e il motivo dev'essere proprio quello").toBe("watched");

    await ws.evaluate((s: WebSocket) => s.close());
    cleanupTranscript();
    await request.delete(`${E2E_BASE}/api/terminal/sessions/${session.id}`).catch(() => {});
  });

  test("una shell non si parcheggia mai: non ha un `--resume`", async ({ request }) => {
    // Il suo scrollback E' il suo stato: parcheggiarla lo perderebbe.
    const res = await request.post(`${E2E_BASE}/api/terminal/sessions`, {
      data: { cwd: "/tmp", type: "shell", name: "E2E-Park-Shell" },
    });
    expect(res.ok()).toBe(true);
    const shell = (await res.json()) as SessionRow;

    const result = await sweep(request, 0);
    expect(result.parked, "una shell non e' ripristinabile e non va parcheggiata").not.toContain(shell.id);
    expect(why(result, shell.id)).toBe("not-resumable-type");

    await request.delete(`${E2E_BASE}/api/terminal/sessions/${shell.id}`).catch(() => {});
  });

  test("con una soglia alta non si parcheggia niente", async ({ request }) => {
    test.skip(!(await ensureClaudePty(request)), NO_CLAUDE);
    // Il contrario del test principale: prova che a decidere e' la soglia, non
    // il fatto di aver chiamato lo sweep.
    const session = await createResumableSession(request, "E2E-Park-Threshold");
    const cleanupTranscript = seedTranscript(session);
    await settleToRestingPhase(request, session);

    const result = await sweep(request, 24 * 60 * 60 * 1000);
    expect(result.parked, "nessuna sessione e' ferma da un giorno").not.toContain(session.id);
    cleanupTranscript();

    await request.delete(`${E2E_BASE}/api/terminal/sessions/${session.id}`).catch(() => {});
  });
});
