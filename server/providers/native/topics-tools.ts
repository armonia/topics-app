/**
 * I mestieri di Topics dati in mano all'agente nativo.
 *
 * IL BUCO. Il runtime nativo sa programmare — legge, scrive, esegue — ma non sa
 * muovere una card, aprire una pagina o parlare con un altro agente. Quelle
 * cose Topics le sa fare da sempre: sono i 39 tool in `mcp/topics-mcp-server.ts`,
 * scritti per le CLI, che li ricevono via MCP su un processo separato.
 *
 * LA SCELTA: RIUSARLI, NON RISCRIVERLI. La tentazione era reimplementarli qui
 * in-process, «tanto sono chiamate HTTP». Sarebbero diventate due
 * implementazioni degli stessi 39 comportamenti, e due implementazioni
 * divergono al primo bugfix applicato a una sola — con la differenza che si
 * scopre da un agente che si comporta diversamente a seconda del runtime, cioè
 * nel modo più confuso possibile. Qui si importa `TOOL_HANDLERS` e si chiama.
 *
 * NIENTE PROCESSO MCP, ed è coerente col resto: il runtime nativo esiste per
 * non spawnare niente, e spawnare un server MCP per parlare con noi stessi
 * sarebbe tornare indietro. Gli handler fanno chiamate HTTP a `localhost`, cioè
 * al server che li sta eseguendo: un giro di loopback che costa microsecondi e
 * ci fa passare per le stesse rotte, con gli stessi controlli, delle CLI.
 *
 * LO SCHEMA VIENE DALLA STESSA TABELLA. `toolsForProfile` decide quali tool
 * vede un agente dispacciato (`dispatch`) rispetto a una chat: la stessa
 * distinzione vale qui, perché è la stessa domanda — quali schemi vale la pena
 * pagare nel contesto di ogni chiamata.
 */

import { readFileSync } from "fs";
import {
  TOOL_HANDLERS,
  isToolAllowedForProfile,
  toolsForProfile,
  type ParsedArgs,
} from "../../mcp/topics-mcp-server";
import type { ToolSpec } from "./tools";
import type { ToolResult } from "./tools";

/** `format` field of a `browser_screenshot` response, translated to a MIME type. */
const SCREENSHOT_MEDIA_TYPE: Record<string, string> = { png: "image/png", jpeg: "image/jpeg" };

/**
 * `browser_screenshot` with `inline: true` asked to SEE the picture, not just
 * be told where it landed.
 *
 * The handler already wrote the file and answered with its path as JSON text
 * (`callBrowserBridge` above, `JSON.stringify(body)`) — every other Topics
 * tool stops there, because none of the other 38 ever produce an image. Rather
 * than teach that whole shared pipeline a second return shape for one caller,
 * the file is read back HERE, off the path the handler already gave us, and
 * turned into the same `ToolResult.images` the native `read_file` produces.
 * `inline` defaults to false/absent, which keeps today's path-only behavior
 * exactly as it was — see the comment on `nativeScreenshotOp` in
 * `browser-tool-dispatcher.ts` for why that default exists.
 */
export function inlineScreenshot(text: string): ToolResult["images"] {
  try {
    const body = JSON.parse(text) as { path?: unknown; format?: unknown };
    const mediaType = typeof body.format === "string" ? SCREENSHOT_MEDIA_TYPE[body.format] : undefined;
    if (typeof body.path !== "string" || !mediaType) return undefined;
    const data = readFileSync(body.path).toString("base64");
    return [{ mediaType, data }];
  } catch {
    // The path in the JSON does not exist, or the JSON itself is not what we
    // expect: the agent still gets the text response, just without the image.
    return undefined;
  }
}

/**
 * Gli schemi dei tool di Topics, nella forma che l'API di Anthropic vuole.
 *
 * La tabella MCP usa `inputSchema`, l'API di Anthropic `input_schema`: è
 * l'unica differenza, e si traduce qui invece di duplicare le descrizioni.
 */
export function topicsToolSpecs(profile?: string): ToolSpec[] {
  return toolsForProfile(profile).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as ToolSpec["input_schema"],
  }));
}

/** Un tool di Topics, o è roba nostra di coding? */
export function isTopicsTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name);
}

export interface TopicsToolContext {
  /** L'origine del server che ci ospita, es. `https://127.0.0.1:3333`. */
  baseUrl: string;
  sessionKey: string;
  gatewayToken?: string;
  profile?: string;
}

/**
 * Esegue un tool di Topics.
 *
 * Gli handler MCP SOLLEVANO in caso di errore, mentre il loop dell'agente vuole
 * un risultato con `isError`: la traduzione avviene qui, ed è la ragione per
 * cui questa funzione esiste invece di chiamare `TOOL_HANDLERS[name]` dal loop.
 * Un'eccezione che risale fino al loop farebbe morire il turno per un tool
 * andato storto, quando invece l'agente potrebbe semplicemente riprovare
 * diversamente.
 */
export async function executeTopicsTool(
  name: string,
  input: Record<string, unknown>,
  ctx: TopicsToolContext,
): Promise<ToolResult> {
  // Tool schemas are only a hint to the model. Enforce the profile again at
  // execution time so a native runtime cannot call a hidden ordinary-session
  // operation merely by constructing its name.
  if (!isToolAllowedForProfile(ctx.profile, name)) {
    return { content: `tool not available in this session profile: ${name}`, isError: true };
  }
  const handler = TOOL_HANDLERS[name];
  if (!handler) return { content: `tool sconosciuto: ${name}`, isError: true };

  const args: ParsedArgs = {
    baseUrl: ctx.baseUrl.replace(/\/$/, ""),
    sessionKey: ctx.sessionKey,
    gatewayToken: ctx.gatewayToken,
    profile: ctx.profile,
  };

  try {
    const text = await handler(args, input);
    if (name === "browser_screenshot" && input.inline === true) {
      const images = inlineScreenshot(text);
      if (images) return { content: text, images };
    }
    return { content: text };
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}
