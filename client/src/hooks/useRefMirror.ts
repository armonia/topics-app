import { useRef, type MutableRefObject } from 'react';

/**
 * Mirror a value into a ref, updated synchronously on every render.
 *
 * Use this when an event handler (drop, key, scroll) needs to read the
 * latest value but React state from a recent setter call may not be
 * committed yet — e.g. `dragover` fires `setX(...)`, the user releases the
 * mouse in the same frame, and `drop`'s closure reads the pre-set value.
 * The ref always points at the latest render's value because assignment
 * happens during render, before any event handler can fire.
 *
 * Don't use this to skip re-renders — `useRef` directly is cheaper. The
 * point of the mirror is to bridge state→ref so consumers get both
 * reactive updates AND synchronous read access.
 */
export function useRefMirror<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
