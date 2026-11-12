import { warnThrottled } from "./warn-throttled";

/**
 * Reads a child's stdout/stderr to the end, handing each decoded chunk to
 * `onText`. An `onText` that throws is reported and the drain goes on: stopping
 * would truncate the log and leave the pipe unread, blocking the child. A read
 * failure ends the drain (nothing more can come), is reported with the process
 * id, and releases the stream.
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
      try {
        onText(decoder.decode(value, { stream: true }));
      } catch (e) {
        warnThrottled(`processes:drain-sink:${processId}`, `[Processes] ${processId}: handling an output chunk failed, the log may miss it:`, e);
      }
    }
  } catch (e) {
    console.warn(`[Processes] ${processId}: output drain stopped, the log is truncated:`, e);
    await reader.cancel().catch(() => {});
  }
}
