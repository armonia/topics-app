/**
 * Schema Zod di `ToolCallDetail` — UNO, per i due lati del filo.
 *
 * Fino al 29/07 questo schema esisteva due volte: `server/schemas/` e
 * `client/src/schemas/`, ciascuno con in testa un "KEEP IN SYNC" e la stessa
 * scusa — "TS6307 vieta l'import cross-progetto". Quella scusa è morta con
 * `shared/`, l'unica cartella che entrambi i progetti TS includono (vedi
 * `shared/ws-outbound.ts`): il vincolo strutturale è che il contratto sia UNO,
 * non che due file restino gentilmente uguali.
 *
 * Idioma `zod/mini` perché il modulo finisce nel bundle client, dove la
 * variante method-heavy pesa nel chunk d\'ingresso: `z.optional(x)` sta per
 * `x.optional()`, `.safeParse` è identico.
 *
 * L\'asserzione in fondo (`ZodInferredToolCallDetail`, verificata in
 * `tests/unit/tool-call-detail-schema.test.ts` nelle due direzioni) tiene lo
 * schema e il tipo di `shared/types.ts` strutturalmente uguali: se divergono,
 * il typecheck del test si rompe.
 */
import { z } from 'zod/mini';
import type { ToolCallDetail } from './types';

const shellSchema = z.object({
  type: z.literal('shell'),
  command: z.string(),
  cwd: z.optional(z.string()),
  output: z.optional(z.string()),
  exitCode: z.optional(z.nullable(z.number())),
  background: z.optional(z.boolean()),
});

const readSchema = z.object({
  type: z.literal('read'),
  filePath: z.string(),
  content: z.optional(z.string()),
  offset: z.optional(z.number()),
  limit: z.optional(z.number()),
});

const editSchema = z.object({
  type: z.literal('edit'),
  filePath: z.string(),
  oldString: z.optional(z.string()),
  newString: z.optional(z.string()),
  unifiedDiff: z.optional(z.string()),
});

const writeSchema = z.object({
  type: z.literal('write'),
  filePath: z.string(),
  content: z.optional(z.string()),
});

const searchToolNameSchema = z.enum(['search', 'grep', 'glob', 'web_search']);
const searchModeSchema = z.enum(['content', 'files_with_matches', 'count']);

const searchSchema = z.object({
  type: z.literal('search'),
  query: z.string(),
  toolName: z.optional(searchToolNameSchema),
  content: z.optional(z.string()),
  filePaths: z.optional(z.array(z.string())),
  numFiles: z.optional(z.number()),
  numMatches: z.optional(z.number()),
  mode: z.optional(searchModeSchema),
});

const fetchSchema = z.object({
  type: z.literal('fetch'),
  url: z.string(),
  prompt: z.optional(z.string()),
  result: z.optional(z.string()),
  statusCode: z.optional(z.number()),
  bytes: z.optional(z.number()),
});

const todoItemStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
const todoItemSchema = z.object({
  content: z.string(),
  status: todoItemStatusSchema,
  activeForm: z.optional(z.string()),
});
const todoSchema = z.object({
  type: z.literal('todo'),
  items: z.array(todoItemSchema),
});

const subAgentActionStatusSchema = z.enum(['running', 'success', 'error']);
const subAgentActionSchema = z.object({
  index: z.number(),
  toolName: z.string(),
  summary: z.optional(z.string()),
  status: z.optional(subAgentActionStatusSchema),
});
const subAgentSchema = z.object({
  type: z.literal('sub_agent'),
  subAgentType: z.optional(z.string()),
  description: z.optional(z.string()),
  actions: z.array(subAgentActionSchema),
  result: z.optional(z.string()),
});

const planSchema = z.object({
  type: z.literal('plan'),
  text: z.string(),
});

const mcpSchema = z.object({
  type: z.literal('mcp'),
  server: z.string(),
  tool: z.string(),
  args: z.optional(z.record(z.string(), z.unknown())),
  result: z.optional(z.string()),
});

const monitorSchema = z.object({
  type: z.literal('monitor'),
  description: z.string(),
  command: z.optional(z.string()),
  wsUrl: z.optional(z.string()),
  persistent: z.optional(z.boolean()),
  result: z.optional(z.string()),
});

const waitSchema = z.object({
  type: z.literal('wait'),
  processId: z.string(),
  until: z.optional(z.string()),
  timeoutMs: z.optional(z.number()),
  result: z.optional(z.string()),
});

const bashOutputSchema = z.object({
  type: z.literal('bash_output'),
  shellId: z.string(),
  filter: z.optional(z.string()),
  output: z.optional(z.string()),
});

const killShellSchema = z.object({
  type: z.literal('kill_shell'),
  shellId: z.string(),
  result: z.optional(z.string()),
});

const notebookEditSchema = z.object({
  type: z.literal('notebook_edit'),
  notebookPath: z.string(),
  cellId: z.optional(z.string()),
  editMode: z.optional(z.string()),
  cellType: z.optional(z.string()),
});

const skillSchema = z.object({
  type: z.literal('skill'),
  skill: z.string(),
  args: z.optional(z.string()),
  result: z.optional(z.string()),
});

const slashCommandSchema = z.object({
  type: z.literal('slash_command'),
  command: z.string(),
  result: z.optional(z.string()),
});

const lspSchema = z.object({
  type: z.literal('lsp'),
  operation: z.string(),
  filePath: z.optional(z.string()),
  symbol: z.optional(z.string()),
  result: z.optional(z.string()),
});

const unknownSchema = z.object({
  type: z.literal('unknown'),
  raw: z.object({
    args: z.optional(z.record(z.string(), z.unknown())),
    result: z.optional(z.string()),
  }),
});

export const toolCallDetailSchema = z.discriminatedUnion('type', [
  shellSchema,
  readSchema,
  editSchema,
  writeSchema,
  searchSchema,
  fetchSchema,
  todoSchema,
  subAgentSchema,
  planSchema,
  mcpSchema,
  monitorSchema,
  waitSchema,
  bashOutputSchema,
  killShellSchema,
  notebookEditSchema,
  skillSchema,
  slashCommandSchema,
  lspSchema,
  unknownSchema,
]);

export type ParseResult =
  | { ok: true; data: ToolCallDetail }
  | { ok: false; error: string };

/**
 * Valida un valore come `ToolCallDetail`. Da usare ai confini che ricevono un
 * detail non fidato (righe DB legacy, risposte del provider, frame WS) invece
 * di un cast al buio. In caso di errore la stringa contiene gli issue Zod
 * qualificati per path, già pronti da loggare.
 */
export function parseToolCallDetail(value: unknown): ParseResult {
  const result = toolCallDetailSchema.safeParse(value);
  if (result.success) {
    // Cast: il tipo inferito da Zod e quello canonico sono strutturalmente
    // uguali (asserito in fondo al file); l'unica differenza possibile sarebbe
    // la readonly-ness, che Zod non emette.
    return { ok: true, data: result.data as ToolCallDetail };
  }
  const error = result.error.issues
    .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
    .join('; ');
  return { ok: false, error };
}

/** Variante booleana per chi ha bisogno solo di un sì/no. */
export function isToolCallDetail(value: unknown): value is ToolCallDetail {
  return toolCallDetailSchema.safeParse(value).success;
}

/**
 * Uguaglianza strutturale a compile-time: il tipo inferito dallo schema deve
 * coincidere con `ToolCallDetail` di `shared/types.ts`. Verificata in
 * `tests/unit/tool-call-detail-schema.test.ts` nelle DUE direzioni — la deriva
 * rompe il typecheck del test.
 */
export type ZodInferredToolCallDetail = z.infer<typeof toolCallDetailSchema>;
