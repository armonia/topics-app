/**
 * Zod schema for `ToolCallDetail` (v3 foundations NORM-01 foundation, client).
 *
 * Mirror of `server/schemas/tool-call-detail.ts`. The TS6307 composite
 * project boundary forbids cross-import from `server/`, so the schema is
 * duplicated; the canonical TS type lives in `client/src/types/index.ts`.
 *
 * KEEP IN SYNC with:
 *   - `client/src/types/index.ts:ToolCallDetail` (the canonical client type)
 *   - `server/schemas/tool-call-detail.ts` (the server source of truth)
 *
 * Uses `zod/mini` (functional, tree-shakable API) so this client-bundled
 * schema doesn't drag the method-heavy core into the critical entry chunk.
 * `z.optional(...)` / `z.nullable(...)` replace the `.optional()` / `.nullable()`
 * methods; `.safeParse` is identical across full zod and zod/mini.
 */
import { z } from 'zod/mini';
import type { ToolCallDetail } from '../types';

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
 * Validate and parse a value as a ToolCallDetail. Use at boundaries that
 * receive untrusted detail payloads (WS stream events, DB hydration of
 * legacy rows, etc.) instead of an unsafe cast.
 */
export function parseToolCallDetail(value: unknown): ParseResult {
  const result = toolCallDetailSchema.safeParse(value);
  if (result.success) {
    return { ok: true, data: result.data as ToolCallDetail };
  }
  const error = result.error.issues
    .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
    .join('; ');
  return { ok: false, error };
}

export type ZodInferredToolCallDetail = z.infer<typeof toolCallDetailSchema>;
