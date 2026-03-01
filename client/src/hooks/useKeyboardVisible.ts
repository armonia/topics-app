import { useState, useEffect } from 'react';

/**
 * Detects whether the virtual keyboard is likely open.
 * Uses visualViewport API to compare viewport height with window height.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const handleResize = () => {
      setVisible(vv.height < window.innerHeight * 0.75);
    };

    vv.addEventListener('resize', handleResize);
    return () => vv.removeEventListener('resize', handleResize);
  }, []);

  return visible;
}
