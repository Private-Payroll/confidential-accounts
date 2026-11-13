import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import type { Identity } from 'midnight-identity/keys/derivation';
import type { SuperAdminRequestAsk } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import { committeeRequestFor, type CommitteeSigningLedger } from 'midnight-identity/profile/committee-sign';
import { CompanyOnChain, accountCarriesTheLabel, liveLabelReader, useCompanyCheck } from './company-on-chain.js';
import type { LabelReader } from './company-on-chain.js';
import { Button, Section } from 'vaults-ui';
import { StatusAlert } from '../components/status.js';
import { hrefOf } from '../routes.js';
import type { Consent } from '../framing.js';

/*
 * A super admin's request to the company's service: one press signs, with this wallet's key for the company, that
 * the person signed in at the service asks as a super admin of this company. It changes no contract; the service
 * lets the request in only while the key holds the company's account on the chain, or joins it in a change kept
 * there. The press is offered only once this wallet has read that the account carries the company's label.
 */
export function ApproveSuperAdminRequest({
  request, identity, channel, consent, whoIsAsking, onDecline, ledger, now = Date.now, readLabel = liveLabelReader,
}: {
  readonly request: SuperAdminRequestAsk;
  readonly identity: Identity;
  readonly channel: Channel | null;
  readonly consent: Consent;
  readonly whoIsAsking: ReactNode;
  readonly onDecline: () => void;
  readonly ledger: () => Promise<Pick<CommitteeSigningLedger, 'signData'>>;
  readonly now?: () => number;
  readonly readLabel?: LabelReader;
}): ReactNode {
  const [stage, setStage] = useState<{ of: 'asking' } | { of: 'refused'; says: string } | { of: 'sent'; at: number }>({ of: 'asking' });
  const check = useCompanyCheck(request.company, request.account, readLabel);
  const onChain = accountCarriesTheLabel(check, request.company);

  const sign = useCallback((): void => {
    if (channel === null || !onChain) return;
    void ledger().then((L) => {
      const at = now();
      channel.answer(committeeRequestFor(L, identity, request, at));
      setStage({ of: 'sent', at });
    }, () => {
      setStage({ of: 'refused', says: 'This wallet could not load what it needs to sign. Nothing has been signed. Close this window and try again.' });
    }).catch((e: unknown) => {
      setStage({ of: 'refused', says: e instanceof Error ? e.message : 'Nothing has been signed.' });
    });
  }, [channel, onChain, ledger, now, identity, request]);

  if (stage.of === 'sent') {
    return (
      <>
        <h1 data-signed-heading>{`You signed a request as a super admin, for ${request.requester.origin}`}</h1>
        <p className="lede" data-request-signed>
          {`On ${new Date(stage.at).toLocaleString()} this wallet signed the request with your key for this company and handed it back. `}
          It changes no contract. The company&rsquo;s service lets the request in only while the chain shows your key holding the
          company&rsquo;s account, or joining it in a change kept there.
        </p>
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>&larr; Your wallet</a></p>
      </>
    );
  }

  return (
    <>
      <h1 data-headline>{`Act as a super admin of a company, for ${request.requester.origin}`}</h1>
      {stage.of === 'refused' && (
        <StatusAlert tone="danger" title="This wallet will not sign this">
          <p className="m-0" data-committee-refused>{stage.says}</p>
        </StatusAlert>
      )}
      <Section list={false} box={false} aria-label="What you sign" title="What you sign">
        <p className="m-0 text-sm" data-request-what>
          This signs, with your key for the company below, a standing request that this site&rsquo;s service can use for as
          long as you are signed in there. It also tells the service which key is yours. It changes no contract and moves no
          money. The service still checks your key against who holds the company&rsquo;s account on the chain.
        </p>
        <p className="m-0 text-sm text-muted-foreground break-all" data-request-for>
          {`For the person signed in at ${request.requester.origin} as ${request.user}, about the company that site records as ${request.record}, and its account below.`}
        </p>
      </Section>
      <Section list={false} box={false} aria-label="The company, as the page names it" title="The company, as the page names it" description="This wallet signs with the key it holds for this company and no other.">
        <CompanyOnChain
          label={request.company} account={request.account} check={check} doing="signed"
          compareWith="the super admin who sent you the link gave you themselves, and not through this page"
        />
      </Section>
      {whoIsAsking}
      <div className="flex flex-wrap gap-2">
        <Button
          size="lg" type="button" variant="default" onClick={sign} data-approve data-sign-request
          disabled={!consent.ok || channel === null || !onChain}
        >
          Sign this request
        </Button>
        <Button size="lg" type="button" variant="ghost" data-decline onClick={onDecline}>
          Do not sign
        </Button>
      </div>
    </>
  );
}
