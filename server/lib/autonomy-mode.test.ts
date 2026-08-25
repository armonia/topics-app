/**
 * Due modi di sbagliare, e i test guardano quelli: dare più potere di quanto
 * l'utente ha chiesto (una chat «chiedi prima» che scrive sul disco), e
 * bloccare una chat che prima funzionava (un valore sconosciuto che diventa una
 * modalità che in `--print` resta appesa).
 *
 * `planModeFor` is the server-side lever: plan mode comes from the autonomy
 * level, never from a per-turn client flag.
 *
 * @covers FAST-MODE-03
 */
import { describe, test, expect } from "bun:test";
import {
  permissionModeForAutonomy,
  DEFAULT_PERMISSION_MODE,
  planModeFor,
  permissionModeAsks,
  PERMISSION_PROMPT_TOOL,
} from "./autonomy-mode";
import { buildClaudeArgs } from "../providers/claude/args";

/**
 * Il resto dell'argv non c'entra con questo cancello: qui interessa una flag
 * sola, e la base serve solo perché `buildClaudeArgs` è totale sui suoi input.
 */
const SPAWN_BASE = {
  permissionMode: "acceptEdits",
  model: "claude-opus-5",
  mcpConfigPath: "/tmp/mcp.json",
  mcpStrict: true,
  permissionPromptTool: PERMISSION_PROMPT_TOOL,
  appendSystemPrompt: "sys",
  claudeSessionId: "00000000-0000-4000-8000-000000000000",
  isNewSession: true,
};

/**
 * Le sei modalità che la CLI accetta (`--permission-mode <mode>` in `--help`,
 * 2.1.224). Scritte qui perché il cancello sotto valga su TUTTE, non solo su
 * quelle che oggi la mappatura usa: il difetto da fermare è una modalità nuova
 * che entra e resta fuori dal canale.
 */
const CLI_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"] as const;

describe("permissionModeForAutonomy", () => {
  test("i tre livelli mappano sulle modalità provate sul campo", () => {
    expect(permissionModeForAutonomy("ask")).toBe("plan");
    expect(permissionModeForAutonomy("auto-apply")).toBe("acceptEdits");
    expect(permissionModeForAutonomy("yolo")).toBe("bypassPermissions");
  });

  test("«chiedi prima» NON deve mai finire su una modalità che agisce", () => {
    // È l'errore che conta: un utente che sceglie «chiedi» e si ritrova file
    // modificati non ha ricevuto una funzione, ha ricevuto una bugia.
    expect(permissionModeForAutonomy("ask")).not.toBe("bypassPermissions");
    expect(permissionModeForAutonomy("ask")).not.toBe("acceptEdits");
  });

  test("nessun livello scelto: il comportamento di PRIMA, non uno nuovo", () => {
    // Cambiare il default avrebbe zittito le chat di chi non ha mai toccato
    // l'impostazione — una migrazione silenziosa travestita da funzione.
    expect(permissionModeForAutonomy(null)).toBe(DEFAULT_PERMISSION_MODE);
    expect(permissionModeForAutonomy(undefined)).toBe(DEFAULT_PERMISSION_MODE);
    expect(permissionModeForAutonomy("")).toBe(DEFAULT_PERMISSION_MODE);
  });

  test("un livello sconosciuto non blocca la chat", () => {
    // Un valore scritto male (o di una versione futura) deve degradare al
    // default, non su una modalità che in --print potrebbe restare appesa.
    expect(permissionModeForAutonomy("ASK")).toBe(DEFAULT_PERMISSION_MODE);
    expect(permissionModeForAutonomy("prudente")).toBe(DEFAULT_PERMISSION_MODE);
  });
});


describe("planModeFor — il piano ha una leva sola", () => {
  test("l'autonomia «ask» accende il piano da sé", () => {
    // È la sostituzione della leva sparita: il blocco di prompt che dava al
    // piano il suo formato adesso lo accende il livello, non un interruttore
    // separato in localStorage che poteva dire il contrario dei permessi.
    expect(planModeFor({ autonomy: "ask" })).toBe(true);
    expect(planModeFor({ turnFlag: false, autonomy: "ask" })).toBe(true);
  });

  test("gli altri livelli non lo accendono", () => {
    expect(planModeFor({ autonomy: "auto-apply" })).toBe(false);
    expect(planModeFor({ autonomy: "yolo" })).toBe(false);
    expect(planModeFor({ autonomy: null })).toBe(false);
    expect(planModeFor({ autonomy: undefined })).toBe(false);
    // Un livello scritto male non deve poter mettere una chat in piano di
    // straforo: è lo stesso ripiego silenzioso che la PATCH ora rifiuta con 400.
    expect(planModeFor({ autonomy: "ASK" })).toBe(false);
    expect(planModeFor({ autonomy: "propone" })).toBe(false);
  });

  test("il flag per-turno resta, per chi non ha un composer", () => {
    // Dispatcher e bridge MCP non hanno un bottone da premere: il flag sul
    // corpo della richiesta è la loro strada, e vale da solo.
    expect(planModeFor({ turnFlag: true })).toBe(true);
    expect(planModeFor({ turnFlag: true, autonomy: "yolo" })).toBe(true);
    expect(planModeFor({})).toBe(false);
  });
});

/**
 * L'INVARIANTE di questo lavoro.
 *
 * Il guasto del 7 agosto: `auto-apply` → `acceptEdits`, che in headless CHIEDE
 * il permesso per ogni tool MCP e per ogni scrittura fuori dalla cwd. Nessuno
 * poteva rispondere, quindi ogni richiesta diventava un no muto — e 515 topic
 * su 518 stavano lì. Non era una regressione della CLI (identico su 2.1.221):
 * era una mappatura provata con l'unico strumento che non poteva fallire.
 *
 * Da qui in poi vale una regola sola: se una modalità può chiedere, lo spawn
 * DEVE portare il canale.
 */
describe("nessuna modalità che chiede può partire senza il canale", () => {
  test("chiedono tutte tranne bypassPermissions", () => {
    for (const mode of CLI_MODES) {
      expect(permissionModeAsks(mode)).toBe(mode !== "bypassPermissions");
    }
  });

  test("OGNI modalità riceve --permission-prompt-tool, anche quella che non chiede", () => {
    // Condizionarlo voleva dire tenerlo accoppiato al flag gemello del bridge,
    // e due flag che devono restare d'accordo prima o poi non lo sono: senza il
    // secondo la CLI risponde «MCP tool … not found» su OGNI richiesta. Passarlo
    // sempre costa zero (in `bypassPermissions` non lo chiama nessuno) e non
    // può desincronizzarsi da sé stesso.
    //
    // L'asserzione guarda `buildClaudeArgs`, cioè l'argv VERO dello spawn: una
    // funzione `permissionPromptArgs()` a parte proverebbe solo sé stessa —
    // resterebbe verde anche il giorno che lo spawn smette di chiamarla.
    for (const mode of CLI_MODES) {
      const args = buildClaudeArgs({ ...SPAWN_BASE, permissionMode: mode });
      const i = args.indexOf("--permission-prompt-tool");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(args[i + 1]).toBe(PERMISSION_PROMPT_TOOL);
    }
  });

  test("e vale attraverso la mappatura, che è la strada vera", () => {
    for (const level of ["ask", "auto-apply", "yolo", "livello-inventato", null, undefined]) {
      const mode = permissionModeForAutonomy(level as string | null | undefined);
      const args = buildClaudeArgs({ ...SPAWN_BASE, permissionMode: mode });
      expect(args).toContain("--permission-prompt-tool");
      expect(args).toContain(PERMISSION_PROMPT_TOOL);
    }
  });

  test("il canale è il bridge che Topics attacca già a ogni sessione", () => {
    // Se questo nome cambiasse senza cambiare il tool nel bridge, la CLI
    // chiederebbe a uno strumento che non esiste — e negherebbe tutto, in
    // silenzio, esattamente come prima.
    expect(PERMISSION_PROMPT_TOOL).toBe("mcp__topics__approval_prompt");
  });

  test("`permissionModeAsks` resta la verità sulla tabella, anche se non decide più l'argv", () => {
    // Non guida più il flag (che si passa sempre), ma è il posto dove è scritto
    // QUALI modalità si fermano a chiedere — cioè quali senza canale morivano
    // mute. Serve a chi legge la mappatura, e ai test qui sopra.
    expect(permissionModeAsks(null)).toBe(false);
    expect(permissionModeAsks(undefined)).toBe(false);
    expect(permissionModeAsks("")).toBe(false);
    expect(permissionModeAsks("acceptEdits")).toBe(true);
  });
});
