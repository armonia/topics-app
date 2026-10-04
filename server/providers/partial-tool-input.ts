/**
 * The one argument worth showing on a tool row while the model is still
 * writing the call: the file being written, the command being run, the URL
 * being fetched.
 *
 * Shared by the two runtimes that stream a tool's input before running it:
 * the Claude Code CLI (`claude-code.ts`, `--include-partial-messages`) and the
 * native engine (`native/agent-loop.ts`, `input_json_delta`). Without it the
 * row reads `Shell` with an empty `$ ` until the last byte of the input lands:
 * measured on the native runtime on 2026-10-04, 22 calls out of 62 in twenty
 * minutes, up to 36.9 s of an empty row.
 */

/**
 * How often a still-streaming input is looked at. 500 ms is imperceptible to
 * the reader and bounds the broadcast rate on a large input to about 2/s.
 */
export const PARTIAL_ARGS_EMIT_MS = 500;

/** Primary input fields, in priority order. */
const PARTIAL_PRIMARY_KEYS = ["file_path", "filePath", "path", "command", "cmd", "url", "pattern", "query"] as const;

/**
 * Pull the first primary field out of a partial input-JSON buffer.
 *
 * By default only a COMPLETE `"key":"value"` counts (closing quote present),
 * so a value still mid-stream is ignored until done: that is the CLI's
 * contract, where the primary key is short and streams first.
 *
 * With `open: true` a value still being written counts too, cut at the last
 * whole character: a heredoc of forty lines is ONE value, and waiting for its
 * closing quote means waiting for the whole call. An escape split across two
 * chunks (`\`, `\u12`) is dropped until the rest arrives, so the row never
 * shows a backslash that is not in the command.
 */
export function extractPrimaryToolArg(
  buf: string,
  opts: { open?: boolean } = {},
): { key: string; value: string } | null {
  for (const key of PARTIAL_PRIMARY_KEYS) {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)(")?`);
    const m = re.exec(buf);
    if (!m) continue;
    const closed = m[2] === '"';
    if (!closed && !opts.open) continue;
    const raw = closed ? m[1]! : m[1]!.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
    if (!closed && raw === "") continue;
    try {
      return { key, value: JSON.parse(`"${raw}"`) as string };
    } catch {
      return { key, value: raw };
    }
  }
  return null;
}
