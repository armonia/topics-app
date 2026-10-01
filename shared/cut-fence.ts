/**
 * A command cut off inside its code fence (CHAT-RUN-01, CMDRUN-05).
 *
 * A reply can end with its last fence still open while `partial` is already 0:
 * Stop, the boot sweep after a restart and a provider error all close the row
 * and keep the text as it was. Markdown draws an open fence as a finished
 * block, so `rm -rf ./build/cache` cut at `rm -rf ./` would look complete. The
 * chat does not offer Run on such a block and the server refuses it, with the
 * same rule on both sides: a command is cut when every one of its lines is a
 * line of the fence a text of the reply leaves open.
 *
 * Fences are read line by line (``` or ~~~, three or more, closed by the same
 * character at least as long, with nothing after it), with blockquote markers
 * and indentation allowed before them.
 */
const OPEN = /^[ \t>]*(`{3,}|~{3,})(.*)$/;
const CLOSE = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/;

/** The body of the fence `markdown` leaves open at its end, or null when every fence is closed. */
export function cutFenceBody(markdown: string): string | null {
  let fence: string | null = null;
  let body: string[] = [];
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence === null) {
      const m = OPEN.exec(line);
      // A backtick fence's info string cannot hold a backtick: "```x```" is inline code.
      if (m && !(m[1]![0] === "`" && m[2]!.includes("`"))) { fence = m[1]!; body = []; }
      continue;
    }
    const m = CLOSE.exec(line);
    if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null;
    else body.push(line);
  }
  return fence === null ? null : body.join("\n");
}

/** Every way a body line can read as a command line: as written, without a blockquote marker, without a prompt. */
function bodyLineForms(body: string): Set<string> {
  const forms = new Set<string>();
  for (const line of body.split("\n")) {
    const bare = line.replace(/^[ \t>]*/, "").trim();
    forms.add(line.trim());
    forms.add(bare);
    if (/^[$%] /.test(bare)) forms.add(bare.slice(2).trim());
  }
  return forms;
}

/** Whether `command` is the text of a fence one of `texts` leaves open. */
export function isCommandCut(command: string, texts: readonly string[]): boolean {
  const lines = command.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  for (const text of texts) {
    const body = text ? cutFenceBody(text) : null;
    if (body === null) continue;
    const forms = bodyLineForms(body);
    if (lines.every((l) => forms.has(l))) return true;
  }
  return false;
}
