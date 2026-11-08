export interface MemoryPressureFrame extends Record<string, unknown> {
  type: 'memory:pressure';
  pressure: boolean;
}

export function createMemoryPressureSignal(
  broadcast: (frame: MemoryPressureFrame) => void,
  initialPressure = false,
) {
  let pressure = initialPressure;
  return {
    current: () => pressure,
    frame: (): MemoryPressureFrame => ({ type: 'memory:pressure', pressure }),
    update(next: boolean): boolean {
      if (next === pressure) return false;
      pressure = next;
      broadcast({ type: 'memory:pressure', pressure });
      return true;
    },
  };
}
