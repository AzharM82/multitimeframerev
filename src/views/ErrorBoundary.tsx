import { Component, type ReactNode, type ErrorInfo } from "react";

/**
 * Catches render-time crashes in a tab and shows the error instead of a blank page.
 *
 * Without this, any uncaught exception during render unmounts the whole React
 * tree and the user gets a white screen with no clue what happened — which is
 * exactly the failure mode that made the Leading Industries panel impossible to
 * diagnose remotely. The message and stack are shown deliberately: this is a
 * private, single-user portal, and a readable error beats a blank page.
 */

interface Props {
  /** Changing this resets the boundary — pass the active tab/panel key. */
  resetKey?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep it in the console too, so the browser devtools shows the full trace.
    console.error("[portal] render crash:", error, info);
    this.setState({ info: info.componentStack ?? null });
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, info: null });
    }
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="max-w-3xl mx-auto py-12">
        <div className="border-l-2 border-signal-bear bg-bg-card px-4 py-3 rounded-r">
          <div className="font-[var(--font-playfair)] text-base font-bold mb-1">
            This panel failed to render
          </div>
          <p className="text-[11.5px] text-text-secondary mb-3">
            The rest of the portal is unaffected — switch tabs to carry on.
          </p>
          <pre className="text-[10.5px] bg-bg-secondary p-2.5 rounded overflow-x-auto whitespace-pre-wrap">
            {error.message}
          </pre>
          {info && (
            <details className="mt-2">
              <summary className="text-[10px] uppercase tracking-wider text-text-secondary cursor-pointer">
                Component stack
              </summary>
              <pre className="text-[10px] bg-bg-secondary p-2.5 rounded overflow-x-auto mt-1.5 whitespace-pre-wrap">
                {info.trim()}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
