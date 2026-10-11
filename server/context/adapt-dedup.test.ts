/**
 * Invio differenziale del preambolo `<context>` (strategia `inline-system`).
 *
 * Il caso che il vecchio codice sbagliava è il secondo turno: la CLI è
 * process-resident, il preambolo del primo turno è ancora nella sua
 * conversazione, e riappenderlo costa in modo COMPOSTO. Qui si fissa che parta
 * solo ciò che è cambiato — e, altrettanto importante, che ciò che è cambiato
 * parta davvero.
 *
 * @covers CTX-DEDUP-01, CTX-DEDUP-03, CTX-GOAL-01, GLOBAL-ORCHESTRATOR-CONTEXT-01
 *
 * CTX-DEDUP-01 is partial: the inline preamble carries only what changed.
 * CTX-DEDUP-03 (a retired slot is declared) and CTX-GOAL-01 (the topic goal
 * reaches the model) are covered.
 */
import { describe, expect, it } from "bun:test";
import type { ContextEnvelope, SystemBlock } from "./envelope";
import { adaptEnvelope, composeSystemMessages, composeSystemSlots } from "./adapt";
import { hashSlot } from "./inline-sent-state";

function block(overrides: Partial<SystemBlock> & { id: string; content: string }): SystemBlock {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    category: overrides.category ?? "synthetic",
    content: overrides.content,
    tokens: Math.ceil(overrides.content.length / 4),
    enabled: overrides.enabled ?? true,
    countInBudget: true,
    editable: false,
    injectedByTopicsApp: overrides.injectedByTopicsApp ?? true,
    adapterHints: overrides.adapterHints,
  };
}

function inlineEnvelope(blocks: SystemBlock[], userContent = "riaccedi"): ContextEnvelope {
  return {
    topicId: "topic-1",
    sessionKey: "topic:abc",
    providerName: "claude-code",
    providerStrategy: "inline-system",
    systemBlocks: blocks,
    history: [],
    userMessage: { content: userContent },
    diagnostics: {
      totalTokens: 0,
      budgetLimit: 200_000,
      budgetPercent: 0,
      droppedHistoryTurns: 0,
      historyEntries: [],
      warnings: [],
      assembledAt: 0,
    },
  };
}

const PROMPT = block({ id: "prompt:system", category: "prompt", content: "sei un assistente" });
const AWARE = block({
  id: "template:project-awareness",
  category: "template",
  content: 'You are working in the project "quadra" at /p.',
});
const README = block({ id: "template:README.md", category: "template", label: "README.md", content: "# Quadra\nHRIS demo." });
const PLAN = block({ id: "synthetic:plan-mode", content: "PLAN MODE attivo." });
const GLOBAL_BOARD = block({
  id: "synthetic:global-board-snapshot",
  label: "Global board snapshot",
  content: "Live task totals: todo=2, review=1. Priority snapshot: t-1 Ship login (todo). 4 omitted.",
});

/** Lo stato che il chiamante avrebbe registrato dopo un turno. */
function sentFrom(blocks: SystemBlock[]): Map<string, string> {
  return new Map(composeSystemSlots(blocks).map((s) => [s.slot, hashSlot(s.content)]));
}

describe("composeSystemSlots", () => {
  it("produce gli stessi contenuti, nello stesso ordine, di composeSystemMessages", () => {
    const blocks = [PROMPT, AWARE, README, PLAN];
    expect(composeSystemSlots(blocks).map((s) => s.content)).toEqual(
      composeSystemMessages(blocks).map((m) => m.content),
    );
  });

  it("aggrega project-awareness e i template in UN solo slot", () => {
    const slots = composeSystemSlots([AWARE, README]);
    expect(slots.map((s) => s.slot)).toEqual(["template"]);
    expect(slots[0]!.content).toContain("# Quadra");
  });
});

describe("primo turno", () => {
  it("porta il contesto completo, byte-identico al comportamento senza dedup", () => {
    const env = inlineEnvelope([PROMPT, AWARE, README]);
    const withoutDedup = adaptEnvelope(env);
    const withEmptyMap = adaptEnvelope(env, { alreadySent: new Map() });
    expect(withEmptyMap.userContent).toBe(withoutDedup.userContent);
    expect(withEmptyMap.userContent).toContain("<context>");
    expect(withEmptyMap.userContent).toContain("# Quadra");
  });

  it("riporta gli slot risultanti, che il chiamante userà come stato", () => {
    const payload = adaptEnvelope(inlineEnvelope([PROMPT, AWARE, README]), { alreadySent: new Map() });
    expect(payload.inlineSlots?.map((s) => s.slot)).toEqual(["prompt", "template"]);
  });
});

describe("turno successivo, nulla cambiato", () => {
  it("manda il messaggio utente NUDO, senza un <context> vuoto", () => {
    const blocks = [PROMPT, AWARE, README];
    const payload = adaptEnvelope(inlineEnvelope(blocks, "riaccedi"), { alreadySent: sentFrom(blocks) });
    expect(payload.userContent).toBe("riaccedi");
    expect(payload.userContent).not.toContain("<context>");
  });

  it("dichiara nelle note quanti slot ha saltato e quanto ha risparmiato", () => {
    const blocks = [PROMPT, AWARE, README];
    const payload = adaptEnvelope(inlineEnvelope(blocks), { alreadySent: sentFrom(blocks) });
    const nota = payload.adaptationNotes.find((n) => n.includes("already in the CLI session"));
    expect(nota).toBeDefined();
    expect(nota).toContain("tokens saved");
    expect(nota).toContain("project files");
  });

  it("gli slot risultanti restano quelli in sessione, non solo gli emessi", () => {
    const blocks = [PROMPT, AWARE, README];
    const payload = adaptEnvelope(inlineEnvelope(blocks), { alreadySent: sentFrom(blocks) });
    expect(payload.inlineSlots?.map((s) => s.slot)).toEqual(["prompt", "template"]);
  });
});

describe("qualcosa è cambiato", () => {
  it("uno slot modificato riparte INTERO, gli altri restano fuori", () => {
    const prima = [PROMPT, AWARE, README];
    const sent = sentFrom(prima);
    const readmeNuovo = block({ ...README, content: "# Quadra\nHRIS demo. Ora con i turni." });

    const payload = adaptEnvelope(inlineEnvelope([PROMPT, AWARE, readmeNuovo]), { alreadySent: sent });
    expect(payload.userContent).toContain("Ora con i turni");
    // Lo slot template riparte con dentro ANCHE l'awareness, non il solo file cambiato.
    expect(payload.userContent).toContain('You are working in the project "quadra"');
    // Il prompt non è cambiato: non si ripete.
    expect(payload.userContent).not.toContain("sei un assistente");
  });

  it("uno slot nuovo parte anche se gli altri sono già in sessione", () => {
    const sent = sentFrom([PROMPT, AWARE, README]);
    const payload = adaptEnvelope(inlineEnvelope([PROMPT, AWARE, README, PLAN]), { alreadySent: sent });
    expect(payload.userContent).toContain("PLAN MODE attivo.");
    expect(payload.userContent).not.toContain("# Quadra");
  });
});

describe("plan-mode è uno stato, non un documento", () => {
  it("non viene mai saltato, anche se già inviato identico", () => {
    const blocks = [PROMPT, AWARE, README, PLAN];
    const payload = adaptEnvelope(inlineEnvelope(blocks), { alreadySent: sentFrom(blocks) });
    expect(payload.userContent).toContain("PLAN MODE attivo.");
    expect(payload.userContent).not.toContain("# Quadra");
  });
});

describe("global board snapshot is volatile state", () => {
  it("is composed into its own slot and re-emitted even when the CLI already has that exact snapshot", () => {
    const blocks = [AWARE, GLOBAL_BOARD];
    const payload = adaptEnvelope(inlineEnvelope(blocks), { alreadySent: sentFrom(blocks) });

    // This is a live board read, not a document the CLI may safely keep from a
    // previous turn. A same-hash snapshot must therefore still travel on every
    // inline-system turn.
    expect(payload.userContent).toContain("Live task totals: todo=2, review=1");
    expect(payload.inlineSlots?.map((s) => s.slot)).toEqual(["template", "global-board"]);
  });
});

describe("ritiro degli slot spariti", () => {
  it("dichiara il plan mode non più in vigore quando viene spento", () => {
    const sent = sentFrom([PROMPT, AWARE, README, PLAN]);
    const payload = adaptEnvelope(inlineEnvelope([PROMPT, AWARE, README]), { alreadySent: sent });
    expect(payload.userContent).toContain("Context no longer in effect: plan mode.");
  });

  it("il ritiro esce UNA volta sola: al turno dopo lo slot non è più in sessione", () => {
    const sent = sentFrom([PROMPT, AWARE, README, PLAN]);
    const blocks = [PROMPT, AWARE, README];
    const primo = adaptEnvelope(inlineEnvelope(blocks), { alreadySent: sent });

    // Il chiamante registra `inlineSlots` come nuovo stato — plan-mode ne è uscito.
    const newState = new Map(primo.inlineSlots!.map((s) => [s.slot, s.hash]));
    const secondo = adaptEnvelope(inlineEnvelope(blocks), { alreadySent: newState });
    expect(secondo.userContent).not.toContain("no longer in effect");
    expect(secondo.userContent).toBe("riaccedi");
  });

  it("elenca più ritiri in una riga sola", () => {
    const sent = sentFrom([PROMPT, AWARE, README, PLAN]);
    const payload = adaptEnvelope(inlineEnvelope([AWARE, README]), { alreadySent: sent });
    expect(payload.userContent).toContain("Context no longer in effect: system prompt, plan mode.");
  });
});

describe("il blocco goal arriva al modello", () => {
  const GOAL = block({ id: "synthetic:goal", label: "Obiettivo", content: "OBIETTIVO: spedire la release." });

  it("viene composto invece di essere scartato in silenzio", () => {
    // Regressione: `assemble.ts` lo produceva con injectedByTopicsApp: true e lo
    // contava nel budget, ma nessuno slot lo raccoglieva — il modello non ha mai
    // visto un obiettivo di topic.
    expect(composeSystemMessages([GOAL]).map((m) => m.content)).toEqual([GOAL.content]);
  });

  it("finisce nel preambolo inline", () => {
    const payload = adaptEnvelope(inlineEnvelope([AWARE, GOAL]), { alreadySent: new Map() });
    expect(payload.userContent).toContain("OBIETTIVO: spedire la release.");
  });

  it("un obiettivo completato viene dichiarato ritirato", () => {
    const sent = sentFrom([AWARE, GOAL]);
    const payload = adaptEnvelope(inlineEnvelope([AWARE]), { alreadySent: sent });
    expect(payload.userContent).toContain("Context no longer in effect: goal.");
  });

  it("un obiettivo che cambia riparte", () => {
    const sent = sentFrom([AWARE, GOAL]);
    const nuovo = block({ ...GOAL, content: "OBIETTIVO: spedire la 2.3." });
    const payload = adaptEnvelope(inlineEnvelope([AWARE, nuovo]), { alreadySent: sent });
    expect(payload.userContent).toContain("spedire la 2.3");
  });
});

describe("comandi built-in della CLI", () => {
  // `/compact` lo parsa la CLI guardando l'inizio del messaggio: qualunque cosa
  // davanti glielo nasconde e il comando finisce al modello ("`/compact` non
  // esiste"), pagando un turno mentre il contesto continua a crescere. Il bottone
  // compatta nasce quando la finestra si riempie: e' lì che sbagliarlo costa di più.
  it("un messaggio che inizia con / viaggia NUDO, anche col contesto da mandare", () => {
    const payload = adaptEnvelope(inlineEnvelope([PROMPT, AWARE, README], "/compact"), { alreadySent: new Map() });
    expect(payload.userContent).toBe("/compact");
    expect(payload.userContent).not.toContain("<context>");
  });

  it("nemmeno plan-mode, che non si deduplica mai, si mette davanti a un comando", () => {
    const payload = adaptEnvelope(inlineEnvelope([PROMPT, AWARE, PLAN], "/compact"), { alreadySent: new Map() });
    expect(payload.userContent).toBe("/compact");
  });

  it("gli slot NON vengono marcati: quel che è cambiato parte al turno dopo", () => {
    const payload = adaptEnvelope(inlineEnvelope([PROMPT, AWARE, README], "/compact"), { alreadySent: new Map() });
    expect(payload.inlineSlots).toBeUndefined();
  });

  it("tollera lo spazio iniziale, e non scatta su uno slash a metà frase", () => {
    expect(adaptEnvelope(inlineEnvelope([AWARE], "  /compact"), { alreadySent: new Map() }).userContent).toBe("  /compact");
    const normale = adaptEnvelope(inlineEnvelope([AWARE], "guarda in src/lib"), { alreadySent: new Map() });
    expect(normale.userContent).toContain("<context>");
  });

  it("un PATH incollato non è un comando: il contesto ci vuole", () => {
    // `startsWith("/")` da solo prendeva anche questi, e a un messaggio che parla
    // di un file toglieva tutto il preambolo — su un primo turno, un turno intero
    // senza sapere in che progetto si sta.
    for (const testo of [
      "/Users/utente/Projects/topics-app/server/context/adapt.ts va rivisto",
      "/tmp da controllare",
      "/etc/hosts",
      "/ ",
      "/",
    ]) {
      const p = adaptEnvelope(inlineEnvelope([PROMPT, AWARE], testo), { alreadySent: new Map() });
      expect(p.userContent).toContain("<context>");
    }
  });

  it("i comandi con argomenti restano nudi", () => {
    const p = adaptEnvelope(inlineEnvelope([PROMPT, AWARE], "/model claude-opus-5"), { alreadySent: new Map() });
    expect(p.userContent).toBe("/model claude-opus-5");
  });

  it("uno slash che non è un built-in noto porta il contesto", () => {
    // Meglio un preambolo di troppo che un turno senza sapere dove si è.
    const p = adaptEnvelope(inlineEnvelope([PROMPT, AWARE], "/inventato-di-sana-pianta"), { alreadySent: new Map() });
    expect(p.userContent).toContain("<context>");
  });

  it("names Claude Code no longer has travel with their context", () => {
    // Measured on 2.1.288: each of these, sent naked, became a paid model turn
    // with no context at all ($0.058 to $0.140). `compress` is Gemini's name.
    for (const name of ["todos", "todo", "install", "migrate-installer", "pr-comments", "compress"]) {
      const p = adaptEnvelope(inlineEnvelope([PROMPT, AWARE], `/${name}`), { alreadySent: new Map() });
      expect(p.userContent, `/${name}`).toContain("<context>");
    }
  });

  it("the native engine has no slash parser: a built-in name is not sent naked there", () => {
    // `/compact` on `topics` reached the model bare, a paid turn that did not
    // even know which project it was in.
    const native = { ...inlineEnvelope([PROMPT, AWARE], "/compact"), providerName: "topics" };
    const p = adaptEnvelope(native, { alreadySent: new Map() });
    expect(p.userContent).toContain("<context>");
    // Claude Code and the ACP agents still get it naked.
    for (const providerName of ["claude-code", "gemini", "jcode"]) {
      const cli = { ...inlineEnvelope([PROMPT, AWARE], "/compact"), providerName };
      expect(adaptEnvelope(cli, { alreadySent: new Map() }).userContent, providerName).toBe("/compact");
    }
  });
});

describe("skill invocations travel bare, the context beside them", () => {
  // `<context>…/recap` is prose to the CLI and the skill never expands; context
  // AFTER the command becomes the skill's `$ARGUMENTS`. The context goes in its
  // own content block instead (`payload.slashContext`).
  const SKILLS = new Set(["vai", "recap", "opsx:propose"]);
  const isSlashCommand = (name: string) => SKILLS.has(name);

  it("first turn: a skill invocation stays bare and the whole preamble moves to slashContext", () => {
    const p = adaptEnvelope(inlineEnvelope([PROMPT, AWARE, README], "/vai solo il bug X"), { alreadySent: new Map(), isSlashCommand });
    expect(p.userContent).toBe("/vai solo il bug X");
    expect(p.slashContext).toStartWith("<context>\n");
    expect(p.slashContext).toEndWith("\n</context>");
    expect(p.slashContext).toContain("sei un assistente");
    expect(p.slashContext).toContain("# Quadra");
    // The context did reach the session: the slots are marked as for any message.
    expect(p.inlineSlots?.map((s) => s.slot)).toEqual(["prompt", "template"]);
  });

  it("plan mode, restated on every turn, also goes beside the command", () => {
    const sent = sentFrom([PROMPT, AWARE, PLAN]);
    const p = adaptEnvelope(inlineEnvelope([PROMPT, AWARE, PLAN], "/recap"), { alreadySent: sent, isSlashCommand });
    expect(p.userContent).toBe("/recap");
    expect(p.slashContext).toContain("PLAN MODE attivo.");
    expect(p.slashContext).not.toContain("sei un assistente");
  });

  it("nothing to say: bare message, no slashContext at all", () => {
    const p = adaptEnvelope(inlineEnvelope([PROMPT, AWARE], "/vai"), { alreadySent: sentFrom([PROMPT, AWARE]), isSlashCommand });
    expect(p.userContent).toBe("/vai");
    expect(p.slashContext).toBeUndefined();
  });

  it("a namespaced skill name is an invocation too", () => {
    const p = adaptEnvelope(inlineEnvelope([AWARE], "/opsx:propose aggiungi X"), { alreadySent: new Map(), isSlashCommand });
    expect(p.userContent).toBe("/opsx:propose aggiungi X");
    expect(p.slashContext).toContain("quadra");
  });

  it("a normal message is unchanged: context in front, no slashContext", () => {
    const withPredicate = adaptEnvelope(inlineEnvelope([PROMPT, AWARE], "vai avanti"), { alreadySent: new Map(), isSlashCommand });
    const without = adaptEnvelope(inlineEnvelope([PROMPT, AWARE], "vai avanti"), { alreadySent: new Map() });
    expect(withPredicate).toEqual(without);
    expect(withPredicate.userContent).toStartWith("<context>\n");
    expect(withPredicate.userContent).toEndWith("</context>\n\nvai avanti");
    expect(withPredicate.slashContext).toBeUndefined();
  });

  it("a pasted path starting with / is unchanged, even when its first segment is well formed", () => {
    // A pasted `/tmp …` path has a first token the CLI would parse as a command:
    // only the predicate (a name that exists) tells the two apart.
    for (const testo of ["/tmp da controllare", "/Users/utente/Projects/topics-app va rivisto", "/etc/hosts"]) {
      const p = adaptEnvelope(inlineEnvelope([PROMPT, AWARE], testo), { alreadySent: new Map(), isSlashCommand });
      expect(p.userContent).toStartWith("<context>\n");
      expect(p.userContent).toEndWith(testo);
      expect(p.slashContext).toBeUndefined();
    }
  });

  it("a slash with leading blanks is prose to the CLI, so it keeps the prefix", () => {
    const p = adaptEnvelope(inlineEnvelope([AWARE], "  /vai"), { alreadySent: new Map(), isSlashCommand });
    expect(p.userContent).toStartWith("<context>\n");
    expect(p.slashContext).toBeUndefined();
  });

  it("built-ins keep their own rule: bare, no context anywhere", () => {
    const p = adaptEnvelope(inlineEnvelope([PROMPT, AWARE], "/compact"), { alreadySent: new Map(), isSlashCommand: () => true });
    expect(p.userContent).toBe("/compact");
    expect(p.slashContext).toBeUndefined();
    expect(p.inlineSlots).toBeUndefined();
  });

  it("the native runtime gets the same channel", () => {
    const env = { ...inlineEnvelope([PROMPT, AWARE], "/vai"), providerName: "topics" };
    const p = adaptEnvelope(env, { alreadySent: new Map(), isSlashCommand });
    expect(p.userContent).toBe("/vai");
    expect(p.slashContext).toContain("sei un assistente");
  });

  it("an inline provider without the channel (ACP) keeps the old prefix", () => {
    const env = { ...inlineEnvelope([PROMPT, AWARE], "/vai"), providerName: "jcode" };
    const p = adaptEnvelope(env, { alreadySent: new Map(), isSlashCommand });
    expect(p.userContent).toStartWith("<context>\n");
    expect(p.userContent).toEndWith("\n\n/vai");
    expect(p.slashContext).toBeUndefined();
  });
});

describe("le altre strategie non deduplicano", () => {
  it("history-aware antepone i system message come sempre e non riporta slot", () => {
    const env = { ...inlineEnvelope([PROMPT, AWARE, README]), providerStrategy: "history-aware" as const };
    const payload = adaptEnvelope(env, { alreadySent: sentFrom([PROMPT, AWARE, README]) });
    expect(payload.history?.filter((m) => m.role === "system")).toHaveLength(2);
    expect(payload.userContent).toBe("riaccedi");
    expect(payload.inlineSlots).toBeUndefined();
  });

  it("gateway-stateful idem", () => {
    const env = { ...inlineEnvelope([PROMPT, AWARE, README]), providerStrategy: "gateway-stateful" as const };
    const payload = adaptEnvelope(env, { alreadySent: sentFrom([PROMPT, AWARE, README]) });
    expect(payload.history?.filter((m) => m.role === "system")).toHaveLength(2);
    expect(payload.inlineSlots).toBeUndefined();
  });
});

describe("Claude Code's memory index (user:MEMORY.md)", () => {
  const INDEX = block({
    id: "user:MEMORY.md",
    label: "~/.claude/projects/-Users-x/memory/MEMORY.md",
    category: "memory",
    content: "- [Mai avviare Docker](feedback_docker.md)",
  });

  it("reaches the native runtime, naming the folder its cards live in", () => {
    const out = adaptEnvelope({ ...inlineEnvelope([PROMPT, INDEX]), providerName: "topics" });
    expect(out.userContent).toContain("from ~/.claude/projects/-Users-x/memory/MEMORY.md");
    expect(out.userContent).toContain("Mai avviare Docker");
  });

  it("is never sent to `claude`, which injects the same index by itself", () => {
    const out = adaptEnvelope(inlineEnvelope([PROMPT, INDEX]));
    expect(out.userContent).not.toContain("Mai avviare Docker");
  });
});
