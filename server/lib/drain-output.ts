/**
 * Reads a child's stdout/stderr to the end, handing each decoded chunk to
 * `onText`. A read or `onText` failure stops the drain, which truncates the log
 * and leaves the pipe unread: it is reported with the process id instead of
 * vanishing.
 */
export async function drainOutput(
  stream: ReadableStream<Uint8Array>,
  processId: string,
  onText: (text: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onText(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    console.warn(`[Processes] ${processId}: output drain stopped, the log is truncated:`, e);
  }
}
