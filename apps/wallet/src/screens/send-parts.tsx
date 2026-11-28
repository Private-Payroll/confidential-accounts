import type { ReactNode } from 'react';
import type { Recipient, SendFacts } from '../chain/send.js';

/**
 * HOW LONG A PROOF USUALLY TAKES — ONE CONSTANT, AND IT IS COPY RATHER THAN
 * DESIGN.
 *
 * THE RULE: *"Where a duration is stated, it comes from one named
 * constant with a comment saying it is a laptop measurement and phones are
 * unmeasured. When the number lands it is one edit."*
 *
 * **74 SECONDS IS A MEASUREMENT AND IT IS A LAPTOP'S** — a real
 * plain-transfer proof in a real browser, on a laptop. **A PHONE HAS NEVER
 * BEEN MEASURED.** The SDK's prover is single-threaded WASM and a phone is
 * plausibly three to five times this, which is why the decision was to build
 * this screen for the WORST CASE and let the number arrive later.
 * The design below is the same design at fifteen
 * seconds and at six minutes; when somebody finally points the probe at a
 * phone, this line is the edit.
 */
export const PROVING_USUALLY_MS = 74_000;

export const asClock = (forMs: number): string => {
  const seconds = Math.floor(forMs / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
};

export const kindWords = (recipient: Recipient): string =>
  recipient.kind === 'shielded'
    ? 'a SHIELDED address — a private payment; the amount and the parties stay ' + 'hidden on the chain'
    : 'an UNSHIELDED address — an ordinary NIGHT transfer, visible on the chain';

/**
 * A REFUSAL, VERBATIM. `role="alert"` is the fact and the colour follows it —
 * the same discipline the kit's fields follow for `aria-invalid`.
 *
 * IT IS WRITTEN HERE RATHER THAN TAKEN FROM `StatusAlert`, FOR ONE REASON
 * WORTH NAMING: the engine's refusal message is asserted CHARACTER FOR
 * CHARACTER by `send-screen.test.tsx`, so the element carrying `role="alert"`
 * has to contain that message and nothing else — no icon, no title, nothing
 * decorative with a text node in it.
 */
export function Refusal({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div
      role="alert"
      className={[
        'mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2',
        'text-sm break-words text-destructive'
      ].join(' ')}
    >
      {children}
    </div>
  );
}

/**
 * BYTES SOMEBODY MAY HAVE TO COMPARE OR PASTE — an address, a transaction
 * identifier. `select-all` so one click takes the whole thing rather than a
 * word out of the middle of it.
 */
export function Bytes({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div
      className={[
        'my-2 rounded-md border border-border bg-muted px-3 py-2',
        'font-mono text-xs leading-relaxed break-all text-muted-foreground select-all'
      ].join(' ')}
    >
      {children}
    </div>
  );
}

export const shortUnshieldedOrPayee = (facts: SendFacts): string => {
  const at = facts.recipientBech32.lastIndexOf('1');
  const payload = at > 0 ? facts.recipientBech32.slice(at + 1) : facts.recipientBech32;
  const network = at > 0 ? facts.recipientBech32.slice(0, at + 1) : '';
  return `${network}${payload.slice(0, 8)}…${payload.slice(-8)}`;
};
