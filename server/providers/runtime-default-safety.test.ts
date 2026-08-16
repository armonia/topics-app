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

  // Sfumatura che vale la pena fissare: col default nuovo `resolveAcpAgents`
  // propone jcode SEMPRE, anche dove il binario non esiste. Non è un bug ed è
  // voluto che stia così — la tabella dice «questo agente esiste e si lancia
  // così», mentre il controllo sul PATH è del registro (`Bun.which` in
  // `initProviders`). Tenere le due cose separate è ciò che permette a
  // `ACP_AGENTS` di puntare a un binario in un posto suo.
  test("la tabella propone jcode a prescindere dal PATH: a filtrare è il registro", () => {
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
