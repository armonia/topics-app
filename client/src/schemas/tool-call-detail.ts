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
 */
import { z } from 'zod';
import type { ToolCallDetail } from '../types';

const shellSchema = z.object({
  type: z.literal('shell'),
  command: z.string(),
  cwd: z.string().optional(),
  output: z.string().optional(),
  exitCode: z.number().nullable().optional(),
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

const unknownSchema = z.object({
  type: z.literal('unknown'),
  raw: z.object({
    args: z.record(z.string(), z.unknown()).optional(),
    result: z.string().optional(),
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

export function isToolCallDetail(value: unknown): value is ToolCallDetail {
  return toolCallDetailSchema.safeParse(value).success;
}

export type ZodInferredToolCallDetail = z.infer<typeof toolCallDetailSchema>;
