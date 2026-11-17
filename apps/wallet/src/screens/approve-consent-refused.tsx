/*
 * The sentence beside a disabled press, saying what would make the press possible. It draws nothing when the press is allowed.
 */
import type { ReactNode } from 'react';
import type { Consent } from '../framing.js';

/**
 * **WHY A PRESS IS REFUSED, BESIDE THE BUTTON IT REFUSES.** A disabled button
 * with no sentence is a page that looks broken; this names what would make the
 * press possible. It renders nothing when the press is allowed.
 */
export function ConsentRefused({ consent }: { readonly consent: Consent }): ReactNode {
  if (consent.ok) return null;
  return (
    <p className="m-0 w-full text-sm text-muted-foreground" data-consent-refused>
      {consent.says.charAt(0).toUpperCase() + consent.says.slice(1)}
    </p>
  );
}
