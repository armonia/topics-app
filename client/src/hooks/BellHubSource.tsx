/**
 * Runs the hub's part of the bell in its own chunk and hands it to the
 * window's ledger (`state/bellHubPart`). Mounted once, lazily, by the
 * notifications provider; it renders nothing.
 */
import { useEffect } from 'react';
import { useBellHub } from './useBellHub';
import { publishBellHubPart } from '../state/bellHubPart';

export default function BellHubSource(): null {
  const part = useBellHub();
  useEffect(() => { publishBellHubPart(part); }, [part]);
  useEffect(() => () => { publishBellHubPart(null); }, []);
  return null;
}
