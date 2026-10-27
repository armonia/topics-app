/**
 * Opaque memory-queue references stay usable without exposing raw identifiers.
 * @covers KANBAN-97
 */
import { describe, expect, it } from "bun:test";
import { decodeMemoryQueueRef, encodeMemoryQueueRef, memoryQueueConsumerLabel, memoryQueueTitle } from "./dispatch-memory-reference";

describe("memory queue references", () => {
  it("round-trips UUIDs without long hexadecimal runs", () => {
    const values = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "board-42",
    ];
    const refs = values.map(encodeMemoryQueueRef);

    expect(refs.every((ref) => !/[0-9a-f]{8,}/i.test(ref))).toBe(true);
    expect(refs.map(decodeMemoryQueueRef)).toEqual(values);
  });

  it("keeps legacy route IDs and rejects malformed opaque references", () => {
    expect(decodeMemoryQueueRef("legacy-task")).toBe("legacy-task");
    expect(decodeMemoryQueueRef("MQ_AAAAAA")).toBeNull();
    expect(decodeMemoryQueueRef("MQ_")).toBeNull();
  });

  it("uses a readable fallback for titles that contain IDs or dispatcher terms", () => {
    expect(memoryQueueTitle("Review task 12345678-abcd-4a00-a000-123456789abc")).toBe("Card attiva");
    expect(memoryQueueTitle("runtime nativo")).toBe("Card attiva");
    expect(memoryQueueTitle("Revisionare la proposta")).toBe("Revisionare la proposta");
    expect(memoryQueueConsumerLabel("Claude PID 12345678")).toBe("Applicazione");
    expect(memoryQueueConsumerLabel("app Claude")).toBe("app Claude");
  });
});
