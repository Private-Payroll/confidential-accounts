import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { hrefOf } from '../routes.js';

/**
 * **WHAT THE WALLET SAYS ONCE A REQUEST HAS BEEN ANSWERED AND NOTHING MORE IS
 * COMING** - after Close, Do not pay, Do not show them or any other answer
 * that leaves nothing on screen. Saying it is still waiting for the request
 * would be false: the page has its answer, and this window will not be asked
 * again. Focus moves to the heading, so a person using a keyboard or a screen
 * reader is told where they are rather than left on the page's body.
 */
export function AskOver({ framed }: { readonly framed: boolean }): ReactNode {
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <>
      <h1 ref={heading} tabIndex={-1} data-ask-over>This request is finished</h1>
      <p className="lede">
        The page has had its answer, and nothing more will be asked in this window.
      </p>
      <p className="m-0 text-sm text-muted-foreground">
        {framed
          ? 'The page around this wallet will carry on from here.'
          : 'You can close this window.'}
      </p>
      {!framed && <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>&larr; Your wallet</a></p>}
    </>
  );
}
