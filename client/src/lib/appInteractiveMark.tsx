import { useLayoutEffect } from 'react';

export function AppInteractiveMark({ ready }: { ready: boolean }): null {
  useLayoutEffect(() => {
    if (ready && performance.getEntriesByName('app:interactive', 'mark').length === 0) {
      performance.mark('app:interactive');
      document.documentElement.dataset.appInteractive = String(Math.round(performance.now()));
    }
  }, [ready]);
  return null;
}
