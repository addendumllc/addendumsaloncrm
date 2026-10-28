import { Component, type ReactNode } from 'react';
import { buttonClass } from '../ui';

/**
 * If a page fails while drawing, say so (with the error, to pass on) instead of leaving a blank screen. Moving to
 * another page resets it (`resetKey`).
 */
export class PageErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('[page error]', error); }
  componentDidUpdate(prev: { resetKey: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel mx-auto mt-10 max-w-lg p-6 text-center">
        <h1 className="h-display text-[26px]">This page hit a problem</h1>
        <p className="mt-2 text-[14px] text-stone">Reload to try again. If it keeps happening, send this to whoever looks after the CRM:</p>
        <p className="mt-3 break-words rounded-lg bg-mist px-3 py-2 font-mono text-[12px] text-ink-soft">{this.state.error.message}</p>
        <button type="button" className={buttonClass('primary', 'md', 'mt-4')} onClick={() => window.location.reload()}><span className="btn-label">Reload</span></button>
      </div>
    );
  }
}
