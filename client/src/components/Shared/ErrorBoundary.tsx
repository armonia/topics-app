import { Component, type ReactNode } from 'react';
import { Check, Copy, Frown, RefreshCw } from 'lucide-react';
import { isChunkLoadError, signalChunkFailure } from '../../lib/chunkReloadGuard';
import { copyText } from '../../lib/clipboard';
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
  /** Where in the tree it broke, from `componentDidCatch`: part of the copied detail. */
  componentStack?: string | null;
  copied?: boolean;
}

/** Longest reason drawn on screen; the whole of it goes in the copied detail. */
const REASON_MAX_CHARS = 160;

/**
 * The reason, as the screen shows it: the first line of the message, cut.
 * A stack or a multi-line message is a diagnostic to paste, not copy to read.
 */
function shortReason(error: Error | null): string {
  const first = (error?.message ?? '').split('\n', 1)[0]!.trim();
  return first.length > REASON_MAX_CHARS ? `${first.slice(0, REASON_MAX_CHARS - 1)}\u2026` : first;
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
    this.setState({ componentStack: info.componentStack ?? null });
    // A lazy chunk that 404s against a rebuilt bundle lands here as a dead
    // "Panel error". Signal it so the DevBundleToast surfaces a reload prompt
    // even if this boundary sits in a hidden pane the user isn't looking at,
    // marked as a failed chunk so the prompt says a part did not load.
    if (isChunkLoadError(error)) signalChunkFailure();
  }

  /** What "copy the details" puts on the clipboard: the whole error, stack included. */
  detail(): string {
    const { error, componentStack } = this.state;
    if (!error) return '';
    const head = `${error.name}: ${error.message}`;
    // V8 starts the stack with name and message, WebKit does not.
    const stack = !error.stack ? head : error.stack.includes(error.message) ? error.stack : `${head}\n${error.stack}`;
    return componentStack ? `${stack}\n\nComponent stack:${componentStack}` : stack;
  }

  handleCopy = async () => {
    if (await copyText(this.detail())) {
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 1500);
    }
  };

  // Clearing the error state re-renders the same children — which, for a
  // transient render bug, recovers. For a MISSING chunk it just re-throws, so
  // that case gets a real (cache-busted) reload instead.
  handleReset = () => {
    this.setState({ hasError: false, error: null, componentStack: null, copied: false });
  };

  render() {
    if (this.state.hasError) {
      const chunkError = isChunkLoadError(this.state.error);
      const locale = currentLocale();
      const tr = (key: string): string => translate(key, locale);
      const reason = shortReason(this.state.error);
      return (
        <div className="flex flex-col items-center justify-center h-full p-6 text-center">
          <div className="mb-3">
            {chunkError ? (
              <RefreshCw className="w-8 h-8 mx-auto" aria-hidden="true" />
            ) : (
              <Frown className="w-8 h-8 mx-auto" aria-hidden="true" />
            )}
          </div>
          <h2 className="text-title font-semibold text-app-text mb-1">
            {chunkError
              ? tr('crash.staleBundle.title')
              : tr(this.props.fallbackMessageKey ?? 'crash.generic.title')}
          </h2>
          <p className="text-compact text-app-text-muted mb-4 max-w-xs">
            {chunkError ? tr('crash.staleBundle.body') : tr('crash.generic.body')}
          </p>
          {/* The reason stays, and stays raw: it is the diagnostic, not copy,
              and translating it would be translating the evidence. It gets a
              translated label, so it reads as a quotation rather than as the
              app talking. The screen shows its first line, cut; the stack and
              the rest go to the clipboard, for whoever files the report. A
              failed chunk shows its reason too: "which part, and why" is what
              tells a stale build from a server that was down. */}
          {reason && (
            <div className="mb-4 flex max-w-xs items-start gap-1.5">
              <p data-testid="crash-reason" className="min-w-0 text-mini text-app-text-muted font-mono break-words">
                {tr('crash.generic.detail')} {reason}
              </p>
              <button
                type="button"
                data-testid="crash-copy-details"
                onClick={this.handleCopy}
                title={tr('chat.turnError.copy')}
                aria-label={tr('chat.turnError.copy')}
                className="flex-shrink-0 rounded p-0.5 text-app-text-muted hover:text-app-text"
              >
                {this.state.copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          )}
          <button
            onClick={chunkError ? reloadForNewBundle : this.handleReset}
            className="px-4 py-2 text-prose font-medium bg-primary text-white rounded-lg hover:opacity-90 transition-opacity"
          >
            {chunkError ? tr('crash.staleBundle.action') : tr('crash.generic.action')}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
