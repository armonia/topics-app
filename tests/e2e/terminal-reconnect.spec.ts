import { expect } from "@playwright/test";
import { test } from "./fixtures/terminal.fixture";
import {
  resetTerminalWorkspace,
  seedTerminalTopic,
  cleanupTerminalTopic,
  gotoTerminalProject,
  openShellViaSidebar,
} from "./helpers/terminal-workspace";
import { hermetic } from "./fixtures/hermetic";

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
 */
test.describe.configure({ timeout: 75_000 });


/**
 * TERM-03: la riconnessione automatica dopo un WebSocket caduto.
 *
 *
 * Sta in un file suo perche' l'intercettazione WS va installata PRIMA della
 * navigazione, quindi non puo' usare la scorciatoia `navigateAndOpenTerminal`
 * degli altri: apre il progetto e la shell in due passi separati.
 *
 * PERCHE' I BUDGET QUI SONO LARGHI. Questo test è stato rosso 1 volta su 6 con
 * xterm a schermo ma vuoto, e il sospetto scritto sulla card era il proxy WS
 * qui sotto: i primi frame del server, quelli che portano il prompt, sembravano
 * perdersi passando dall'intercettazione. Misurato il 12/08/2026, il sospetto è
 * FALSO. Stessa apertura di shell, 10 giri alternati con e senza
 * `routeWebSocket`, mentre la board dispacciava altri agenti (load 27-51): dal
 * click al prompt sono passati da 2,2 s a 75 s, e senza proxy è andata se mai
 * PEGGIO (75 s contro 60 s). Il prompt è arrivato tutte e dieci le volte, mai
 * perso: 4 volte su 10 solo più tardi dei 15 s che il test concedeva.
 *
 * Quindi il rosso non era un frame perduto, era il muro del cronometro su una
 * macchina occupata. I 15 s di default restano dove sono per tutte le altre
 * spec (un prompt che non arriva DEVE restare un rosso rapido); qui l'attesa
 * sale a `SLOW_BOX_MS` e il test si dichiara lento, così una macchina carica
 * non produce un rosso che parla di lei e non del prodotto. Su una macchina
 * scarica non cambia niente: le attese sono condizionali, il test resta sui
 * suoi ~16 secondi.
 *
 * CONTROPROVA, la stessa sera. Dieci giri isolati per braccio, vecchio e nuovo
 * alternati sulla stessa macchina e in ENTRAMBI gli ordini (chi gira per primo
 * dentro il giro paga la macchina fredda, e senza invertire l'ordine quel
 * ritardo si legge come se fosse del codice), retry spenti perché un retry
 * nasconde proprio la cosa che si sta misurando: 10 su 10 verdi col fix, 4 su
 * 10 senza.
 *
 * Due cose che la misura ha detto e che a occhio non si vedevano. Primo: i sei
 * rossi non muoiono su una singola attesa, muoiono sul TETTO, «Test timeout of
 * 30000ms exceeded», con la pane xterm mai comparsa entro i suoi 15 s. Secondo,
 * e conta di più: TUTTI E DIECI i giri verdi hanno superato i 30 s (da 33,9 a
 * 52,4 s a load 23-45). Quindi `test.slow()` qui non è un margine di comodo, è
 * la metà del fix che porta il peso, e le due metà non si separano: allargare
 * le attese senza alzare il tetto sposta soltanto il punto in cui il cronometro
 * taglia. Il sintomo della card si è fatto vedere vivo una volta su dieci:
 * xterm a schermo dopo 0,4 s e il prompt arrivato 22,0 s più tardi, cioè verde
 * con 45 s e rosso con 15 s.
 *
 * La famiglia terminale sta in tre file — `terminal`, `terminal-reconnect`,
 * `terminal-multi` — che prima erano tre `describe` dentro un unico file da 76
 * secondi. Poiche' Playwright distribuisce gli shard PER FILE, quei 76 secondi
 * erano un pavimento sotto cui il wall-clock non poteva scendere con nessun
 * numero di shard. La procedura condivisa (apri il progetto, "+" -> Shell,
 * aspetta il prompt) vive in `helpers/terminal-workspace.ts`: era ricopiata
 * tre volte, gia' divergente fra le copie.
 */
/**
 * Il budget di UNA attesa su una macchina occupata. Vedi la nota in testa al
 * file per la misura: il peggiore dei 10 giri ha messo 75 s dal click al
 * prompt, quindi 45 s non è la garanzia di non essere mai più flaky, è il
 * punto dove il rosso torna a significare «il prodotto è rotto» invece di
 * «la macchina era sotto carico».
 */
const SLOW_BOX_MS = 45_000;

test.describe("Terminal Reconnect", () => {
  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    ({ topicId, topicName } = await seedTerminalTopic(request, "reconnect"));
  });

  test.beforeEach(async ({ request }) => {
    await resetTerminalWorkspace(request, topicId);
  });

  test.afterAll(async ({ request }) => {
    await cleanupTerminalTopic(request, topicId);
  });

  test("TERM-03: terminal auto-reconnects after WebSocket disconnect", async ({
    page,
    terminalPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    // Tre volte i 30 s di default. Il tetto del test è l'altra metà del budget:
    // allargare le singole attese senza toccarlo sposta solo il punto in cui il
    // cronometro taglia, e il rosso diventa «Test timeout exceeded», che non
    // dice nemmeno quale attesa non è arrivata in fondo.
    test.slow();
    // Set up WS interception BEFORE navigation to capture terminal WS connections
    type WsRoute = {
      close: (options?: { code?: number; reason?: string }) => void | Promise<void>;
    };
    const serverConnections: WsRoute[] = [];
    // We drive the disconnect from the CLIENT side (below), so keep the page-
    // side routes too. Closing the SERVER route does not reliably surface a
    // close event to the browser's WebSocket under Playwright's proxy (the
    // custom close code isn't propagated), so the client never sees the drop
    // and never reconnects. Closing the CLIENT route makes the page's socket
    // fire `onclose` with our non-1000 code — exactly a real network drop —
    // which is what SingleTerminalPane's auto-reconnect keys off.
    const clientConnections: WsRoute[] = [];
    await page.routeWebSocket(/\/ws\/terminal\//, (ws) => {
      const server = ws.connectToServer();
      serverConnections.push(server);
      clientConnections.push(ws);
      // Transparent proxy — pass through all messages
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => ws.send(msg));
    });

    // Navigazione e apertura in DUE passi: l'intercettazione qui sopra doveva
    // essere installata prima di `goto`, quindi questo test non puo' usare
    // `navigateAndOpenTerminal` (che fa entrambe le cose in una volta).
    await gotoTerminalProject(page, topicName);
    await openShellViaSidebar(page, terminalPage, SLOW_BOX_MS);

    // Verify terminal works before disconnect
    const marker1 = `pre-disconnect-${Date.now()}`;
    await terminalPage.focus();
    await terminalPage.typeCommand(`echo ${marker1}`);
    await terminalPage.waitForOutput(marker1, SLOW_BOX_MS);

    // Capture current server connection count
    const connectionsBefore = serverConnections.length;
    expect(connectionsBefore).toBeGreaterThanOrEqual(1);

    // Trigger disconnect by closing the CLIENT-side connection with a non-1000
    // code. Code 1000 is treated as a clean PTY-exit and the client will NOT
    // reconnect (SingleTerminalPane.tsx:376-382); 1001 forces auto-reconnect.
    const lastClient = clientConnections[clientConnections.length - 1];
    await lastClient.close({ code: 1001, reason: "e2e-disconnect" });

    // Wait for client to auto-reconnect — a new server connection should appear
    await expect(async () => {
      expect(serverConnections.length).toBeGreaterThan(connectionsBefore);
    }).toPass({ timeout: SLOW_BOX_MS });

    // Wait for terminal to stabilize after reconnect
    // The PTY process survives the WS disconnect; only the WS link broke
    // After reconnect, the shell is still alive and accepts commands
    await terminalPage.focus();
    const marker2 = `post-reconnect-${Date.now()}`;
    await terminalPage.typeCommand(`echo ${marker2}`);
    await terminalPage.waitForOutput(marker2, SLOW_BOX_MS);
  });
});
