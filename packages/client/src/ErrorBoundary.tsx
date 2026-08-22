import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Top-level error boundary. The outliner renders straight from the live Y.Doc,
 * so a single unexpected exception during render or a keymap handler would
 * otherwise unmount the whole tree and leave a blank page. This keeps the app
 * shell alive, shows the error instead of a blank screen, and offers a reload.
 * Document state is durable (local persistence + sync), so reloading is safe.
 */
interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <h2>Something went wrong</h2>
        <p>The outline view hit an unexpected error. Your data is saved — reloading will restore it.</p>
        <pre>{error.stack ?? String(error)}</pre>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
