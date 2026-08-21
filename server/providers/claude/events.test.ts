/**
 * Il parser degli eventi `stream-json`, provato sulle fixture registrate.
 *
 * Il valore sta nel tipo di guasto che intercetta: quando la CLI cambia una di
 * queste forme non arriva un errore, arriva un pezzo di interfaccia che smette
 * di aggiornarsi in silenzio — il divider di compattazione, l'anello del
 * contesto, la riga di un tool che resta vuota. Qui invece diventa rosso.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyStreamLine,
  decodePartialStreamEvent,
  parseToolInputBuffer,
  readAssistantCallUsage,
  readAssistantContextTokens,
  readEventContent,
  readParentToolUseId,
  readResultErrorText,
  readResultUsage,
  splitCallUsage,
} from "./events";
import * as F from "./events.fixture";

describe("classifyStreamLine", () => {
  test("riconosce ogni riga che il provider tratta in modo diverso", () => {
    expect(classifyStreamLine(F.COMPACT_BOUNDARY).kind).toBe("compaction");
    expect(classifyStreamLine(F.SYSTEM_INIT).kind).toBe("noise");
    expect(classifyStreamLine(F.RATE_LIMIT).kind).toBe("noise");
    // THE FIELD NAME, not just the verdict. `classifyStreamLine` reads only
    // `type`, so a fixture with an invented payload key stays green forever and
    // becomes the shape the next feature is written against. The CLI (2.1.238)
    // emits `rate_limit_info`; it said `rate_limit` here until 2026-08-21.
    expect(F.RATE_LIMIT).toHaveProperty("rate_limit_info.status");
    expect(F.RATE_LIMIT).not.toHaveProperty("rate_limit");
    expect(classifyStreamLine(F.PARTIAL_BLOCK_START).kind).toBe("partial");
    expect(classifyStreamLine(F.RESULT_OK).kind).toBe("result");
    expect(classifyStreamLine(F.ASSISTANT_TEXT).kind).toBe("content");
    expect(classifyStreamLine(F.USER_TOOL_RESULT).kind).toBe("content");
  });

  test("la compattazione si alza PRIMA del filtro sui `system`", () => {
    // Se finisse dentro `noise` il divider sparirebbe senza un errore: è
    // esattamente il guasto muto che questo modulo esiste per rendere visibile.
    expect(classifyStreamLine({ type: "system", subtype: "compact_boundary" }).kind).toBe("compaction");
  });

  test("l'etichetta è quella che il watchdog logga come ultimo evento", () => {
    expect(classifyStreamLine(F.COMPACT_BOUNDARY).label).toBe("system/compact_boundary");
    expect(classifyStreamLine(F.ASSISTANT_TEXT).label).toBe("assistant");
    expect(classifyStreamLine(null).label).toBe("?");
    expect(classifyStreamLine({ type: "qualcosa_di_nuovo" }).kind).toBe("unknown");
  });
});

describe("readEventContent", () => {
  test("legge i blocchi da `message.content`", () => {
    expect(readEventContent(F.ASSISTANT_TEXT)).toEqual([{ type: "text", text: "Guardo il file." }]);
    expect(readEventContent(F.USER_TOOL_RESULT)).toHaveLength(1);
  });

  test("accetta anche la forma appiattita `content`", () => {
    // Difensivo apposta: una versione del provider leggeva SOLO questa, sempre
    // undefined, e la chat mostrava lo stub «No response received».
    expect(readEventContent({ type: "assistant", content: [{ type: "text", text: "x" }] }))
      .toEqual([{ type: "text", text: "x" }]);
  });

  test("null per tutto ciò che non è assistant/user o non ha blocchi", () => {
    expect(readEventContent(F.RESULT_OK)).toBeNull();
    expect(readEventContent({ type: "assistant", message: {} })).toBeNull();
    expect(readEventContent(undefined)).toBeNull();
  });
});

describe("readParentToolUseId", () => {
  test("marca gli eventi delle sotto-sessioni", () => {
    expect(readParentToolUseId(F.SIDECHAIN_ASSISTANT)).toBe("toolu_task");
    expect(readParentToolUseId(F.ASSISTANT_TEXT)).toBeNull();
    // Stringa vuota = nessun genitore, non un genitore senza nome.
    expect(readParentToolUseId({ parent_tool_use_id: "" })).toBeNull();
  });
});

describe("readAssistantCallUsage", () => {
  test("le quote sono DISGIUNTE come le dichiara il contratto", () => {
    const u = readAssistantCallUsage(F.ASSISTANT_TEXT)!;
    // inputTokens è il TOTALE letto: comprende cacheRead + cacheCreation.
    expect(u.inputTokens).toBe(12 + 1_024 + 45_000);
    expect(u.cacheRead).toBe(45_000);
    expect(u.cacheCreation).toBe(1_024);
    // …e cacheCreation1h è una QUOTA di cacheCreation, non un addendo. Il TTL
    // sta scritto nell'usage: a un'ora costa 2×, a cinque minuti 1.25×.
    expect(u.cacheCreation1h).toBe(1_000);
    expect(u.outputTokens).toBe(37);
    expect(u.model).toBe("claude-opus-5[1m]");
  });

  test("il modello viene dallo STESSO evento dell'usage", () => {
    // È quello che ha servito la chiamata, cioè quello che dimensiona la
    // finestra: risolverlo dalle opzioni della richiesta sarebbe sbagliato il
    // giorno che la CLI ripiega su un altro modello a metà turno.
    expect(readAssistantCallUsage(F.SIDECHAIN_ASSISTANT)?.model).toBe("claude-sonnet-5");
    expect(readAssistantCallUsage({ type: "assistant", message: { usage: {} } })?.model).toBeUndefined();
  });

  test("null senza usage: non è una chiamata a zero token, è una che non sappiamo", () => {
    expect(readAssistantCallUsage({ type: "assistant", message: { content: [] } })).toBeNull();
    expect(readAssistantCallUsage(F.USER_TOOL_RESULT)).toBeNull();
    expect(readAssistantCallUsage(F.RESULT_OK)).toBeNull();
  });
});

describe("readAssistantContextTokens", () => {
  test("è il SERBATOIO di quella chiamata: fresco + letto + scritto", () => {
    expect(readAssistantContextTokens(F.ASSISTANT_TEXT)).toBe(12 + 45_000 + 1_024);
  });

  test("non conta l'output: quello è bolletta, non contesto", () => {
    const size = readAssistantContextTokens(F.ASSISTANT_TWO_TOOLS);
    expect(size).toBe(11 + 50_001);
    expect(size).not.toBe(11 + 50_001 + 101);
  });

  test("zero = niente da dire, e il chiamante non emette", () => {
    expect(readAssistantContextTokens({ type: "assistant", message: {} })).toBe(0);
    expect(readAssistantContextTokens(null)).toBe(0);
  });
});

describe("splitCallUsage", () => {
  test("una chiamata con due azioni si divide a metà, per difetto", () => {
    const u = readAssistantCallUsage(F.ASSISTANT_TWO_TOOLS)!;
    const share = splitCallUsage(u, 2);
    expect(share.inputTokens).toBe(Math.floor((11 + 50_001) / 2));
    expect(share.outputTokens).toBe(50); // 101 / 2 per difetto
    expect(share.model).toBe("claude-opus-5[1m]");
  });

  test("la somma delle azioni non supera MAI il totale del turno", () => {
    const u = readAssistantCallUsage(F.ASSISTANT_TWO_TOOLS)!;
    for (const k of [1, 2, 3, 7]) {
      const share = splitCallUsage(u, k);
      expect(share.inputTokens * k).toBeLessThanOrEqual(u.inputTokens);
      expect(share.outputTokens * k).toBeLessThanOrEqual(u.outputTokens);
    }
  });

  test("un divisore assurdo non fa esplodere niente", () => {
    const u = readAssistantCallUsage(F.ASSISTANT_TEXT)!;
    expect(splitCallUsage(u, 0)).toEqual(u);
    expect(splitCallUsage(u, -3)).toEqual(u);
  });
});

describe("readResultUsage", () => {
  test("è l'AGGREGATO del turno, non la dimensione del contesto", () => {
    const u = readResultUsage(F.RESULT_OK);
    expect(u.inputTokens).toBe(340 + 9_000 + 1_200_000);
    expect(u.outputTokens).toBe(4_311);
    expect(u.cacheCreation).toBe(9_000);
    expect(u.cacheCreation1h).toBe(7_000);
    expect(u.cacheRead).toBe(1_200_000);
  });

  test("i campi a zero restano `undefined`: «non c'era cache» ≠ «cache a zero»", () => {
    const u = readResultUsage({ type: "result", usage: { input_tokens: 5, output_tokens: 2 } });
    expect(u.inputTokens).toBe(5);
    expect(u.cacheCreation).toBeUndefined();
    expect(u.cacheCreation1h).toBeUndefined();
    expect(u.cacheRead).toBeUndefined();
  });

  test("un result senza usage non produce NaN", () => {
    expect(readResultUsage({ type: "result" })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreation: undefined,
      cacheCreation1h: undefined,
      cacheRead: undefined,
    });
  });
});

describe("readResultErrorText", () => {
  test("appiattisce il result di errore da cui si riconosce una sessione morta", () => {
    const text = readResultErrorText(F.RESULT_MISSING_SESSION)!;
    expect(text).toContain("error_during_execution");
    expect(text).toContain("No conversation found with session ID");
  });

  test("null su un result riuscito: non c'è niente da riconoscere", () => {
    expect(readResultErrorText(F.RESULT_OK)).toBeNull();
    expect(readResultErrorText(F.RESULT_WAITING)).toBeNull();
  });
});

describe("decodePartialStreamEvent", () => {
  test("il ciclo di vita di un tool: start → delta → stop", () => {
    expect(decodePartialStreamEvent(F.PARTIAL_BLOCK_START)).toEqual({
      kind: "tool_start", index: 1, id: "toolu_c", name: "Write",
    });
    expect(decodePartialStreamEvent(F.PARTIAL_INPUT_DELTA)).toEqual({
      kind: "input_delta", index: 1, chunk: '{"file_path":"/tmp/App',
    });
    expect(decodePartialStreamEvent(F.PARTIAL_BLOCK_STOP)).toEqual({ kind: "block_stop", index: 1 });
  });

  test("i delta di TESTO si ignorano: la loro sorgente sono gli snapshot", () => {
    // Leggerli anche da qui li conterebbe due volte.
    expect(decodePartialStreamEvent(F.PARTIAL_TEXT_DELTA)).toBeNull();
  });

  test("i parziali di una sotto-sessione si ignorano", () => {
    expect(decodePartialStreamEvent(F.PARTIAL_SIDECHAIN)).toBeNull();
  });

  test("un blocco senza id non annuncia niente", () => {
    const noId = { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "Read" } } };
    expect(decodePartialStreamEvent(noId)).toBeNull();
  });

  test("null su tutto ciò che non è un `stream_event`", () => {
    expect(decodePartialStreamEvent(F.ASSISTANT_TEXT)).toBeNull();
    expect(decodePartialStreamEvent(F.RESULT_OK)).toBeNull();
    expect(decodePartialStreamEvent("{}")).toBeNull();
  });
});

describe("parseToolInputBuffer", () => {
  test("buffer vuoto = input DAVVERO vuoto (i tool senza argomenti non emettono delta)", () => {
    expect(parseToolInputBuffer("")).toEqual({});
  });

  test("un oggetto JSON completo passa così com'è", () => {
    expect(parseToolInputBuffer('{"file_path":"/tmp/App.tsx","content":"x"}'))
      .toEqual({ file_path: "/tmp/App.tsx", content: "x" });
  });

  test("troncato, array o scalare → null: finalizza lo snapshot cumulativo", () => {
    // Null e `{}` NON sono la stessa cosa: `{}` cancellerebbe gli argomenti già
    // mostrati, null lascia che li porti lo snapshot.
    expect(parseToolInputBuffer('{"file_path":"/tmp/App')).toBeNull();
    expect(parseToolInputBuffer("[1,2]")).toBeNull();
    expect(parseToolInputBuffer('"testo"')).toBeNull();
    expect(parseToolInputBuffer("null")).toBeNull();
  });
});
