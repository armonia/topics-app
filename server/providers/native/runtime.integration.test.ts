/**
 * Il runtime nativo al lavoro, contro l'API VERA.
 *
 * Perché un test così, e non un mock. Tutto il senso di questo runtime è
 * togliere il tramite: se qui mockassi l'API proverei solo che so scrivere un
 * mock. La domanda a cui questo file risponde è l'unica che conta — «un agente
 * senza CLI riesce a lavorare su una macchina?» — e la si può verificare solo
 * facendogli cambiare un file per davvero.
 *
 * Si salta da solo dove non ci sono credenziali: su una macchina senza login la
 * risposta giusta è «non applicabile», non un fallimento.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { hasCredentials, getAccessToken } from "./auth";
import { runAgentTurn, type Message } from "./agent-loop";
import { executeTool } from "./tools";
import type { StreamHandler } from "../types";

const describeIfAuth = hasCredentials() ? describe : describe.skip;

let ws: string;

function recorder() {
  const text: string[] = [];
  const tools: Array<{ name: string; id: string }> = [];
  const results: Array<{ id: string; result: string; isError?: boolean }> = [];
  const errors: string[] = [];
  const handler: StreamHandler = {
    onTextDelta: (c) => text.push(c),
    onToolStart: (id, name) => tools.push({ id, name }),
    onToolResult: (id, result, isError) => results.push({ id, result, isError }),
    onDone: () => {},
    onError: (e) => errors.push(e),
  };
  return { handler, tools, results, errors, get full() { return text.join(""); } };
}

describeIfAuth("il runtime nativo, senza nessuna CLI", () => {
  beforeAll(() => { ws = mkdtempSync(join(tmpdir(), "native-rt-")); });
  afterAll(() => { try { rmSync(ws, { recursive: true, force: true }); } catch { /* scratch */ } });

  test("le credenziali si leggono e il token è valido", async () => {
    const tok = await getAccessToken();
    expect(tok).toBeTruthy();
    expect(tok!.length).toBeGreaterThan(20);
  }, 60_000);

  test("un turno semplice risponde in streaming", async () => {
    const rec = recorder();
    const history: Message[] = [{ role: "user", content: "Rispondi con la sola parola PONG." }];
    const out = await runAgentTurn(
      { model: "claude-haiku-4-5-20251001", history, toolContext: { workspace: ws }, tools: [] },
      rec.handler,
    );
    expect(rec.errors).toEqual([]);
    expect(out.turnEnd.end).toBe("end_turn");
    expect(rec.full.toUpperCase()).toContain("PONG");
    // I token si contano: senza, non sapremmo cosa costa un turno.
    expect(out.usage.input).toBeGreaterThan(0);
    expect(out.usage.output).toBeGreaterThan(0);
  }, 120_000);

  /**
   * IL TEST CHE GIUSTIFICA TUTTO IL RUNTIME. Non «il modello risponde», ma
   * «l'agente USA gli strumenti e il disco cambia». È la differenza fra una
   * chat e un agente, ed è ciò che finora poteva fare solo la CLI.
   */
  test("l'agente legge un file, lo modifica, e il disco cambia davvero", async () => {
    const file = join(ws, "nota.txt");
    writeFileSync(file, "ciao\n");
    const rec = recorder();
    const history: Message[] = [{
      role: "user",
      content: "Nel file nota.txt sostituisci la parola 'ciao' con 'PONG'. Usa gli strumenti, poi fermati.",
    }];

    const out = await runAgentTurn(
      { model: "claude-haiku-4-5-20251001", history, toolContext: { workspace: ws } },
      rec.handler,
    );

    expect(rec.errors).toEqual([]);
    expect(out.turnEnd.end).toBe("end_turn");
    // Ha davvero usato dei tool, non ha solo detto di averlo fatto.
    expect(rec.tools.length).toBeGreaterThan(0);
    // E la prova finale non è nel testo dell'agente: è sul disco.
    expect(readFileSync(file, "utf-8")).toContain("PONG");
    expect(readFileSync(file, "utf-8")).not.toContain("ciao");
  }, 180_000);

  /**
   * I PERMESSI CONTRO UN AGENTE VERO, che è l'unico modo di provarli davvero.
   * `permissions.test.ts` verifica la funzione che decide; qui si verifica che
   * quella decisione arrivi fino al disco — con un modello che ci prova sul
   * serio, non con una chiamata diretta.
   */
  test("in `ask` l'agente NON tocca il disco, per quanto glielo si chieda", async () => {
    const file = join(ws, "intoccabile.txt");
    writeFileSync(file, "originale\n");
    const rec = recorder();
    const history: Message[] = [{
      role: "user",
      content: "Scrivi la parola CAMBIATO dentro intoccabile.txt. Fallo subito con gli strumenti.",
    }];

    await runAgentTurn(
      {
        model: "claude-haiku-4-5-20251001",
        history,
        toolContext: { workspace: ws },
        autonomy: "ask",
      },
      rec.handler,
    );

    // La prova non è cosa ha detto l'agente: è che il file è quello di prima.
    expect(readFileSync(file, "utf-8")).toBe("originale\n");
  }, 180_000);

  test("in `auto-apply` un comando irreversibile viene rifiutato, ma il turno vive", async () => {
    const rec = recorder();
    const history: Message[] = [{
      role: "user",
      content: "Esegui esattamente questo comando con bash, senza alternative: git reset --hard HEAD~5",
    }];

    const out = await runAgentTurn(
      { model: "claude-haiku-4-5-20251001", history, toolContext: { workspace: ws }, autonomy: "auto-apply" },
      rec.handler,
    );

    // Il turno NON muore: un permesso negato è un risultato di tool, e
    // l'agente deve poter rispondere «non posso» invece di sparire.
    expect(out.turnEnd.end).toBe("end_turn");
    expect(rec.errors).toEqual([]);
    // Se ha provato a eseguirlo, si è preso un rifiuto leggibile.
    const rifiuti = rec.results.filter((r) => r.isError && r.result.includes("non si annulla"));
    if (rec.results.some((r) => r.result.includes("reset"))) {
      expect(rifiuti.length).toBeGreaterThan(0);
    }
  }, 180_000);

  /**
   * IL PREZZO DI UN AGENTE, che è la cosa che questo runtime rischiava di
   * sbagliare in silenzio. Un turno d'agente sono N giri che rimandano ogni
   * volta gli schemi dei tool, il preambolo e tutta la conversazione: senza i
   * breakpoint di cache si ripaga quel prefisso a prezzo pieno ogni giro.
   *
   * QUELLO CHE SI PUÒ MISURARE QUI, e va detto perché la prima versione di
   * questo test chiedeva la cosa sbagliata. Anthropic non cachea un prefisso
   * sotto una soglia minima (2048 token su haiku): con sei schemi di tool
   * (~813 token) e un preambolo corto, la cache NON scatta — e non è un
   * difetto, è la soglia che fa il suo lavoro. Pretendere `cacheRead > 0`
   * significava misurare il modello invece del nostro codice.
   *
   * Quello che è NOSTRO, e che un bug vero ha già rotto una volta: i marker non
   * devono ACCUMULARSI. Il loop riusa la stessa storia a ogni giro, quindi il
   * breakpoint del giro precedente resta dov'è; al quinto giro l'API rifiuta
   * tutto con «A maximum of 4 blocks with cache_control may be provided». Un
   * turno che muore al quinto giro per un'ottimizzazione di costo.
   */
  test("i breakpoint di cache non si accumulano: un turno lungo non viene rifiutato", async () => {
    const f = join(ws, "cache-probe.txt");
    writeFileSync(f, "uno\n");
    const rec = recorder();
    const history: Message[] = [{
      role: "user",
      content:
        "Fai questi passi UNO ALLA VOLTA, ognuno con una chiamata separata: " +
        "1) leggi cache-probe.txt; 2) scrivici DUE; 3) rileggilo; 4) scrivici TRE; " +
        "5) rileggilo; 6) scrivici QUATTRO. Poi fermati.",
    }];

    await runAgentTurn(
      { model: "claude-haiku-4-5-20251001", history, toolContext: { workspace: ws } },
      rec.handler,
    );

    // LA PROVA: nessun errore. Con i marker che si accumulano, il turno moriva
    // con un 400 dell'API intorno al quinto giro — quindi servono abbastanza
    // giri da superarlo.
    expect(rec.errors).toEqual([]);
    expect(rec.tools.length).toBeGreaterThanOrEqual(5);
    // E il lavoro è arrivato in fondo davvero.
    expect(readFileSync(f, "utf-8")).toContain("QUATTRO");
  }, 180_000);

  test("più sessioni insieme, un solo processo: nessuna CLI viva", async () => {
    // Il guadagno di memoria, verificato per come si manifesta: tre turni
    // concorrenti non lasciano tre processi in giro, perché non ce n'è
    // nessuno. La storia di ogni sessione è un array separato.
    const sessions = [1, 2, 3].map(() => ({
      rec: recorder(),
      history: [{ role: "user" as const, content: "Rispondi con la sola parola OK." }],
    }));
    await Promise.all(sessions.map((s) =>
      runAgentTurn(
        { model: "claude-haiku-4-5-20251001", history: s.history, toolContext: { workspace: ws }, tools: [] },
        s.rec.handler,
      ),
    ));
    for (const s of sessions) {
      expect(s.rec.errors).toEqual([]);
      expect(s.rec.full.toUpperCase()).toContain("OK");
      // Ogni sessione ha la SUA storia: domanda + risposta, non sei messaggi.
      expect(s.history.length).toBe(2);
    }
  }, 180_000);
});

/**
 * I tool da soli, senza modello: sono codice nostro e vanno provati come tale.
 * Qui non serve nessuna credenziale, quindi girano ovunque.
 */
describe("i tool di coding", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "native-tools-")); });
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ } });

  const ctx = () => ({ workspace: dir });

  test("write + read: il contenuto torna con i numeri di riga", async () => {
    await executeTool("write_file", { path: "a.txt", content: "uno\ndue\n" }, ctx());
    const r = await executeTool("read_file", { path: "a.txt" }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("uno");
    expect(r.content).toContain("1\t");
  });

  test("edit su testo unico riesce; su testo ambiguo NON scrive niente", async () => {
    await executeTool("write_file", { path: "b.txt", content: "x\nx\ny\n" }, ctx());
    const bad = await executeTool("edit_file", { path: "b.txt", old: "x", new: "z" }, ctx());
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("2 volte");
    // Il file non è stato toccato: un edit ambiguo che scrive è peggio di uno
    // che fallisce.
    expect(readFileSync(join(dir, "b.txt"), "utf-8")).toBe("x\nx\ny\n");

    const ok = await executeTool("edit_file", { path: "b.txt", old: "y", new: "z" }, ctx());
    expect(ok.isError).toBeFalsy();
    expect(readFileSync(join(dir, "b.txt"), "utf-8")).toContain("z");
  });

  test("edit di un testo assente lo dice, invece di fingere", async () => {
    await executeTool("write_file", { path: "c.txt", content: "solo questo\n" }, ctx());
    const r = await executeTool("edit_file", { path: "c.txt", old: "altro", new: "x" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("non trovato");
  });

  // IL CANCELLO. Un agente che sbaglia percorso non deve poter leggere il
  // resto del disco: `~/.ssh`, le credenziali, il progetto accanto.
  test("fuori dalla workspace non si esce, né in lettura né in scrittura", async () => {
    const up = await executeTool("read_file", { path: "../../../etc/hosts" }, ctx());
    expect(up.isError).toBe(true);
    expect(up.content).toContain("fuori dalla workspace");

    const abs = await executeTool("read_file", { path: "/etc/hosts" }, ctx());
    expect(abs.isError).toBe(true);

    const w = await executeTool("write_file", { path: "../fuori.txt", content: "no" }, ctx());
    expect(w.isError).toBe(true);
  });

  // Il vicino che comincia per lo stesso prefisso: `startsWith` lo lascerebbe
  // passare, ed è il motivo per cui il controllo usa `relative()`.
  test("una directory VICINA con lo stesso prefisso resta fuori", async () => {
    const sibling = `${dir}-altro`;
    const r = await executeTool("read_file", { path: sibling + "/x.txt" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("fuori dalla workspace");
  });

  test("bash: l'output torna, e un exit non-zero si vede", async () => {
    const ok = await executeTool("bash", { command: "echo ciao" }, ctx());
    expect(ok.content).toContain("ciao");
    expect(ok.isError).toBeFalsy();

    const ko = await executeTool("bash", { command: "exit 3" }, ctx());
    expect(ko.isError).toBe(true);
    expect(ko.content).toContain("exit 3");
  });

  test("grep trova, e «niente» è una risposta non un errore", async () => {
    await executeTool("write_file", { path: "d.txt", content: "ago nel pagliaio\n" }, ctx());
    const hit = await executeTool("grep", { pattern: "ago" }, ctx());
    expect(hit.content).toContain("d.txt");
    const miss = await executeTool("grep", { pattern: "zzzzz-non-esiste" }, ctx());
    expect(miss.isError).toBeFalsy();
    expect(miss.content).toContain("nessuna corrispondenza");
  });

  test("glob trova per nome", async () => {
    await executeTool("write_file", { path: "sub/e.test.ts", content: "" }, ctx());
    const r = await executeTool("glob", { pattern: "**/*.test.ts" }, ctx());
    expect(r.content).toContain("e.test.ts");
  });

  test("un tool sconosciuto non esplode: lo dice", async () => {
    const r = await executeTool("teletrasporto", {}, ctx());
    expect(r.isError).toBe(true);
  });
});
