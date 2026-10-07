import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Identity } from 'midnight-identity/keys/derivation';
import type { JoinCodeRequest } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import { JoinCodeRefused, joinCodeAnswerFor, whyNoJoinCode } from 'midnight-identity/profile/join-code';
import { payeeCodeFingerprint, seatKeyFingerprint } from 'midnight-identity/profile/fingerprint';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { Button, Section } from 'vaults-ui';
import { StatusAlert } from '../components/status.js';
import { CopyButton } from '../components/ui.js';
import { hrefOf } from '../routes.js';
import type { Consent } from '../framing.js';
import { CompanyOnChain, accountCarriesTheLabel, liveLabelReader, useCompanyCheck } from './company-on-chain.js';
import type { LabelReader } from './company-on-chain.js';

/**
 * THE SCREEN FOR A PAGE ASKING THIS WALLET TO MAKE A CODE FOR JOINING A
 * COMPANY.
 *
 * The person gives the code to somebody already in the company, who pastes it
 * to add them: as a signer, with the public halves of the seat keys their own
 * device has just made, or as a payee, with the address they are paid at and
 * the payslip key this wallet gives for that company. This screen shows the
 * company, the sign-in the code names and the fingerprint of what it carries,
 * and signs all of it with this wallet's key for that company at the press. It
 * signs only an address this wallet receives at and only its own payslip key.
 *
 * **THE FINGERPRINT IS WHAT THE PERSON READS OUT.** Whoever adds them works the
 * same fingerprint out from the code they were given; if somebody swapped the
 * code on the way, the two differ, and they must not go on.
 */

type Stage = { of: 'ready' } | { of: 'refused'; says: string } | { of: 'sent'; at: number };

export function ApproveJoinCode({
  request, identity, channel, consent, whoIsAsking, onDecline, receives, ownPayslipKey, fingerprintClass, now = Date.now,
  readLabel = liveLabelReader,
}: {
  readonly request: JoinCodeRequest;
  readonly identity: Identity;
  readonly channel: Channel | null;
  readonly consent: Consent;
  readonly whoIsAsking: ReactNode;
  readonly onDecline: () => void;
  /** Every address this wallet receives at. */
  readonly receives: readonly string[];
  /** The payslip public key this wallet gives for the company the code names; null when the code is not a payee's. */
  readonly ownPayslipKey: string | null;
  /** How the wallet sets every fingerprint a person compares: the largest thing in its section. */
  readonly fingerprintClass: string;
  readonly now?: () => number;
  /** How the company's account is read off the chain. Replaceable so a test can answer. */
  readonly readLabel?: LabelReader;
}): ReactNode {
  const [stage, setStage] = useState<Stage>({ of: 'ready' });
  /* The account the page names, read off the chain: the company's fingerprint is shown from it, and nothing is signed
   * until it carries the label the code is for. */
  const check = useCompanyCheck(request.company, request.account, readLabel);
  const onChain = accountCarriesTheLabel(check, request.company);
  const parts = request.parts;
  /* The fingerprint the person reads out, shown before the press. */
  const fingerprint = useMemo(
    () => (parts.kind === 'signer' ? seatKeyFingerprint(parts)
      : payeeCodeFingerprint({ committeeKey: committeeKeyFor(identity, request.company), parts })),
    [parts, identity, request.company],
  );
  /* Why this wallet will not sign it: the same sentence the press refuses with. */
  const notOurs = whyNoJoinCode(request, receives, ownPayslipKey);

  const sign = useCallback((): void => {
    /* What this wallet will not sign is refused by `joinCodeAnswerFor` as well as by the button. */
    if (!consent.ok || stage.of !== 'ready' || channel === null || !onChain) return;
    try {
      const at = now();
      channel.answer(joinCodeAnswerFor(identity, request, receives, ownPayslipKey));
      setStage({ of: 'sent', at });
    } catch (e) {
      setStage({ of: 'refused', says: e instanceof JoinCodeRefused ? e.message : 'No code has been made.' });
    }
  }, [consent, stage, channel, onChain, now, identity, request, receives, ownPayslipKey]);

  const fingerprintBox = (
    <div className="mt-1 rounded-md border border-border p-3" data-join-code-fingerprint-box>
      <p className="m-0 text-sm text-muted-foreground">The fingerprint to read to the person adding you</p>
      <p className={`m-0 font-mono ${fingerprintClass} text-foreground`} data-join-code-fingerprint>{fingerprint}</p>
      <CopyButton kit text={fingerprint} label="Copy the fingerprint" copied="Copied the fingerprint" />
    </div>
  );

  if (stage.of === 'sent') {
    return (
      <>
        <h1 data-signed-heading>{`You made a code to join a company, for ${request.requester.origin}`}</h1>
        <p className="lede" data-signed>
          {`On ${new Date(stage.at).toLocaleString()} this wallet signed your code, and the page that asked now has it. Give it to the person adding you, and read them this fingerprint.`}
        </p>
        {fingerprintBox}
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>&larr; Your wallet</a></p>
      </>
    );
  }

  return (
    <>
      <h1 data-headline>{`Make a code to join a company, for ${request.requester.origin}`}</h1>
      {stage.of === 'refused' && (
        <StatusAlert tone="danger" title="This wallet will not make this code">
          <p className="m-0" data-join-code-refused>{stage.says}</p>
        </StatusAlert>
      )}
      <Section
        list={false} box={false} aria-label="What this wallet signs" title="What this wallet signs"
        description="One code, with the key this wallet holds for this company."
      >
        <p className="m-0 text-sm text-foreground" data-join-code-signs>
          {parts.kind === 'signer'
            ? 'That the keys for a seat on this company, as the page names them, are yours. Only their public halves are in the code; their secrets stay on the device that made them.'
            : 'That you are paid at this address, and that your payslips are sealed to the key this wallet gives for this company. Only these are in the code.'}
        </p>
        <p className="m-0 text-sm text-muted-foreground">The company, as the page names it</p>
        <p className="m-0 font-mono break-all text-sm" data-join-code-company>{request.company}</p>
        <p className="m-0 text-sm text-muted-foreground">You, as the page signed you in</p>
        <p className="m-0 font-mono break-all text-sm" data-join-code-person>{request.person}</p>
        {parts.kind === 'payee' && (
          <>
            <p className="m-0 text-sm text-muted-foreground">Where you are paid</p>
            <p className="m-0 font-mono break-all text-sm" data-join-code-address>{parts.address}</p>
          </>
        )}
        {fingerprintBox}
        {notOurs !== null && (
          <StatusAlert tone="danger" role={null} title="This is not yours to sign">
            <p className="m-0" data-join-code-not-yours>{notOurs}</p>
          </StatusAlert>
        )}
      </Section>
      <Section
        list={false} box={false} aria-label="The company, as the page names it" title="The company, as the page names it"
        description="Compare this fingerprint with the one the person adding you sees for the company."
      >
        <CompanyOnChain label={request.company} account={request.account} check={check} fingerprintClass={fingerprintClass} doing="signed"
          compareWith="the person adding you sees for the company, read out to you by a call, a message or in person, and not through this page" />
      </Section>
      {whoIsAsking}
      <div className="flex flex-wrap gap-2">
        <Button
          size="lg" type="button" variant="default" onClick={sign} data-approve data-make-join-code
          disabled={!consent.ok || stage.of !== 'ready' || channel === null || notOurs !== null || !onChain}
        >
          Make my code
        </Button>
        <Button size="lg" type="button" variant="ghost" data-decline onClick={onDecline}>
          Do not make it
        </Button>
      </div>
    </>
  );
}
