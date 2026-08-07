import { describe, expect, it } from "bun:test";
import {
  PERMISSION_ALLOW_ALWAYS_LABEL,
  PERMISSION_ALLOW_ONCE_LABEL,
  PERMISSION_DENY_LABEL,
  PERMISSION_QUESTION_PREFIX,
  isPermissionSchema,
  permissionDecisionFrom,
  permissionQuestion,
  permissionSchemaFor,
  summarizeToolInput,
} from "./permission-decision";

const TOOL = "mcp__gateway__kiwi__search-flight";

describe("permissionSchemaFor", () => {
  it("è un pannello di domande — così eredita form, ambra della tab e composer", () => {
    const schema = permissionSchemaFor({ toolName: TOOL });
    expect(schema.kind).toBe("questions");
    if (schema.kind !== "questions") throw new Error("unreachable");
    expect(schema.questions).toHaveLength(1);
    expect(schema.questions[0].options.map((o) => o.label)).toEqual([
      PERMISSION_ALLOW_ONCE_LABEL,
      PERMISSION_ALLOW_ALWAYS_LABEL,
      PERMISSION_DENY_LABEL,
    ]);
  });

  it("non consiglia niente: è l'unica domanda in cui il consiglio deciderebbe al posto tuo", () => {
    const schema = permissionSchemaFor({ toolName: TOOL });
    if (schema.kind !== "questions") throw new Error("unreachable");
    expect(schema.questions[0].options.some((o) => o.recommended)).toBe(false);
  });

  it("nomina lo strumento nella domanda, che è anche la chiave della risposta", () => {
    const schema = permissionSchemaFor({ toolName: TOOL });
    if (schema.kind !== "questions") throw new Error("unreachable");
    expect(schema.questions[0].question).toContain(TOOL);
    expect(schema.questions[0].question.startsWith(PERMISSION_QUESTION_PREFIX)).toBe(true);
  });
});

describe("summarizeToolInput — un permesso senza il COSA è solo un pulsante", () => {
  it("mette per primo il campo che dice cosa succede", () => {
    const s = summarizeToolInput({ content: "x".repeat(100), file_path: "/tmp/a.sh" });
    expect(s.startsWith("file_path: /tmp/a.sh")).toBe(true);
  });

  it("resta su una riga e non esplode con valori lunghi", () => {
    const s = summarizeToolInput({ command: "y".repeat(5000) });
    expect(s).not.toContain("\n");
    expect(s.length).toBeLessThanOrEqual(160);
  });

  it("input vuoto → nessun riassunto (niente riga a vuoto nel pannello)", () => {
    expect(summarizeToolInput({})).toBe("");
    expect(summarizeToolInput(undefined)).toBe("");
  });
});

describe("permissionDecisionFrom", () => {
  const ask = (answer: string) => ({
    kind: "questions" as const,
    answers: { [permissionQuestion(TOOL, { flyFrom: "NAP" })]: answer },
  });

  it("legge le tre decisioni", () => {
    expect(permissionDecisionFrom(ask(PERMISSION_ALLOW_ONCE_LABEL))).toBe("allow");
    expect(permissionDecisionFrom(ask(PERMISSION_ALLOW_ALWAYS_LABEL))).toBe("allow_always");
    expect(permissionDecisionFrom(ask(PERMISSION_DENY_LABEL))).toBe("deny");
  });

  it("un'etichetta che non riconosce vale NEGA — davanti a un permesso «non ho capito» non è «sì»", () => {
    expect(permissionDecisionFrom(ask("boh"))).toBe("deny");
    expect(permissionDecisionFrom(ask(""))).toBe("deny");
  });

  it("null quando non è una risposta a un permesso", () => {
    expect(permissionDecisionFrom({ kind: "questions", answers: { "Approvo questo piano?": "Approva ed esegui" } })).toBeNull();
    expect(permissionDecisionFrom({ kind: "raw" } as never)).toBeNull();
    expect(permissionDecisionFrom({} as never)).toBeNull();
  });
});

describe("isPermissionSchema", () => {
  it("riconosce il proprio pannello e non quello degli altri", () => {
    expect(isPermissionSchema(permissionSchemaFor({ toolName: TOOL }))).toBe(true);
    expect(isPermissionSchema({ kind: "questions", questions: [{ question: "Quale approccio?", options: [] }] })).toBe(false);
    expect(isPermissionSchema({ kind: "raw", rawInput: {} })).toBe(false);
    expect(isPermissionSchema(null)).toBe(false);
  });
});

describe("il giro completo: quello che il pannello mostra è quello che il server rilegge", () => {
  it("domanda generata → risposta → decisione, senza intermediari che riscrivano la chiave", () => {
    const schema = permissionSchemaFor({ toolName: TOOL, input: { flyFrom: "NAP", flyTo: "RAK" } });
    if (schema.kind !== "questions") throw new Error("unreachable");
    // Il client rimanda la domanda VERBATIM come chiave. Se la generazione e la
    // lettura divergessero, il pannello comparirebbe e il bottone non farebbe
    // niente — senza un solo errore di compilazione.
    const response = {
      kind: "questions" as const,
      answers: { [schema.questions[0].question]: PERMISSION_ALLOW_ALWAYS_LABEL },
    };
    expect(permissionDecisionFrom(response)).toBe("allow_always");
  });
});
