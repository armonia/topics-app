import { Component, type ReactNode } from 'react';

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
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-6 text-center">
          <div className="text-3xl mb-3">😵</div>
          <h2 className="text-[15px] font-semibold text-app-text mb-1">
            {this.props.fallbackMessage || 'Something went wrong'}
          </h2>
          <p className="text-[12px] text-app-text-muted mb-4 max-w-xs">
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={this.handleReload}
            className="px-4 py-2 text-[13px] font-medium bg-primary text-white rounded-lg hover:opacity-90 transition-opacity"
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
