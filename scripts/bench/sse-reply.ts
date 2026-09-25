/**
 * THE REPLY TEXT OF A POST /api/chat SSE BODY: the `delta.content` of its data
 * frames, nothing else.
 *
 * `native-concurrency.sh` counted a turn as answered when its raw bytes held
 * "20" (the prompt asks to count to 20). The first frame names the turn's row
 * with a UUID, and one UUID in eleven holds "20": 7 failed turns out of 60 read
 * as answered. The check reads the reply, not the bytes around it.
 *
 * CLI: `bun scripts/bench/sse-reply.ts <file>` prints the reply text.
 */
export function sseReplyText(body: string): string {
  let text = "";
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const frame = JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: unknown } }> };
      const content = frame?.choices?.[0]?.delta?.content;
      if (typeof content === "string") text += content;
    } catch { /* [DONE], or not JSON */ }
  }
  return text;
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: bun scripts/bench/sse-reply.ts <sse-body-file>");
    process.exit(2);
  }
  process.stdout.write(sseReplyText(await Bun.file(file).text()));
}
