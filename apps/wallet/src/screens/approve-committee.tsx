import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Identity } from 'midnight-identity/keys/derivation';
import type { CommitteeKeyOnTheWire, CommitteeRequest } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import {
  CommitteeSignError, committeeChangeShown, committeeSignaturesFor,
} from 'midnight-identity/profile/committee-sign';
import type { CommitteeChangeShown, CommitteeSigningLedger } from 'midnight-identity/profile/committee-sign';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import { Alert, Button, Section } from '../kit/index.js';
import { hrefOf } from '../routes.js';
import type { Consent } from '../framing.js';

/**
 * THE SCREEN FOR A PAGE ASKING THIS WALLET TO SIGN A CHANGE TO WHO HOLDS A
 * COMPANY'S RULES.
 *
 * **THE ONE SCREEN THAT SIGNS WITH A COMMITTEE KEY.** It shows, worked out by
 * this wallet from the ask and from the person's own key: the committee that
 * will hold the company's contracts, who joins it, who leaves it, the threshold
 * before and after, and every contract the change is signed for. The press
 * signs exactly that change and nothing else; the wallet builds what it signs
 * from what is on this screen.
 */

/** The live ledger, loaded when the screen is. */
export const liveCommitteeLedger = async (): Promise<CommitteeSigningLedger> =>
  (await import('@midnightntwrk/ledger-v9')) as unknown as CommitteeSigningLedger;

type Stage =
  | { of: 'reading' }
  | { of: 'ready'; shown: CommitteeChangeShown; ledger: CommitteeSigningLedger }
  | { of: 'refused'; says: string }
  | { of: 'sent'; at: number; shown: CommitteeChangeShown };

const keyText = (k: CommitteeKeyOnTheWire): string => `${k.value.slice(0, 12)}…${k.value.slice(-8)}`;

export function ApproveCommittee({
  request, identity, channel, consent, whoIsAsking, onDecline,
  ledger = liveCommitteeLedger, now = Date.now,
}: {
  readonly request: CommitteeRequest;
  readonly identity: Identity;
  readonly channel: Channel | null;
  readonly consent: Consent;
  readonly whoIsAsking: ReactNode;
  readonly onDecline: () => void;
  readonly ledger?: () => Promise<CommitteeSigningLedger>;
  readonly now?: () => number;
}): ReactNode {
  const [stage, setStage] = useState<Stage>({ of: 'reading' });

  useEffect(() => {
    let alive = true;
    setStage({ of: 'reading' });
    let shown: CommitteeChangeShown;
    try {
      shown = committeeChangeShown(identity, request);
    } catch (e) {
      setStage({ of: 'refused', says: e instanceof CommitteeSignError ? e.message : 'Nothing has been signed.' });
      return () => { alive = false; };
    }
    void ledger().then((L) => { if (alive) setStage({ of: 'ready', shown, ledger: L }); },
      () => { if (alive) setStage({ of: 'refused', says: 'This wallet could not load what it needs to build the change. Nothing has been signed. Close this window and try again.' }); });
    return () => { alive = false; };
  }, [identity, request, ledger]);

  const sign = useCallback((): void => {
    if (stage.of !== 'ready' || channel === null) return;
    try {
      const at = now();
      channel.answer(committeeSignaturesFor(stage.ledger, identity, request, at));
      setStage({ of: 'sent', at, shown: stage.shown });
    } catch (e) {
      setStage({ of: 'refused', says: e instanceof Error ? `${e.message}` : 'Nothing has been signed.' });
    }
  }, [stage, channel, identity, request, now]);

  const isMine = (k: CommitteeKeyOnTheWire, shown: CommitteeChangeShown): boolean => k.value === shown.mine.value;
  const keyList = (keys: readonly CommitteeKeyOnTheWire[], shown: CommitteeChangeShown, attr: string) => (
    <ul className="m-0" {...{ [attr]: true }}>
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
          {`On ${new Date(stage.at).toLocaleString()} this wallet signed the change on ${stage.shown.contracts.length} contract${stage.shown.contracts.length === 1 ? '' : 's'} and handed the signatures back. `}
          The change takes effect on a contract once enough of the signers who hold it now have signed and it reaches
          the chain. Until then nothing has changed.
        </p>
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>&larr; Your wallet</a></p>
      </>
    );
  }

  return (
    <>
      <h1 data-headline>{`Change who holds a company's rules, for ${request.requester.origin}`}</h1>
      {stage.of === 'reading' && <p className="lede" data-reading>Reading what the page sent. Nothing has been signed.</p>}
      {stage.of === 'refused' && (
        <Alert tone="danger" title="This wallet will not sign this">
          <p className="m-0" data-committee-refused>{stage.says}</p>
        </Alert>
      )}
      {change !== null && (
        <Section
          title="The committee after this change"
          description="Worked out by this wallet from what the page sent. It replaces the whole list of keys on every contract below."
        >
          <p className="m-0 text-ink text-lg" data-new-threshold>
            {`${request.to.committee.length} key${request.to.committee.length === 1 ? '' : 's'}, and ${request.to.threshold} of them must sign any change to the company's rules.`}
          </p>
          {keyList(request.to.committee, change, 'data-new-committee')}
          <p className="m-0 text-sm text-muted" data-list-is-what-holds>
            This wallet cannot check who holds each contract now. The list above is what every contract will hold.
            Anyone not on it loses their seat.
          </p>
          {!change.staysOn && (
            <Alert tone="warning" role={null} title="Your own key leaves">
              <p className="m-0" data-you-leave>
                Your key is not on the new committee. Once this change reaches the chain, you can no longer sign any
                change to this company&rsquo;s rules.
              </p>
            </Alert>
          )}
        </Section>
      )}
      {change !== null && change.contracts.map((c) => (
        <Section
          key={c.address}
          title={c.contract === 'account' ? 'The company account' : 'A vault'}
          description={`The page says ${c.keysNow} key${c.keysNow === 1 ? '' : 's'} hold${c.keysNow === 1 ? 's' : ''} this contract now and ${c.thresholdNow} of them must sign. After this change, only the keys listed above hold it, and ${c.thresholdAfter} of them must sign.`}
        >
          <p className="m-0 font-mono break-all text-sm text-muted" data-contract={c.contract}>{c.address}</p>
          <p className="m-0 text-sm" data-threshold-change>{`Threshold: ${c.thresholdNow} before, ${c.thresholdAfter} after.`}</p>
          <p className="m-0 text-sm text-muted">Joining: on the new list and, the page says, not on this contract now</p>
          {c.joins.length === 0 ? <p className="m-0 text-sm" data-joins-none>Nobody, the page says.</p> : keyList(c.joins, change, 'data-joins')}
          <p className="m-0 text-sm text-muted">Leaving: on this contract now, the page says, and not on the new list. They lose their seat.</p>
          {c.leaves.length === 0 ? <p className="m-0 text-sm" data-leaves-none>Nobody, the page says.</p> : keyList(c.leaves, change, 'data-leaves')}
        </Section>
      ))}
      <Section title="The company, as the page names it" description="This wallet signs with the key it holds for this company and no other.">
        <p className="m-0 font-mono tracking-wide text-ink text-xl" data-company-fingerprint>{companyFingerprint(request.company)}</p>
        <p className="m-0 font-mono break-all text-sm text-muted" data-company>{request.company}</p>
        <p className="m-0 text-sm text-muted">
          This wallet cannot tell who each key belongs to. Check the new list with the other signers before you sign.
          Whoever holds enough of its keys can change the rules the company account and every vault follow.
        </p>
      </Section>
      {whoIsAsking}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary" onClick={sign} data-approve data-sign-committee
          disabled={!consent.ok || stage.of !== 'ready' || channel === null}
        >
          Sign this change
        </Button>
        <Button variant="ghost" data-decline onClick={onDecline}>
          Do not sign
        </Button>
      </div>
    </>
  );
}
