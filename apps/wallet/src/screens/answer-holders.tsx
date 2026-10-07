import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { HoldersRequest } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import { RecordsKeyRefused, holdersAnswerFor, type AccountHolders } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { deployFromIndexerAt, fromIndexerAt, holdersOnChain, type HoldersOnChain } from '../chain/company-label-on-chain.js';
import { INDEXER_HTTP_URL } from '../config.js';
import { StatusAlert } from '../components/status.js';
import type { Consent } from '../framing.js';

/**
 * THE WALLET ANSWERING WHO HOLDS A COMPANY'S ACCOUNT, WITH NO PRESS.
 *
 * A page about to believe a record the company's server hands it asks who
 * holds the account now: the committee and its threshold, the account's own
 * approval threshold, the seats it holds and the vaults it has adopted.
 * **Everything in the answer is public on the chain and nothing is
 * signed**, so this wallet reads it over its own connection to the network and
 * answers as soon as the read is in, without asking the person to press
 * anything. What it hands back is what this wallet read, never what the page
 * or its server said.
 *
 * It answers only an ask whose framing passes the same checks as every other
 * (`consent`), and only when the account carries the company's label.
 */

/** How this screen reads the account. Replaceable so a test can answer. */
export type HoldersReader = (account: AccountAddress, label: CompanyLabel) => Promise<HoldersOnChain>;

export const liveHoldersReader: HoldersReader = (account, label) => holdersOnChain(
  account, label, fromIndexerAt(INDEXER_HTTP_URL), deployFromIndexerAt(INDEXER_HTTP_URL));

type Stage = { of: 'reading' } | { of: 'sent' } | { of: 'refused'; says: string };

/** Why the read gives no answer, in the person's words. */
const why = (read: HoldersOnChain): string => (read.of === 'no-account'
  ? 'There is no company account at the address the page names.'
  : read.of === 'other-label'
    ? 'The account the page names is not this company’s.'
    : 'This wallet could not read the company’s account from the network. Try again in a minute.');

export function AnswerHolders({
  request, channel, consent, now = Date.now, readHolders = liveHoldersReader,
}: {
  readonly request: HoldersRequest;
  readonly channel: Channel | null;
  readonly consent: Consent;
  readonly now?: () => number;
  readonly readHolders?: HoldersReader;
}): ReactNode {
  const [stage, setStage] = useState<Stage>({ of: 'reading' });
  /* The request this screen has already answered or refused: a page is answered once, however often consent changes. */
  const settled = useRef<HoldersRequest | null>(null);
  const allowed = consent.ok;
  useEffect(() => {
    if (!allowed || channel === null || settled.current === request) return undefined;
    let alive = true;
    void (async () => {
      const read = await readHolders(request.account, request.company);
      if (!alive) return;
      if (read.of !== 'read') {
        settled.current = request;
        channel.refuse('unreadable');
        setStage({ of: 'refused', says: why(read) });
        return;
      }
      settled.current = request;
      try {
        const sent = channel.answer(holdersAnswerFor(request, read.holders as AccountHolders, now()));
        setStage(sent === false
          ? { of: 'refused', says: 'This page had already been answered, so nothing more was sent.' }
          : { of: 'sent' });
      } catch (e) {
        channel.refuse('unreadable');
        setStage({ of: 'refused', says: e instanceof RecordsKeyRefused ? e.message : 'Nothing has been handed back.' });
      }
    })();
    return () => { alive = false; };
  }, [allowed, channel, request, readHolders, now]);

  /* Before anything is answered, a page this wallet will not answer yet is said plainly; nothing is asked of the person. */
  if (!consent.ok && stage.of === 'reading') {
    return (
      <p className="m-0 text-sm text-muted-foreground" data-holders-waiting>
        {consent.says.charAt(0).toUpperCase() + consent.says.slice(1)}
      </p>
    );
  }
  if (stage.of === 'refused') {
    return (
      <StatusAlert tone="danger" title="This wallet could not say who holds the company">
        <p className="m-0" data-holders-refused>{stage.says}</p>
      </StatusAlert>
    );
  }
  return (
    <p className="m-0 text-sm text-muted-foreground" data-holders={stage.of}>
      {stage.of === 'sent'
        ? 'This wallet told the page who holds the company’s account, as it read it from the network. Nothing was signed.'
        : 'Reading who holds the company’s account from the network…'}
    </p>
  );
}
