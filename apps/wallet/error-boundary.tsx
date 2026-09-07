import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { describeFailure } from './failure-text.js';

/**
 * A FAILURE WHILE DRAWING MUST BE VISIBLE. The old harness learned this the
 * hard way — it presented as `Buffer is not defined`, thrown mid-render
 * and shown to nobody, a wallet that looked like it had simply stopped. React
 * unmounts the tree on an uncaught render error, which is the same blank
 * page with more steps; this boundary is the root-level catch that turns it
 * into a sentence, a reassurance, and a way to try again.
 */

interface Caught {
  readonly error: unknown;
}

export class ErrorBoundary extends Component<{ readonly children: ReactNode }, Caught> {
  constructor(props: { readonly children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: unknown): Caught {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    /* The sentence above is for a person; the stack is for whoever fixes it. */
    console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="shell">
        <main className="content narrow">
          <h1>Something broke while drawing this page.</h1>
          <div className="error" role="alert">{describeFailure(this.state.error)}</div>
          <p className="muted" style={{ marginTop: '1rem' }}>
            Your account has not been touched — nothing stored in this browser changed.
            The browser console has the full trace.
          </p>
          <button
            type="button"
            className="primary"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </main>
      </div>
    );
  }
}
