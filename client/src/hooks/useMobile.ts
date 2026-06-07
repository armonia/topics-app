import { useState, useEffect } from 'react';

interface MobileState {
  isMobile: boolean;           // Screen width < 768px
  isTouch: boolean;            // Touch device
  isStandalone: boolean;       // PWA installed
  isIOS: boolean;              // iOS device
  isAndroid: boolean;          // Android device
  safeAreaInsets: {            // Safe area for notch/home indicator
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  keyboardVisible: boolean;    // Virtual keyboard open
  orientation: 'portrait' | 'landscape';
}

export function useMobile(): MobileState {
  const [state, setState] = useState<MobileState>(() => getInitialState());

  useEffect(() => {
    const updateState = () => {
      setState(getInitialState());
    };

    // Listen for resize
    window.addEventListener('resize', updateState);
    window.addEventListener('orientationchange', updateState);

    // Listen for keyboard (iOS/Android)
    if ('visualViewport' in window) {
      window.visualViewport?.addEventListener('resize', () => {
        const vv = window.visualViewport!;
        const keyboardVisible = vv.height < window.innerHeight * 0.75;
        setState(prev => ({ ...prev, keyboardVisible }));
      });
    }

    return () => {
      window.removeEventListener('resize', updateState);
      window.removeEventListener('orientationchange', updateState);
    };
  }, []);

  return state;
}

function getInitialState(): MobileState {
  if (typeof window === 'undefined') {
    return {
      isMobile: false,
      isTouch: false,
      isStandalone: false,
      isIOS: false,
      isAndroid: false,
      safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      keyboardVisible: false,
      orientation: 'portrait',
    };
  }

  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isMobile = window.innerWidth < 768 || (isTouch && window.innerWidth < 1024);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as any).standalone === true;

  // Get safe area insets from CSS env()
  const computedStyle = getComputedStyle(document.documentElement);
  const safeAreaInsets = {
    top: parseInt(computedStyle.getPropertyValue('--sat') || '0') || 0,
    bottom: parseInt(computedStyle.getPropertyValue('--sab') || '0') || 0,
    left: parseInt(computedStyle.getPropertyValue('--sal') || '0') || 0,
    right: parseInt(computedStyle.getPropertyValue('--sar') || '0') || 0,
  };

  const orientation = window.innerHeight > window.innerWidth ? 'portrait' : 'landscape';

  return {
    isMobile,
    isTouch,
    isStandalone,
    isIOS,
    isAndroid,
    safeAreaInsets,
    keyboardVisible: false,
    orientation,
  };
}

// Haptic feedback (iOS/Android)
export function haptic(type: 'light' | 'medium' | 'heavy' = 'light') {
  if ('vibrate' in navigator) {
    const duration = type === 'light' ? 10 : type === 'medium' ? 20 : 30;
    navigator.vibrate(duration);
  }
}

