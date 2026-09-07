import type { ReactNode } from 'react';
import { hrefOf } from '../routes.js';

/** A stale or mistyped link gets told so — never a silent fall-through to home. */
export function NotFound({ path }: { readonly path: string }): ReactNode {
  return (
    <>
      <h1>There&rsquo;s nothing at <span className="mono">{path}</span>.</h1>
      <p className="muted">
        The link may be stale, or mistyped. Nothing about your wallet has changed.
      </p>
      <p><a href={hrefOf('home')}>← Back to your wallet</a></p>
    </>
  );
}
