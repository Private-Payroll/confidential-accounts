import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Identity } from 'midnight-identity/keys/derivation';
import type { CreationRequest } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import {
  CreationSignError, creationShown, creationSignatureFor,
} from 'midnight-identity/profile/creation-sign';
import type { CreationLedger, CreationShown } from 'midnight-identity/profile/creation-sign';
import type { AccountAddress } from 'midnight-identity/profile/company-label';
import { Button, Section } from 'vaults-ui';
import { StatusAlert } from '../components/status.js';
import { hrefOf } from '../routes.js';
import type { Consent } from '../framing.js';
import { labelInAccountState } from '../chain/company-label-on-chain.js';
import { builtAccountKeys, type BuiltAccountKeys } from '../chain/this-builds-account-keys.js';
import { liveConstruction, startingStateRefusal, type ConstructionDeps } from '../chain/account-as-constructed.js';

/**
 * THE SCREEN FOR THE SECOND PRESS OF CREATING A COMPANY: FINISHING ITS ACCOUNT.
 *
 * **NOTHING HAS BEEN SENT WHEN THIS SCREEN SHOWS, AND NOTHING IS SENT UNTIL IT
 * IS PRESSED.** The page has built the account's deploy and asks this wallet to
 * sign the one update that adds the rest of the account's circuits. This wallet
 * reads the unsent deploy itself and shows what it found: the label it drew,
 * the account the deploy creates, worked out from the deploy and not taken from
 * the page, and that the account is held by this person's own key alone. It
 * signs nothing unless every circuit is this build's, and unless the account
 * starts exactly as its own constructor makes it for this person and this
 * label: this wallet runs the constructor itself and compares the whole
 * starting state, so nothing the page set in it is kept as the company's.
 *
 * **ON THE PRESS THIS WALLET PINS THE ACCOUNT AS THE COMPANY'S**, so the label
 * and the account are tied together by this wallet and never by a service.
 */

/** The live ledger, loaded when the screen is. */
export const liveCreationLedger = async (): Promise<CreationLedger> =>
  (await import('@midnightntwrk/ledger-v9')) as unknown as CreationLedger;

type Stage =
  | { of: 'reading' }
  | { of: 'ready'; shown: CreationShown; ledger: CreationLedger }
  | { of: 'refused'; says: string }
  | { of: 'sent'; at: number; shown: CreationShown };

export function ApproveCreation({
  request, identity, channel, consent, whoIsAsking, onDecline, onPin, drewTheLabel,
  ledger = liveCreationLedger, now = Date.now, built = builtAccountKeys, construction = liveConstruction,
}: {
  readonly request: CreationRequest;
  readonly identity: Identity;
  readonly channel: Channel | null;
  readonly consent: Consent;
  readonly whoIsAsking: ReactNode;
  readonly onDecline: () => void;
  /**
   * Writes the account down as the company's, once, in this wallet, and settles
   * only once it is kept: the signature is handed back only after this.
   */
  readonly onPin: (account: AccountAddress, at: number) => Promise<void>;
  /**
   * Whether this wallet drew this label for a new company, and has pinned no
   * account for it yet. Read once, when the screen opens: pinning the account
   * on the press makes it false, and the screen that signed stays signed.
   */
  readonly drewTheLabel: boolean;
  readonly ledger?: () => Promise<CreationLedger>;
  readonly now?: () => number;
  readonly built?: () => BuiltAccountKeys;
  /** What the account's constructor is run with here, to make the starting state the deploy is compared with. */
  readonly construction?: () => Promise<ConstructionDeps>;
}): ReactNode {
  const [stage, setStage] = useState<Stage>({ of: 'reading' });
  const [drewAtOpen] = useState(drewTheLabel);
  /* Once signed, nothing the host re-renders with takes the screen back to reading or to a refusal. */
  const signed = useRef(false);

  useEffect(() => {
    if (signed.current) return undefined;
    let alive = true;
    setStage({ of: 'reading' });
    if (!drewAtOpen) {
      setStage({ of: 'refused', says: 'This wallet did not make up this company\'s label for a new company, or has already finished creating it. There is nothing to sign here.' });
      return () => { alive = false; };
    }
    const keys = built();
    if (keys.of !== 'built') {
      setStage({ of: 'refused', says: `${keys.why}, so it cannot check what it would sign. Nothing has been signed.` });
      return () => { alive = false; };
    }
    const cannotLoad = 'This wallet could not load what it needs to read the deploy. Nothing has been signed. Close this window and try again.';
    void ledger().then(async (L) => {
      if (!alive) return;
      let shown: CreationShown;
      try {
        shown = creationShown(L, identity, request, keys.keys, sha256, labelInAccountState);
      } catch (e) {
        setStage({ of: 'refused', says: e instanceof CreationSignError ? e.message : 'Nothing has been signed.' });
        return;
      }
      let deps: ConstructionDeps;
      try {
        deps = await construction();
      } catch {
        if (alive) setStage({ of: 'refused', says: cannotLoad });
        return;
      }
      let why: string | null;
      try {
        why = await startingStateRefusal(deps, {
          deploy: request.deploy, label: request.company, foundingKey: shown.mine, insert: request.insert, build: keys.keys, digest: sha256,
        });
      } catch {
        why = 'This wallet could not compare the account\'s starting state with the one its constructor makes.';
      }
      if (!alive) return;
      setStage(why === null ? { of: 'ready', shown, ledger: L } : { of: 'refused', says: `${why} Nothing has been signed.` });
    }, () => { if (alive) setStage({ of: 'refused', says: cannotLoad }); });
    return () => { alive = false; };
  }, [identity, request, ledger, built, drewAtOpen, construction]);

  const sign = useCallback(async (): Promise<void> => {
    if (stage.of !== 'ready' || channel === null || !drewAtOpen || !consent.ok) return;
    const keys = built();
    if (keys.of !== 'built') return;
    let answer: ReturnType<typeof creationSignatureFor>;
    let at: number;
    try {
      at = now();
      answer = creationSignatureFor(stage.ledger, identity, request, at, keys.keys, sha256, labelInAccountState);
      /* The account is kept as the company's before the signature leaves: a signature handed back for an account this wallet did not keep would let it be asked again. */
      await onPin(answer.account, at);
    } catch (e) {
      setStage({ of: 'refused', says: e instanceof Error ? e.message : 'Nothing has been signed.' });
      return;
    }
    if (!channel.answer(answer)) {
      setStage({
        of: 'refused',
        says: 'The page had already closed this request, so the signature did not reach it and nothing was sent. This wallet '
          + 'has kept the account as this company\'s. Start creating the company again from the page.',
      });
      return;
    }
    signed.current = true;
    setStage({ of: 'sent', at, shown: stage.shown });
  }, [stage, channel, identity, request, now, built, onPin, drewAtOpen, consent]);

  if (stage.of === 'sent') {
    return (
      <>
        <h1 data-signed-heading>{`You signed the step that finishes your company's account, for ${request.requester.origin}`}</h1>
        <p className="lede" data-signed>
          {`On ${new Date(stage.at).toLocaleString()} this wallet signed the second step of the account's creation and handed the signature back. `}
          Return to the page to send it: the page sends the account, and once the chain shows it you finish it there with
          one more press. You will not be asked to sign again. This wallet now knows the account below as this
          company&rsquo;s.
        </p>
        <p className="m-0 font-mono break-all text-sm" data-pinned-label>{stage.shown.company}</p>
        <p className="m-0 font-mono break-all text-sm" data-pinned-account>{stage.shown.account}</p>
        <p className="m-0 font-mono text-xl" data-pinned-fingerprint>{companyFingerprint(stage.shown.company, stage.shown.account)}</p>
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>&larr; Your wallet</a></p>
      </>
    );
  }

  const shown = stage.of === 'ready' ? stage.shown : null;
  return (
    <>
      <h1 data-headline>{`Finish creating a company, for ${request.requester.origin}`}</h1>
      {stage.of === 'reading' && <p className="lede" data-reading>Reading the deploy the page built. Nothing has been signed and nothing has been sent.</p>}
      {stage.of === 'refused' && (
        <StatusAlert tone="danger" title="This wallet will not sign this">
          <p className="m-0" data-creation-refused>{stage.says}</p>
        </StatusAlert>
      )}
      {shown !== null && (
        <Section
          list={false} box={false} aria-label="The company's account" title="The company's account"
          description="Read by this wallet from the deploy the page built. Nothing has been sent yet."
        >
          <p className="m-0 text-sm text-muted-foreground">The label this wallet made up for the company</p>
          <p className="m-0 font-mono break-all text-sm" data-label>{shown.company}</p>
          <p className="m-0 text-sm text-muted-foreground">The account the deploy creates</p>
          <p className="m-0 font-mono break-all text-sm" data-account>{shown.account}</p>
          <p className="m-0 text-sm text-muted-foreground">The fingerprint of the label and the account together</p>
          <p className="m-0 font-mono text-xl" data-fingerprint>{companyFingerprint(shown.company, shown.account)}</p>
          <p className="m-0 text-sm" data-held-by-you>
            The account is held by your own key for this company and by nobody else, from its first transaction. Only
            your key controls it for now: signers you named do not, until its committee is changed to include them in
            Settings.
          </p>
          <p className="m-0 text-sm" data-circuits>
            {`Its deploy runs ${shown.deployed.length} of this build's circuits. This step adds the other ${shown.inserted.length}, each checked against this build's own, and changes nothing else.`}
          </p>
        </Section>
      )}
      {whoIsAsking}
      <div className="flex flex-wrap gap-2">
        <Button
          size="lg" type="button" variant="default" onClick={() => { void sign(); }} data-approve data-sign-creation
          disabled={!consent.ok || stage.of !== 'ready' || channel === null}
        >
          Sign and finish
        </Button>
        <Button size="lg" type="button" variant="ghost" data-decline onClick={onDecline}>
          Do not sign
        </Button>
      </div>
    </>
  );
}
