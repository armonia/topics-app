import { Component, type ReactNode } from 'react';
import { isChunkLoadError } from '../../lib/chunkReloadGuard';
import { reloadForNewBundle } from '../../lib/devBundleReload';

interface Props {
  children: ReactNode;
  fallbackMessage?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
    // A lazy chunk that 404s against a rebuilt bundle lands here as a dead
    // "Panel error". Signal it so the DevBundleToast surfaces a reload prompt
    // even if this boundary sits in a hidden pane the user isn't looking at.
    if (isChunkLoadError(error)) {
      window.dispatchEvent(new CustomEvent('topics:bundle-stale'));
    }
  }

  // Clearing the error state re-renders the same children — which, for a
  // transient render bug, recovers. For a MISSING chunk it just re-throws, so
  // that case gets a real (cache-busted) reload instead.
  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const chunkError = isChunkLoadError(this.state.error);
      return (
        <div className="flex flex-col items-center justify-center h-full p-6 text-center">
          <div className="text-3xl mb-3">{chunkError ? '🔄' : '😵'}</div>
          <h2 className="text-[15px] font-semibold text-app-text mb-1">
            {chunkError
              ? 'Nuova versione disponibile'
              : this.props.fallbackMessage || 'Something went wrong'}
          </h2>
          <p className="text-[12px] text-app-text-muted mb-4 max-w-xs">
            {chunkError
              ? "L'app è stata aggiornata mentre era aperta. Ricarica per continuare."
              : this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={chunkError ? reloadForNewBundle : this.handleReset}
            className="px-4 py-2 text-[13px] font-medium bg-primary text-white rounded-lg hover:opacity-90 transition-opacity"
          >
            {chunkError ? 'Ricarica' : 'Try again'}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
