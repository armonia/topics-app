import { Component, type ReactNode } from 'react';
import { isChunkLoadError } from '../../lib/chunkReloadGuard';
import { reloadForNewBundle } from '../../lib/devBundleReload';
import { t as translate, resolveLocale, FALLBACK_LOCALE, type Locale } from '../../lib/i18n';
import { loadSettings } from '../../lib/settings';

interface Props {
  children: ReactNode;
  /**
   * The i18n KEY of the headline, not the headline. It used to be the words,
   * and the words the callers passed were English ("Panel error") sitting
   * above an Italian body: the crash screen was the one screen where the app
   * spoke two languages in three lines.
   */
  fallbackMessageKey?: string;
}

/**
 * The chosen language, without a hook: this is a class component, and the one
 * moment it renders is the moment something has already gone wrong. Reading
 * the settings can throw (no window, a bench that mounts React without a DOM),
 * and a crash screen that crashes leaves a blank pane, so the fallback locale
 * is the answer to any failure here.
 */
function currentLocale(): Locale {
  try {
    return resolveLocale(loadSettings().language);
  } catch {
    return FALLBACK_LOCALE;
  }
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
      const locale = currentLocale();
      const tr = (key: string): string => translate(key, locale);
      const raw = this.state.error?.message;
      return (
        <div className="flex flex-col items-center justify-center h-full p-6 text-center">
          <div className="text-3xl mb-3">{chunkError ? '🔄' : '😵'}</div>
          <h2 className="text-[15px] font-semibold text-app-text mb-1">
            {chunkError
              ? tr('crash.staleBundle.title')
              : tr(this.props.fallbackMessageKey ?? 'crash.generic.title')}
          </h2>
          <p className="text-[12px] text-app-text-muted mb-4 max-w-xs">
            {chunkError ? tr('crash.staleBundle.body') : tr('crash.generic.body')}
          </p>
          {/* The raw message stays, and stays raw: it is the diagnostic, not
              copy, and translating it would be translating the evidence. What
              it gets is a translated label, so it reads as a quotation rather
              than as the app talking. */}
          {!chunkError && raw && (
            <p className="text-[11px] text-app-text-muted mb-4 max-w-xs font-mono break-words">
              {tr('crash.generic.detail')} {raw}
            </p>
          )}
          <button
            onClick={chunkError ? reloadForNewBundle : this.handleReset}
            className="px-4 py-2 text-[13px] font-medium bg-primary text-white rounded-lg hover:opacity-90 transition-opacity"
          >
            {chunkError ? tr('crash.staleBundle.action') : tr('crash.generic.action')}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
