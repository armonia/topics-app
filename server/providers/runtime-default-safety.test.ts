/**
 * La rete sotto al default nuovo.
 *
 * Dal 2026-08-16 chi non sceglie ottiene il runtime `jcode`. È un default che
 * nomina un ESEGUIBILE, e questa è la differenza con ogni altra impostazione
 * della scheda: `cli` non poteva mancare, `jcode` su una macchina che non
 * l'ha installato semplicemente non c'è.
 *
 * La domanda a cui questo file risponde è una sola, ed è quella che decide se
 * il cambio di default si poteva fare: **chi aggiorna Topics senza avere jcode
 * resta senza agenti?** Se la risposta fosse sì, il default andrebbe rimesso
 * com'era — nessun risparmio di memoria vale una board che non dispaccia più.
 *
 * Il ramo è già scritto in `recomputeDefault` (la condizione guarda
 * `connected`, non il nome), ma «è già scritto» non è una prova: qui si mette
 * il registro nello stato di quella macchina — jcode MAI registrato, perché
 * `initProviders` salta gli agenti ACP il cui binario non è nel PATH — e si
 * guarda cosa esce.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  registerProvider,
  removeProvider,
  recomputeDefault,
  getDefaultProviderName,
  listProviders,
} from "./index";
import { resolveAcpAgents } from "./index";
import { getDatabase } from "../db";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV = ["AI_PROVIDER", "ACP_AGENTS", "TOPICS_AGENT_RUNTIME"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV) saved[k] = process.env[k];

/**
 * Un agente ACP che risulta CONNESSO: `command` con "/" salta `Bun.which`, e
 * `AcpProvider.connected` risponde sì quando il binario si risolve. Non spawna
 * niente — il processo ACP nasce al primo turno, e qui si misura solo una
 * decisione del registro.
 */
function acpPresent(name: string) {
  return { type: "acp" as const, name, command: process.execPath, args: ["--version"] };
}

/**
 * Lo stesso agente su una macchina che NON ha quel binario: percorso assoluto
 * che non esiste, `resolveBinary()` torna null, `connected` è false. È lo stato
 * esatto in cui si troverebbe chi dichiara jcode a mano senza averlo installato.
 */
function acpMissing(name: string) {
  return {
    type: "acp" as const,
    name,
    command: "/nonexistent/bin/" + name,
    args: ["acp"],
  };
}

function clearRegistry() {
  for (const { name } of listProviders()) removeProvider(name);
}

describe("il default `jcode` su una macchina che non ha jcode", () => {
  beforeEach(() => {
    for (const k of ENV) delete process.env[k];
    // La riga del DB va azzerata come le variabili, e per lo stesso motivo:
    // `resolveAgentRuntime` legge PRIMA `app_settings.agent_runtime` e solo
    // dopo l'ambiente, quindi un DB che porta gia' una scelta fa misurare a
    // questi casi lo stato del database invece della regola. Verde a casa,
    // rosso sul runner, sullo stesso codice — e' lo stesso difetto del test
    // che misurava il TMPDIR di chi lo lanciava (9ac70958).
    try { getDatabase().prepare("UPDATE app_settings SET agent_runtime = NULL").run(); } catch { /* schema minimo */ }
    clearRegistry();
  });
  afterEach(() => {
    clearRegistry();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // IL TEST CHE AUTORIZZA IL CAMBIO DI DEFAULT. Registro come lo lascia
  // `initProviders` là dove il binario non c'è: claude-code sì, jcode mai
  // entrato. Il default deve cadere sull'ordine dei noti, cioè esattamente
  // dove cadeva prima che il default cambiasse.
  test("jcode non registrato → il default resta `claude-code`, come prima", () => {
    registerProvider({ type: "claude-code" });
    recomputeDefault();
    expect(getDefaultProviderName()).toBe("claude-code");
  });

  // La stessa cosa detta al contrario: il runtime nuovo non deve VINCERE
  // sull'ordine dei noti solo perché è scelto. Vince quando c'è davvero.
  test("jcode registrato ma disconnesso → non prende il posto di chi risponde", () => {
    registerProvider({ type: "claude-code" });
    registerProvider(acpMissing("jcode"));
    recomputeDefault();
    expect(getDefaultProviderName()).toBe("claude-code");
  });

  // E quando c'è, comanda: è il ramo per cui l'interruttore esiste. Senza
  // questo passaggio il default nuovo sarebbe una riga in Impostazioni che non
  // sposta un agente.
  test("jcode registrato e connesso → è lui il default", () => {
    process.env.TOPICS_AGENT_RUNTIME = "jcode";
    registerProvider({ type: "claude-code" });
    registerProvider(acpPresent("jcode"));
    recomputeDefault();
    expect(getDefaultProviderName()).toBe("jcode");
  });

  // Il caso disperato, che non deve peggiorare: nessuno connesso. Il default
  // resta l'unico registrato così `getProvider()` non esplode all'avvio — è il
  // patto che c'era prima e il runtime non lo tocca.
  test("niente di connesso → resta l'unico registrato, non `undefined`", () => {
    registerProvider({ type: "claude", apiKey: "" });
    recomputeDefault();
    expect(getDefaultProviderName()).toBe("claude");
  });

  // `AI_PROVIDER` è la parola dell'utente su CHI risponde, e il runtime dice
  // COME si esegue: due domande diverse. Un default di meccanica non ha titolo
  // per scavalcare una scelta nominale di provider.
  test("una scelta esplicita di provider vince sul runtime", () => {
    registerProvider({ type: "claude-code" });
    registerProvider(acpPresent("jcode"));
    process.env.AI_PROVIDER = "claude-code";
    recomputeDefault();
    expect(getDefaultProviderName()).toBe("claude-code");
  });
});

/**
 * Il runtime di casa nella graduatoria del default.
 *
 * `topics` non è un agente esterno: non ha un binario da trovare nel PATH, e la
 * sua unica condizione è che su questa macchina ci sia una credenziale. Le
 * domande da tenere ferme sono le stesse degli altri, però, perché il default
 * ora è lui: chi non può servire un turno non deve diventare il default, e una
 * scelta esplicita deve continuare a vincere.
 */
describe("il runtime di casa nel registro", () => {
  beforeEach(() => {
    for (const k of ENV) delete process.env[k];
    // La riga del DB va azzerata come le variabili, e per lo stesso motivo:
    // `resolveAgentRuntime` legge PRIMA `app_settings.agent_runtime` e solo
    // dopo l'ambiente, quindi un DB che porta gia' una scelta fa misurare a
    // questi casi lo stato del database invece della regola. Verde a casa,
    // rosso sul runner, sullo stesso codice — e' lo stesso difetto del test
    // che misurava il TMPDIR di chi lo lanciava (9ac70958).
    try { getDatabase().prepare("UPDATE app_settings SET agent_runtime = NULL").run(); } catch { /* schema minimo */ }
    clearRegistry();
  });
  afterEach(() => {
    clearRegistry();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("registrato e connesso, col runtime di default è LUI il default", () => {
    // CONNESSO va COSTRUITO, non sperato. `NativeProvider.connected` e' vero
    // solo se su questa macchina c'e' una credenziale (`~/.claude/.credentials.json`
    // o `~/.jcode/auth.json`), e su un runner di CI non c'e': il provider si
    // registra ma non risulta connesso, `recomputeDefault` cade sull'ordine dei
    // noti e il default esce `claude-code`. Il test era verde a casa e rosso in
    // CI perche' misurava le CREDENZIALI di chi lo eseguiva, non la regola.
    //
    // Una home finta con dentro una credenziale rende il caso quello che dice
    // di essere: «il provider c'e' ED e' connesso, quindi vince lui».
    const home = mkdtempSync(join(tmpdir(), "runtime-default-home-"));
    const homeVero = process.env.HOME;
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-finto",
          refreshToken: "sk-ant-ort01-finto",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    );
    process.env.HOME = home;
    try {
      registerProvider({ type: "claude-code" });
      registerProvider({ type: "native" });
      recomputeDefault();
      // Nessuna variabile: vale `DEFAULT_AGENT_RUNTIME`, che è `topics`.
      expect(getDefaultProviderName()).toBe("topics");
    } finally {
      if (homeVero === undefined) delete process.env.HOME;
      else process.env.HOME = homeVero;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("SENZA credenziale il default resta `claude-code`: e' la rete, non un difetto", () => {
    // L'altra meta' della stessa regola, ed e' quella che rendeva accettabile
    // il cambio di default: chi aggiorna e non ha una credenziale per il
    // runtime di casa NON resta senza agenti, si ritrova quello di prima.
    // Questo caso e' anche la ragione per cui il test qui sopra deve costruirsi
    // la credenziale invece di ereditarla: sono due esiti opposti dello stesso
    // codice, e senza controllare l'ambiente se ne misura uno a caso.
    const home = mkdtempSync(join(tmpdir(), "runtime-default-nohome-"));
    const homeVero = process.env.HOME;
    process.env.HOME = home;
    try {
      registerProvider({ type: "claude-code" });
      registerProvider({ type: "native" });
      recomputeDefault();
      expect(getDefaultProviderName()).toBe("claude-code");
    } finally {
      if (homeVero === undefined) delete process.env.HOME;
      else process.env.HOME = homeVero;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("si registra col nome `topics`, non `native`", () => {
    // Il nome lo legge chi sceglie un provider: `native` non dice niente.
    const p = registerProvider({ type: "native" });
    expect(p.name).toBe("topics");
  });

  // La rete, identica a quella di jcode: chi ha chiesto la CLI non deve
  // ritrovarsi il runtime nuovo come default automatico.
  test("chi ha chiesto `cli` NON finisce sul runtime di casa", () => {
    process.env.TOPICS_AGENT_RUNTIME = "cli";
    registerProvider({ type: "claude-code" });
    registerProvider({ type: "native" });
    recomputeDefault();
    expect(getDefaultProviderName()).toBe("claude-code");
  });

  test("una scelta esplicita di provider vince anche su di lui", () => {
    process.env.AI_PROVIDER = "claude-code";
    registerProvider({ type: "claude-code" });
    registerProvider({ type: "native" });
    recomputeDefault();
    expect(getDefaultProviderName()).toBe("claude-code");
  });
});

describe("il cancello e il PATH sono due filtri diversi", () => {
  beforeEach(() => {
    for (const k of ENV) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // Sfumatura che vale la pena fissare: quando il runtime jcode è CHIESTO, la
  // tabella lo propone a prescindere dal PATH, anche dove il binario non
  // esiste. Non è un bug ed è voluto che stia così — la tabella dice «questo
  // agente esiste e si lancia così», mentre il controllo sul PATH è del
  // registro (`Bun.which` in `initProviders`). Tenere le due cose separate è
  // ciò che permette a `ACP_AGENTS` di puntare a un binario in un posto suo.
  test("chiesto jcode, la tabella lo propone a prescindere dal PATH: a filtrare è il registro", () => {
    process.env.TOPICS_AGENT_RUNTIME = "jcode";
    expect(resolveAcpAgents().map((a) => a.name)).toContain("jcode");
  });

  // Il bug trovato scrivendo il test qui sopra, e vale per ogni agente ACP.
  // `resolveBinary` prendeva per buono qualunque comando con una barra dentro:
  // un `/opt/jcode/bin/jcode` che non esiste si dichiarava `connected`, entrava
  // nella graduatoria del default e la chat moriva su `ACP_BINARY_NOT_FOUND` al
  // primo turno. Col runtime `jcode` di default il caso diventa più facile da
  // incontrare, quindi il posto giusto in cui accorgersene è il boot.
  test("un percorso assoluto che non esiste NON è un provider connesso", () => {
    const p = registerProvider({
      type: "acp",
      name: "fantasma",
      command: "/nonexistent/bin/fantasma",
      args: ["acp"],
    });
    try {
      expect(p.connected).toBe(false);
    } finally {
      removeProvider("fantasma");
    }
  });
});
