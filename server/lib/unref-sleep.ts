/** Sleep whose timer never keeps the process alive: a pending wait must not block shutdown. */
export const sleep = (ms: number) =>
  new Promise<void>((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); });
