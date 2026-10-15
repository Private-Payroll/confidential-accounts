import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Identity } from 'midnight-identity/keys/derivation';
import type { CommitteeKeyOnTheWire, CommitteeRequest } from 'midnight-identity/profile/request';
import type { AccountAddress } from 'midnight-identity/profile/company-label';
import type { Channel } from 'midnight-identity/profile/channel';
import {
  CommitteeSignError, committeeChangeShown, committeeJoinFor, committeeSignaturesFor, contractsToRead,
} from 'midnight-identity/profile/committee-sign';
import type { ChainRead, CommitteeChangeShown, CommitteeSigningLedger } from 'midnight-identity/profile/committee-sign';
import { contractsOnChain, fromIndexerAt } from '../chain/company-label-on-chain.js';
import { INDEXER_HTTP_URL } from '../config.js';
import { CompanyOnChain, accountCarriesTheLabel, liveLabelReader, useCompanyCheck } from './company-on-chain.js';
import type { LabelReader } from './company-on-chain.js';
import { Button, Section } from 'vaults-ui';
import { StatusAlert } from '../components/status.js';
import { hrefOf } from '../routes.js';
import type { Consent } from '../framing.js';

/**
 * THE SCREEN FOR A PAGE ASKING THIS WALLET TO SIGN A CHANGE TO WHO HOLDS A
 * COMPANY'S RULES.
 *
 * **THE ONE SCREEN THAT SIGNS WITH A COMMITTEE KEY**, for each of the three
 * presses a committee ask can be: a hand-over, a change of the super admins,
 * and a joining key's own signature over such a change. Before anything is
 * shown it reads, at this wallet's own indexer, the company's account and
 * every contract the ask names - who holds each, its counter, and the account
 * a vault is pinned to - and works out from that, never from the page's word,
 * who joins, who leaves and the thresholds (`committeeChangeShown`). The press
 * signs exactly what is shown and nothing else.
 *
 * **AND IT SIGNS NOTHING UNTIL IT HAS READ THE COMPANY'S ACCOUNT ITSELF** and
 * found the label the page names on the account the page names
 * (`company-on-chain.tsx`): the key it signs with is derived from that label,
 * and the fingerprint the person compares covers the label and the account
 * together.
 */

/** The live ledger, loaded when the screen is. */
export const liveCommitteeLedger = async (): Promise<CommitteeSigningLedger> =>
  (await import('@midnightntwrk/ledger-v9')) as unknown as CommitteeSigningLedger;

/** Reads the contracts a committee ask names, at the indexer this wallet reads its own balance from. */
export type ChainReader = (account: AccountAddress, addresses: readonly string[]) => Promise<ChainRead>;
export const liveChainReader: ChainReader = (account, addresses) => contractsOnChain(account, addresses, fromIndexerAt(INDEXER_HTTP_URL));

type Stage =
  | { of: 'reading' }
  | { of: 'ready'; shown: CommitteeChangeShown; ledger: CommitteeSigningLedger; chain: ChainRead }
  | { of: 'refused'; says: string }
  | { of: 'sent'; at: number; shown: CommitteeChangeShown };

const keyText = (k: CommitteeKeyOnTheWire): string => `${k.value.slice(0, 12)}…${k.value.slice(-8)}`;

export function ApproveCommittee({
  request, identity, channel, consent, whoIsAsking, onDecline,
  ledger = liveCommitteeLedger, now = Date.now, readLabel = liveLabelReader, readChain = liveChainReader,
}: {
  readonly request: CommitteeRequest;
  readonly identity: Identity;
  readonly channel: Channel | null;
  readonly consent: Consent;
  readonly whoIsAsking: ReactNode;
  readonly onDecline: () => void;
  readonly ledger?: () => Promise<CommitteeSigningLedger>;
  readonly now?: () => number;
  readonly readLabel?: LabelReader;
  readonly readChain?: ChainReader;
}): ReactNode {
  const [stage, setStage] = useState<Stage>({ of: 'reading' });
  const check = useCompanyCheck(request.company, request.account, readLabel);
  const onChain = accountCarriesTheLabel(check, request.company);

  useEffect(() => {
    let alive = true;
    setStage({ of: 'reading' });
    void Promise.all([ledger(), readChain(request.account, contractsToRead(request))]).then(([L, chain]) => {
      if (!alive) return;
      try {
        setStage({ of: 'ready', shown: committeeChangeShown(L, identity, request, chain), ledger: L, chain });
      } catch (e) {
        setStage({ of: 'refused', says: e instanceof CommitteeSignError ? e.message : 'Nothing has been signed.' });
      }
    }, () => {
      if (alive) setStage({ of: 'refused', says: 'This wallet could not load what it needs to check the change. Nothing has been signed. Close this window and try again.' });
    });
    return () => { alive = false; };
  }, [identity, request, ledger, readChain]);

  const sign = useCallback((): void => {
    if (stage.of !== 'ready' || channel === null || !onChain) return;
    try {
      const at = now();
      channel.answer(request.press === 'join'
        ? committeeJoinFor(stage.ledger, identity, request, stage.chain, at)
        : committeeSignaturesFor(stage.ledger, identity, request, stage.chain, at));
      setStage({ of: 'sent', at, shown: stage.shown });
    } catch (e) {
      setStage({ of: 'refused', says: e instanceof Error ? `${e.message}` : 'Nothing has been signed.' });
    }
  }, [stage, channel, identity, request, now, onChain]);

  const isMine = (k: CommitteeKeyOnTheWire, shown: CommitteeChangeShown): boolean => k.value === shown.mine.value;
  const keyList = (keys: readonly CommitteeKeyOnTheWire[], shown: CommitteeChangeShown, attr: string) => (
    <ul className="m-0 list-disc ps-6" {...{ [attr]: true }}>
      {keys.map((k) => (
        <li key={k.value} className="font-mono text-sm">{keyText(k)}{isMine(k, shown) ? ' (your key)' : ''}</li>
      ))}
    </ul>
  );

  const change = useMemo(() => (stage.of === 'ready' || stage.of === 'sent' ? stage.shown : null), [stage]);

  if (stage.of === 'sent') {
    return (
      <>
        <h1 data-signed-heading>{`You signed a change to who holds this company's rules, for ${request.requester.origin}`}</h1>
        <p className="lede" data-signed>
          {stage.shown.press === 'join'
            ? `On ${new Date(stage.at).toLocaleString()} this wallet signed the change with your key, to show you hold it, and handed the signature back. `
            : `On ${new Date(stage.at).toLocaleString()} this wallet signed the change on ${stage.shown.contracts.length} contract${stage.shown.contracts.length === 1 ? '' : 's'} and handed the signatures back. `}
          The change takes effect on a contract only once the chain shows that contract held by the new committee. A change
          can reach the chain and still leave the committee as it was. Until the chain shows it, nothing has changed.
        </p>
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>&larr; Your wallet</a></p>
      </>
    );
  }

  return (
    <>
      <h1 data-headline>{`Change who holds a company's rules, for ${request.requester.origin}`}</h1>
      {stage.of === 'reading' && <p className="lede" data-reading>Reading what the page sent, and who holds each contract on the chain. Nothing has been signed.</p>}
      {stage.of === 'refused' && (
        <StatusAlert tone="danger" title="This wallet will not sign this">
          <p className="m-0" data-committee-refused>{stage.says}</p>
        </StatusAlert>
      )}
      {change !== null && (
        <Section
          list={false} box={false} aria-label="The committee after this change"
          title="The committee after this change"
          description="Worked out by this wallet from what the page sent and what the chain holds. It replaces the whole list of keys on every contract below."
        >
          <p className="m-0 text-foreground text-lg" data-new-threshold>
            {`${change.to.committee.length} key${change.to.committee.length === 1 ? '' : 's'}, and ${change.to.threshold} of them must sign any change to the company's rules.`}
          </p>
          {keyList(change.to.committee, change, 'data-new-committee')}
          <p className="m-0 text-sm text-muted-foreground" data-list-is-what-holds>
            Who holds each contract now was read from the chain by this wallet, not taken from the page. The list above
            is what every contract will hold. Anyone not on it loses their place.
          </p>
          {change.press === 'hand-over' && (
            <p className="m-0 text-sm" data-hand-over>
              This brings each contract below to the committee that holds the company&rsquo;s account on the chain. No key
              joins the company this way.
            </p>
          )}
          {change.press === 'super-admins' && (
            <p className="m-0 text-sm" data-joins-signed>
              Every key this change puts on a contract below has signed the change with its own key, and this wallet
              checked each of those signatures.
            </p>
          )}
          {change.press === 'join' && (
            <p className="m-0 text-sm" data-joining>
              Your key is one this change puts on the company&rsquo;s contracts. Signing says you hold it. Nothing changes
              until enough of the super admins who hold each contract sign it too.
            </p>
          )}
          {!change.staysOn && (
            <StatusAlert tone="warning" role={null} title="Your own key leaves">
              <p className="m-0" data-you-leave>
                Your key is not on the new committee. Once this change reaches the chain, you can no longer sign any
                change to this company&rsquo;s rules.
              </p>
            </StatusAlert>
          )}
        </Section>
      )}
      {change !== null && change.contracts.map((c) => (
        <Section
          list={false} box={false}
          key={c.address}
          aria-label={c.contract === 'account' ? 'The company account' : 'A vault'}
          title={c.contract === 'account' ? 'The company account' : 'A vault'}
          description={`The chain shows ${c.keysNow} key${c.keysNow === 1 ? '' : 's'} hold${c.keysNow === 1 ? 's' : ''} this contract now and ${c.thresholdNow} of them must sign. After this change, only the keys listed above hold it, and ${c.thresholdAfter} of them must sign.`}
        >
          <p className="m-0 font-mono break-all text-sm text-muted-foreground" data-contract={c.contract}>{c.address}</p>
          <p className="m-0 text-sm" data-threshold-change>{`Threshold: ${c.thresholdNow} before, ${c.thresholdAfter} after.`}</p>
          <p className="m-0 text-sm text-muted-foreground">Joining: on the new list and not on this contract on the chain</p>
          {c.joins.length === 0 ? <p className="m-0 text-sm" data-joins-none>Nobody.</p> : keyList(c.joins, change, 'data-joins')}
          <p className="m-0 text-sm text-muted-foreground">Leaving: on this contract on the chain and not on the new list. They lose their place.</p>
          {c.leaves.length === 0 ? <p className="m-0 text-sm" data-leaves-none>Nobody.</p> : keyList(c.leaves, change, 'data-leaves')}
        </Section>
      ))}
      <Section list={false} box={false} aria-label="The company, as the page names it" title="The company, as the page names it" description="This wallet signs with the key it holds for this company and no other.">
        <CompanyOnChain
          label={request.company} account={request.account} check={check} doing="signed"
          compareWith="the person who invited you to this company gave you themselves, and not through this page"
        />
        <p className="m-0 text-sm text-muted-foreground">
          This wallet cannot tell who each key belongs to. Check the new list with the other super admins before you sign.
          Whoever holds enough of its keys can change the rules the company account and every vault follow.
        </p>
      </Section>
      {whoIsAsking}
      <div className="flex flex-wrap gap-2">
        <Button
          size="lg"
          type="button"
          variant="default" onClick={sign} data-approve data-sign-committee
          disabled={!consent.ok || stage.of !== 'ready' || channel === null || !onChain}
        >
          Sign this change
        </Button>
        <Button size="lg" type="button" variant="ghost" data-decline onClick={onDecline}>
          Do not sign
        </Button>
      </div>
    </>
  );
}
