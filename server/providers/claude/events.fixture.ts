/**
 * Righe `stream-json` REGISTRATE dalla CLI di Claude.
 *
 * Non sono inventate a tavolino: sono la forma che la CLI emette davvero, con
 * i campi che ci interessano e le stesse chiavi (`cache_creation_input_tokens`,
 * `ephemeral_1h_input_tokens`, `parent_tool_use_id`, `content_block_start`…).
 * I payload lunghi sono accorciati — il testo di un tool result non cambia il
 * comportamento del parser — ma nessuna chiave è stata rinominata o aggiunta.
 *
 * Sono il motivo per cui `events.ts` si può provare senza spawnare niente: il
 * pezzo fragile è la traduzione di QUESTE forme, e finché queste restano ferme
 * la traduzione si prova in millisecondi.
 */

/** `system/init`: rumore, ma è anche l'unico posto da cui passa la fast mode. */
export const SYSTEM_INIT = {
  type: "system",
  subtype: "init",
  cwd: "/Users/j/Projects/topics-app",
  session_id: "11111111-2222-3333-4444-555555555555",
  model: "claude-opus-5[1m]",
  permissionMode: "acceptEdits",
};

/** Il confine di una compattazione: si alza PRIMA del filtro sui `system`. */
export const COMPACT_BOUNDARY = {
  type: "system",
  subtype: "compact_boundary",
  compact_metadata: { trigger: "auto", pre_tokens: 187_432 },
};

/* How full the plan's windows are, said by the CLI on its own initiative.
 *
 * THE KEY IS `rate_limit_info`, and it was `rate_limit` here until 2026-08-21.
 * Read out of the CLI binary (2.1.238), which emits
 * `type:"rate_limit_event",rate_limit_info:n,uuid:…,session_id:…`. A fixture
 * that invents a field is worse than no fixture: it is the shape everyone who
 * builds on this event will code against, and it looks measured. The test only
 * asserted `kind`, so the wrong name could never have failed anything - the
 * assertion on the field name below is the other half of the fix.
 *
 * `unifiedWindows` read out of the same binary at 2.1.263, where the zod schema
 * is `{five_hour|seven_day|seven_day_overage_included: {utilization, resetsAt
 * int}}` and the CLI's own readers do `utilization*100` and `resets_at*1000`.
 * So the numbers here are a FRACTION and epoch SECONDS, deliberately: they are
 * the trap the decoder exists to disarm. */
export const RATE_LIMIT = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed_warning",
    resetsAt: 1_754_600_000,
    rateLimitType: "five_hour",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.82, resetsAt: 1_754_600_000 },
      seven_day: { utilization: 0.31, resetsAt: 1_755_000_000 },
    },
  },
};

/** Uno snapshot cumulativo con testo e usage. */
export const ASSISTANT_TEXT = {
  type: "assistant",
  message: {
    id: "msg_01",
    model: "claude-opus-5[1m]",
    content: [{ type: "text", text: "Guardo il file." }],
    usage: {
      input_tokens: 12,
      cache_creation_input_tokens: 1_024,
      cache_creation: { ephemeral_5m_input_tokens: 24, ephemeral_1h_input_tokens: 1_000 },
      cache_read_input_tokens: 45_000,
      output_tokens: 37,
    },
  },
  session_id: "11111111-2222-3333-4444-555555555555",
};

/** Due `tool_use` decisi dalla STESSA chiamata: l'usage va spartito fra loro. */
export const ASSISTANT_TWO_TOOLS = {
  type: "assistant",
  message: {
    id: "msg_02",
    model: "claude-opus-5[1m]",
    content: [
      { type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "/tmp/a.ts" } },
      { type: "tool_use", id: "toolu_b", name: "Read", input: { file_path: "/tmp/b.ts" } },
    ],
    usage: {
      input_tokens: 11,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 50_001,
      output_tokens: 101,
    },
  },
};

/** Un evento `user`: qui la CLI mette i `tool_result`, non negli `assistant`. */
export const USER_TOOL_RESULT = {
  type: "user",
  message: {
    content: [
      { type: "tool_result", tool_use_id: "toolu_a", content: "export const a = 1;\n", is_error: false },
    ],
  },
};

/** Lo stesso, ma emesso da una SOTTO-SESSIONE (figlio di un `Task`). */
export const SIDECHAIN_ASSISTANT = {
  type: "assistant",
  parent_tool_use_id: "toolu_task",
  message: {
    id: "msg_child",
    model: "claude-sonnet-5",
    content: [{ type: "tool_use", id: "toolu_child", name: "Grep", input: { pattern: "TODO" } }],
    usage: { input_tokens: 900, cache_read_input_tokens: 12_000, output_tokens: 40 },
  },
};

/** `--include-partial-messages`: il tool viene annunciato QUI, prima dell'input. */
export const PARTIAL_BLOCK_START = {
  type: "stream_event",
  event: {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_c", name: "Write", input: {} },
  },
};

export const PARTIAL_INPUT_DELTA = {
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/App' },
  },
};

export const PARTIAL_BLOCK_STOP = {
  type: "stream_event",
  event: { type: "content_block_stop", index: 1 },
};

/** Un blocco parziale di TESTO: non è del ciclo di vita di un tool, si ignora. */
export const PARTIAL_TEXT_DELTA = {
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "cia" },
  },
};

/** Blocchi parziali di una sotto-sessione: aggregati altrove, non da qui. */
export const PARTIAL_SIDECHAIN = {
  type: "stream_event",
  parent_tool_use_id: "toolu_task",
  event: {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_child2", name: "Read", input: {} },
  },
};

/** Il turno è finito bene: l'usage qui è l'AGGREGATO di tutte le chiamate. */
export const RESULT_OK = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 41_233,
  total_cost_usd: 0.4127,
  result: "Fatto.",
  usage: {
    input_tokens: 340,
    cache_creation_input_tokens: 9_000,
    cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 7_000 },
    cache_read_input_tokens: 1_200_000,
    output_tokens: 4_311,
  },
};

/**
 * La sessione `--resume` non esiste più. La CLI lo dice come result di ERRORE
 * su STDOUT, non su stderr: è la ragione per cui `readResultErrorText` esiste.
 */
export const RESULT_MISSING_SESSION = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  errors: ["No conversation found with session ID: 11111111-2222-3333-4444-555555555555"],
  result: "",
};

/** Il "result" di attesa che la CLI emette a vuoto: non chiude nessun turno. */
export const RESULT_WAITING = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "waiting for message",
};
