import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Card, CardContent, Section } from 'vaults-ui';

import { loadTermsSeen, recordTermsSeen } from '../chain/terms.js';
import { describeFailure } from '../lib/failure-text.js';

/** The network's terms, shown once on the first live send screen and never blocking a send, even when the fetch fails.
 * The fetch is an indexer call, so it is made only here, on a screen a person opened to send money. */
export function TermsCard({
  fetchTerms
}: {
  readonly fetchTerms: (() => Promise<{ hash: string; url: string }>) | null;
}): ReactNode {
  type TermsState =
    | { readonly name: 'already-seen' }
    | { readonly name: 'fetching' }
    | { readonly name: 'show'; readonly hash: string; readonly url: string }
    | { readonly name: 'failed'; readonly message: string };
  const [state, setState] = useState<TermsState>(() =>
    loadTermsSeen() !== null ? { name: 'already-seen' } : { name: 'fetching' }
  );
  useEffect(() => {
    if (state.name !== 'fetching' || !fetchTerms) return undefined;
    let stale = false;
    fetchTerms()
      .then((terms) => {
        if (stale) return;
        recordTermsSeen(terms);
        setState({ name: 'show', hash: terms.hash, url: terms.url });
      })
      .catch((e: unknown) => {
        if (stale) return;
        setState({ name: 'failed', message: describeFailure(e) });
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once: 'fetching' is only ever the initial state.
  }, []);
  if (state.name === 'already-seen' || !fetchTerms) return null;
  return (
    <Section list={false} box={false} aria-label="The network’s terms" title={<>The network&rsquo;s terms</>}>
      <Card>
        <CardContent className="flex flex-col gap-3">
          {state.name === 'fetching' && (
            <p className="m-0 text-sm text-muted-foreground" role="status">
              Asking the indexer for the network&rsquo;s current terms and conditions… Sending is not blocked by this.
            </p>
          )}
          {state.name === 'show' && (
            <>
              <p className="m-0 text-sm text-muted-foreground">
                The network publishes terms and conditions that wallets are expected to show once. They are at{' '}
                <a
                  className="text-primary underline-offset-4 hover:underline"
                  href={state.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {state.url}
                </a>
                . This is the network&rsquo;s expectation, not a gate of this wallet&rsquo;s: nothing about sending is
                blocked by it.
              </p>
              <p className="m-0 text-xs text-muted-foreground">
                Their fingerprint (SHA-256), recorded in this browser so this card is not shown again:{' '}
                <span className="font-mono break-all">{state.hash}</span>
              </p>
            </>
          )}
          {state.name === 'failed' && (
            <p className="m-0 text-xs text-muted-foreground" role="status">
              The network&rsquo;s terms could not be fetched right now ({state.message}). Sending is not blocked; they
              will be shown when they next can be.
            </p>
          )}
        </CardContent>
      </Card>
    </Section>
  );
}
