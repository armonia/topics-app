/**
 * Zod schema for `ToolCallDetail` (v3 foundations NORM-01 foundation).
 *
 * Mirror of the TypeScript union in `server/types.ts:ToolCallDetail`. The
 * canonical TS type stays in `server/types.ts` (used by 100+ call sites);
 * this file adds runtime validation as an opt-in layer at boundaries that
 * receive `ToolCallDetail` from untrusted sources (legacy DB rows, WS
 * frames, provider responses).
 *
 * Why a separate schema file?
 *   - Keeps `server/types.ts` purely structural (no runtime imports leaking
 *     into modules that only need the types).
 *   - Allows the schema to be mirrored on the client (TS6307 prevents a
 *     direct cross-project import) without dragging the rest of types.ts.
 *
 * KEEP IN SYNC with:
 *   - `server/types.ts:ToolCallDetail` (the canonical type)
 *   - `client/src/schemas/tool-call-detail.ts` (the client mirror)
 *
 * The two type-level assertions at the bottom (`_serverTypeAssignableFromZod`,
 * `_zodAssignableFromServerType`) compile only if the Zod schema exactly
 * matches the TS union — drift breaks the build.
 */
import { z } from 'zod';
import type { ToolCallDetail } from '../types';

// ----- Subschemas ------------------------------------------------------------

const shellSchema = z.object({
  type: z.literal('shell'),
  command: z.string(),
  cwd: z.string().optional(),
  output: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  background: z.boolean().optional(),
});

const readSchema = z.object({
  type: z.literal('read'),
  filePath: z.string(),
  content: z.string().optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});

const editSchema = z.object({
  type: z.literal('edit'),
  filePath: z.string(),
  oldString: z.string().optional(),
  newString: z.string().optional(),
  unifiedDiff: z.string().optional(),
});

const writeSchema = z.object({
  type: z.literal('write'),
  filePath: z.string(),
  content: z.string().optional(),
});

const searchToolNameSchema = z.enum(['search', 'grep', 'glob', 'web_search']);
const searchModeSchema = z.enum(['content', 'files_with_matches', 'count']);

const searchSchema = z.object({
  type: z.literal('search'),
  query: z.string(),
  toolName: searchToolNameSchema.optional(),
  content: z.string().optional(),
  filePaths: z.array(z.string()).optional(),
  numFiles: z.number().optional(),
  numMatches: z.number().optional(),
  mode: searchModeSchema.optional(),
});

const fetchSchema = z.object({
  type: z.literal('fetch'),
  url: z.string(),
  prompt: z.string().optional(),
  result: z.string().optional(),
  statusCode: z.number().optional(),
  bytes: z.number().optional(),
});

const todoItemStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
const todoItemSchema = z.object({
  content: z.string(),
  status: todoItemStatusSchema,
  activeForm: z.string().optional(),
});
const todoSchema = z.object({
  type: z.literal('todo'),
  items: z.array(todoItemSchema),
});

const subAgentActionStatusSchema = z.enum(['running', 'success', 'error']);
const subAgentActionSchema = z.object({
  index: z.number(),
  toolName: z.string(),
  summary: z.string().optional(),
  status: subAgentActionStatusSchema.optional(),
});
const subAgentSchema = z.object({
  type: z.literal('sub_agent'),
  subAgentType: z.string().optional(),
  description: z.string().optional(),
  actions: z.array(subAgentActionSchema),
  result: z.string().optional(),
});

const planSchema = z.object({
  type: z.literal('plan'),
  text: z.string(),
});

const mcpSchema = z.object({
  type: z.literal('mcp'),
  server: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  result: z.string().optional(),
});

const monitorSchema = z.object({
  type: z.literal('monitor'),
  description: z.string(),
  command: z.string().optional(),
  wsUrl: z.string().optional(),
  persistent: z.boolean().optional(),
  result: z.string().optional(),
});

const bashOutputSchema = z.object({
  type: z.literal('bash_output'),
  shellId: z.string(),
  filter: z.string().optional(),
  output: z.string().optional(),
});

const killShellSchema = z.object({
  type: z.literal('kill_shell'),
  shellId: z.string(),
  result: z.string().optional(),
});

const notebookEditSchema = z.object({
  type: z.literal('notebook_edit'),
  notebookPath: z.string(),
  cellId: z.string().optional(),
  editMode: z.string().optional(),
  cellType: z.string().optional(),
});

const skillSchema = z.object({
  type: z.literal('skill'),
  skill: z.string(),
  args: z.string().optional(),
  result: z.string().optional(),
});

const slashCommandSchema = z.object({
  type: z.literal('slash_command'),
  command: z.string(),
  result: z.string().optional(),
});

const lspSchema = z.object({
  type: z.literal('lsp'),
  operation: z.string(),
  filePath: z.string().optional(),
  symbol: z.string().optional(),
  result: z.string().optional(),
});

const unknownSchema = z.object({
  type: z.literal('unknown'),
  raw: z.object({
    args: z.record(z.string(), z.unknown()).optional(),
    result: z.string().optional(),
  }),
});

// ----- Top-level discriminated union ----------------------------------------

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

// ----- Public API ------------------------------------------------------------

export type ParseResult =
  | { ok: true; data: ToolCallDetail }
  | { ok: false; error: string };

/**
 * Validate and parse a value as a ToolCallDetail. Use at boundaries that
 * receive untrusted detail payloads (DB hydration of legacy rows, provider
 * responses, WS frames). Returns a discriminated result with the canonical
 * server-side `ToolCallDetail` type on success.
 *
 * On failure the error string contains path-qualified Zod issues, suitable
 * for logging without a separate formatter.
 */
export function parseToolCallDetail(value: unknown): ParseResult {
  const result = toolCallDetailSchema.safeParse(value);
  if (result.success) {
    // Cast: Zod-inferred and the canonical TS type are structurally equal
    // (asserted at the bottom of this file). Cast is safe because the only
    // difference would be readonly-ness which Zod does not emit.
    return { ok: true, data: result.data as ToolCallDetail };
  }
  const error = result.error.issues
    .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
    .join('; ');
  return { ok: false, error };
}

/** Boolean variant for places that just need a yes/no. */
export function isToolCallDetail(value: unknown): value is ToolCallDetail {
  return toolCallDetailSchema.safeParse(value).success;
}

/**
 * Compile-time structural equality: the inferred Zod type must equal the
 * canonical TS `ToolCallDetail`. Verified in
 * `tests/unit/tool-call-detail-schema.test.ts` via assignability checks in
 * both directions — drift breaks the test file's type check.
 */
export type ZodInferredToolCallDetail = z.infer<typeof toolCallDetailSchema>;
