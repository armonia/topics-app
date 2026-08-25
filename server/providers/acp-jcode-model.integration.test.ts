/**
 * Il modello per task contro il jcode VERO, non il finto agente.
 *
 * Perché serve oltre a `acp-provider.test.ts`. Lì l'agente è una fixture nostra:
 * prova che il provider CHIEDE il modello nel modo giusto, non che l'agente
 * dall'altra parte capisca la domanda. Sono due affermazioni diverse, e la
 * seconda è quella che decide se dispacciare una board su jcode mantiene il
 * controllo del costo: `session/set_model` non è in ACP v1: è un'estensione di
 * jcode, e il giorno che la rinomina questo test è l'unico posto che se ne
 * accorge prima della bolletta.
 *
 * Si salta da solo dove `jcode` non è installato: è un test di integrazione con
 * un binario esterno, e farlo fallire su una macchina che non l'ha sarebbe
 * rumore, non un guasto.
 *
 * ── E SI CHIEDE ESPLICITAMENTE (TOPICS_REAL_AGENT_TESTS=1) ──────────────────
 * Ogni caso qui dentro spende un TURNO VERO: jcode parla con un modello vero,
 * quindi rete, quota e credenziali entrano nel verdetto. Fuori posto in
 * `test:unit`, che su questa macchina è la barra di review di OGNI card della
 * board: le card girano in parallelo, ognuna spawnava il suo jcode, e il primo
 * che inciampava marchiava `checks: fail` su lavoro sano.
 *
 * Misurato il 18/08/2026: «jcode annuncia i suoi modelli» e «un modello
 * inesistente non fa fallire il turno» rossi in CINQUE worktree diverse, ognuno
 * verde rilanciato da solo — cinque card in colonna review con un rosso che non
 * era il loro. Il costo non era il test: era il tempo speso a rileggere cinque
 * volte lo stesso guasto altrui.
 *
 * Su CI non cambia niente (là `jcode` non esiste e il blocco già si saltava).
 * Su questa macchina si lancia quando si tocca `acp.ts` o il modello per task:
 *
 *     bun run test:agents
 * @covers KANBAN-07
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase } from "../db";
import { AcpProvider } from "./acp";
import type { ProviderDoneMessage, StreamHandler } from "./types";

const JCODE = Bun.which("jcode");
/** Opt-in esplicito: vedi l'intestazione — un turno vero non sta in una barra di review. */
const CHIESTI = process.env.TOPICS_REAL_AGENT_TESTS === "1";
const describeIfJcode = JCODE && CHIESTI ? describe : describe.skip;

let tmpRoot: string;
const live: AcpProvider[] = [];

function makeJcode(): AcpProvider {
  const p = new AcpProvider({
    type: "acp",
    name: "jcode",
    command: JCODE!,
    args: ["acp"],
    defaultWorkspace: tmpRoot,
  });
  live.push(p);
  p.start();
  return p;
}

function recorder() {
  const text: string[] = [];
  const done: ProviderDoneMessage[] = [];
  const errors: string[] = [];
  const handler: StreamHandler = {
    onTextDelta: (chunk) => text.push(chunk),
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: (m) => done.push(m ?? {}),
    onError: (e) => errors.push(e),
  };
  return { handler, done, errors, get full() { return text.join(""); } };
}

describeIfJcode("jcode vero: il modello per task", () => {
  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "acp-jcode-"));
    initDatabase(tmpRoot);
  });
  afterAll(() => {
    for (const p of live) { try { p.stop(); } catch { /* già morto */ } }
    try { closeDatabase(); } catch { /* già chiusa */ }
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* scratch */ }
  });

  /**
   * I modelli che jcode annuncia. È anche la prova che `listModels` non è più
   * la lista vuota di prima: la board non poteva scegliere ciò che il selettore
   * non mostrava.
   */
  test("jcode annuncia i suoi modelli, e li riportiamo", async () => {
    const provider = makeJcode();
    const rec = recorder();
    // Un turno vero apre la sessione, ed è lì che arrivano i `configOptions`.
    await provider.sendChat("topic:jm-list", "Rispondi solo: OK", rec.handler);
    expect(rec.errors).toEqual([]);
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(1);
    // Non si fissa un nome preciso — il catalogo cambia sotto di noi, e un test
    // che si rompe quando esce un modello nuovo è un test che verrà cancellato.
    expect(models.some((m) => m.includes("claude") || m.includes("gpt"))).toBe(true);
  }, 120_000);

  /**
   * IL TEST CHE CONTA. Si chiede un modello piccolo e si verifica che jcode ci
   * sia andato davvero, chiedendolo A LUI: il provider potrebbe credere di aver
   * cambiato modello e sbagliarsi, ed è esattamente il modo in cui questo bug
   * era invisibile prima.
   */
  test("il modello richiesto viene applicato davvero, e jcode lo conferma", async () => {
    const provider = makeJcode();
    const warm = recorder();
    await provider.sendChat("topic:jm-set", "Rispondi solo: OK", warm.handler);
    const models = await provider.listModels();
    // Da dove è partito, detto da lui: senza questo il test non saprebbe se il
    // modello finale è merito della richiesta o era già quello.
    const before = provider.defaultModel();
    expect(before).toBeTruthy();

    // Un modello piccolo, scelto fra quelli che jcode dichiara: fissarne uno a
    // mano renderebbe il test una scommessa sul catalogo.
    const small = models.find((m) => /haiku|mini|flash|small/i.test(m) && m !== before);
    if (!small) {
      // Nessun modello "piccolo" riconoscibile: meglio non provare niente che
      // provare una cosa diversa da quella che il test dice di provare.
      return;
    }

    const rec = recorder();
    await provider.sendChat("topic:jm-set", "Rispondi solo: OK", rec.handler, { model: small });
    expect(rec.errors).toEqual([]);
    expect(rec.done).toHaveLength(1);

    // LA CONFERMA. `defaultModel()` non riporta ciò che abbiamo chiesto: riporta
    // il `currentValue` che jcode ha rimandato nei suoi `configOptions`. Se
    // `session/set_model` sparisse o cambiasse nome, qui resterebbe `before` e
    // il test fallirebbe — che è tutto il motivo per cui esiste.
    expect(provider.defaultModel()).toBe(small);
    expect(provider.defaultModel()).not.toBe(before);
  }, 180_000);

  /**
   * Il patto del degrado, sul binario vero: un modello che non esiste non deve
   * uccidere il turno. Su una board significa che un `task.model` scritto male
   * costa un turno sul modello sbagliato, non una card ferma.
   */
  test("un modello inesistente non fa fallire il turno", async () => {
    const provider = makeJcode();
    const rec = recorder();
    await provider.sendChat("topic:jm-bad", "Rispondi solo: OK", rec.handler, {
      model: "modello-che-non-esiste-42",
    });
    expect(rec.errors).toEqual([]);
    expect(rec.done).toHaveLength(1);
  }, 120_000);
});
