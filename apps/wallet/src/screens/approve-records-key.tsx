import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Identity } from 'midnight-identity/keys/derivation';
import type { FirstSecretShown, RecordsKeyRequest } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import { RecordsKeyRefused, recordsKeyAnswerFor, recordsKeyFor } from 'midnight-identity/profile/records-key';
import { CompanyOnChain, accountCarriesTheLabel, liveLabelReader, useCompanyCheck } from './company-on-chain.js';
import type { LabelReader } from './company-on-chain.js';
import type { AccountAddress, VaultAddress } from 'midnight-identity/profile/company-label';
import { fromIndexerAt, vaultOnChain, type VaultOnChain } from '../chain/view-doors.js';
import { INDEXER_HTTP_URL } from '../config.js';
import { Button, Section } from 'vaults-ui';
import { StatusAlert } from '../components/status.js';
import { hrefOf } from '../routes.js';
import { useAnswerAtOnce } from '../framing.js';
import type { Consent } from '../framing.js';

/**
 * THE SCREEN FOR A PAGE ASKING THIS WALLET TO SIGN THE PERSON'S RECORDS KEY
 * FOR THEIR SEAT ON A COMPANY'S ACCOUNT.
 *
 * A vault's secret is sealed to each signer's records key, so that each of
 * them can open it with nothing but their recovery words. Before a signer's
 * device approves the secret, it checks every key the secret is sealed to
 * against statements like the one this screen signs. So this screen says what
 * it signs: the company, the records key this wallet works out for it, and the
 * seat the page says this person holds on the company's account.
 *
 * **IT SIGNS NOTHING UNTIL IT HAS READ THE ACCOUNT ITSELF** (`company-on-chain.tsx`):
 * the account must carry the company's label, and must hold the seat the page
 * names now. The same read gives the answer who holds the account - its
 * committee, its threshold and every seat - which the page checks a vault's
 * secret against, and which no service handed over.
 *
 * **IT SIGNS ONLY FOR THE ACCOUNT THIS WALLET PINNED FOR THE COMPANY** (`pinned`).
 * The pin is kept in the person's saved keys, which an ask for this screen does
 * not carry, so with none handed in it signs nothing and says so; it never pins.
 *
 * **WHEN THE PAGE NAMES ONE OF THE COMPANY'S VAULTS, THIS WALLET READS THAT
 * VAULT TOO** (`vaultOnChain`): who holds it and which account it is pinned
 * to, over the same connection, and the answer carries what it read. A page
 * checks that the vault is held by the account's own committee against this
 * read, never against what a service says. Nothing is signed until the vault
 * is read, or when it is pinned to another account.
 *
 * **BEFORE A VAULT'S FIRST SECRET, IT SHOWS WHO WILL HOLD THAT SECRET**
 * (`FirstSecretToConfirm`): the vault and every key its secret will be sealed
 * to, each by the name the page gives. That is a confirmation shown to the
 * person, not a lock: the page proves the approval with the seat's own key it
 * holds, and the chain asks nothing of this wallet. The screen says so.
 *
 * **THE STATEMENT CANNOT CHANGE ANY OF THE COMPANY'S RULES.** It names only
 * the company, the records key and the seat, under a tag of its own.
 */

type Stage = { of: 'ready' } | { of: 'refused'; says: string } | { of: 'sent'; at: number };

/** How this screen reads a vault. Replaceable so a test can answer. */
export type VaultReader = (vault: VaultAddress) => Promise<VaultOnChain>;

/** The chain, read through the indexer this wallet reads its own balance from. */
export const liveVaultReader: VaultReader = (vault) => vaultOnChain(vault, fromIndexerAt(INDEXER_HTTP_URL));

type VaultCheck = { readonly of: 'none' } | { readonly of: 'checking' } | VaultOnChain;

/** Reads the vault the page names once per vault; with none named there is nothing to read. */
function useVaultCheck(vault: VaultAddress | undefined, read: VaultReader): VaultCheck {
  const [found, setFound] = useState<{ vault: VaultAddress; check: VaultOnChain } | null>(null);
  useEffect(() => {
    if (vault === undefined) return undefined;
    let alive = true;
    read(vault).then(
      (check) => { if (alive) setFound({ vault, check }); },
      () => { if (alive) setFound({ vault, check: { of: 'unreadable', why: 'the read did not come back.' } }); },
    );
    return () => { alive = false; };
  }, [vault, read]);
  if (vault === undefined) return { of: 'none' };
  return found !== null && found.vault === vault ? found.check : { of: 'checking' };
}

/** Who the fingerprint is compared with. */
const COMPARE_WITH_THE_INVITER = 'the person who invited you gave you themselves, by a call, a message or in person, and not through this page';

const short = (hex: string): string => `${hex.slice(0, 12)}…${hex.slice(-8)}`;

/**
 * The vault whose first secret is about to be raised or approved, and every
 * person it will be sealed to, as the page names them. Every name and key here
 * is the page's word: before the secret is set the chain names no reader, so
 * this wallet has nothing of its own to compare them with. It says plainly that
 * signing locks nothing on the chain, so the person never takes it for a check
 * the chain enforces.
 */
export function FirstSecretToConfirm({ vault, firstSecret }: {
  readonly vault: VaultAddress;
  readonly firstSecret: FirstSecretShown;
}): ReactNode {
  return (
    <Section
      list={false} box={false} aria-label="Who will hold this vault's secret" title="Who will hold this vault's secret"
      description="The page is about to set up this vault's first secret. A copy is sealed to each key below, as the page names them."
      data-first-secret
    >
      <p className="m-0 text-sm text-muted-foreground">The vault</p>
      <p className="m-0 font-mono break-all text-sm" data-first-secret-vault>{vault}</p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {firstSecret.readers.map((r) => (
          <li key={r.key} data-first-secret-reader>
            <p className="m-0 text-sm text-foreground" data-first-secret-reader-name>{r.name ?? 'A key the page names no one for'}</p>
            <p className="m-0 font-mono break-all text-sm text-muted-foreground" data-first-secret-reader-key>{r.key}</p>
          </li>
        ))}
      </ul>
      <p className="m-0 text-sm" data-first-secret-not-a-lock>
        Signing here does not lock anything on the chain: the page that asked holds what it needs to approve this secret
        without your wallet. This is shown so you can see who will hold the vault&rsquo;s secret, and say no if it is wrong.
      </p>
    </Section>
  );
}

type AccountSeats = NonNullable<Extract<ReturnType<typeof useCompanyCheck>, { of: 'carries' }>['seats']>;
type VaultHolders = Extract<VaultOnChain, { of: 'read' }>['holders'];

function RecordsKeySent({ request, at }: { readonly request: RecordsKeyRequest; readonly at: number }): ReactNode {
  return (
    <>
      <h1 data-signed-heading>{`You signed your records key for this company, for ${request.requester.origin}`}</h1>
      <p className="lede" data-signed>
        {`On ${new Date(at).toLocaleString()} this wallet signed your records key for your seat on this company's account, and handed it back with who holds the account now, as this wallet read it from the network.`}
      </p>
      <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>&larr; Your wallet</a></p>
    </>
  );
}

function SeatStatus({ seats, seated, checking }: {
  readonly seats: AccountSeats | null;
  readonly seated: boolean;
  readonly checking: boolean;
}): ReactNode {
  return (
    <>
      {seats === null ? (checking ? (
        <p className="m-0 text-sm text-muted-foreground" data-seat-checking>Checking the company&rsquo;s account on the network&hellip;</p>
      ) : (
        <p className="m-0 text-sm" data-seat-unread>
          This wallet could not read the seats of the company&rsquo;s account, so it will not sign. Open this again in a minute.
        </p>
      )) : seated ? (
        <p className="m-0 text-sm" data-seat-held>The company&rsquo;s account holds this seat now.</p>
      ) : (
        <StatusAlert tone="danger" role={null} title="The company's account does not hold this seat">
          <p className="m-0" data-seat-not-held>
            The account, as this wallet read it from the network, holds no such seat now, so this wallet will not sign
            it. If you have just been seated, wait a minute and open this again.
          </p>
        </StatusAlert>
      )}
    </>
  );
}

function VaultStatus({ request, vaultCheck, vaultRead }: {
  readonly request: RecordsKeyRequest;
  readonly vaultCheck: VaultCheck;
  readonly vaultRead: VaultHolders | null;
}): ReactNode {
  return (
    <>
      {request.vault !== undefined && (vaultCheck.of === 'checking' ? (
        <p className="m-0 text-sm text-muted-foreground" data-vault-checking>Checking the vault on the network&hellip;</p>
      ) : vaultRead === null ? (
        <p className="m-0 text-sm" data-vault-unread>
          This wallet could not read the vault the page names, so it will not sign. Open this again in a minute.
        </p>
      ) : vaultRead.account !== request.account ? (
        <StatusAlert tone="danger" role={null} title="The vault belongs to another company">
          <p className="m-0" data-vault-other-account>
            The vault the page names is tied to a different company account from this one, as this wallet read it from
            the network, so this wallet will not sign.
          </p>
        </StatusAlert>
      ) : (
        <p className="m-0 text-sm text-muted-foreground" data-vault-read>
          {`The answer also says who holds the vault: ${vaultRead.committee.length} committee key${vaultRead.committee.length === 1 ? '' : 's'}, ${vaultRead.threshold} of which must sign a change to its rules.`}
        </p>
      ))}
    </>
  );
}

function WhatThisWalletSigns({ request, recordsKey, seats, seated, checking, vaultCheck, vaultRead }: {
  readonly request: RecordsKeyRequest;
  readonly recordsKey: string;
  readonly seats: AccountSeats | null;
  readonly seated: boolean;
  readonly checking: boolean;
  readonly vaultCheck: VaultCheck;
  readonly vaultRead: VaultHolders | null;
}): ReactNode {
  return (
    <Section
      list={false} box={false} aria-label="What this wallet signs" title="What this wallet signs"
      description="One statement, with the key you sit on this company's committee with."
    >
      <p className="m-0 text-sm text-foreground" data-records-key-signs>
        That your records key belongs to this company, for the seat you hold on its account. Each of the other
        signers&rsquo; devices checks it before it approves the secret of one of the company&rsquo;s vaults, so the copy
        of that secret kept for you is one your own recovery words open. It names only the company, your records key
        and your seat, and cannot be used to change any of the company&rsquo;s rules.
      </p>
      <p className="m-0 text-sm text-muted-foreground">Your records key for this company</p>
      <p className="m-0 font-mono break-all text-sm" data-records-key>{recordsKey}</p>
      <p className="m-0 text-sm text-muted-foreground">Your seat, as the page names it</p>
      <p className="m-0 font-mono break-all text-sm" data-records-key-seat>{request.seat}</p>
      {request.signingKey !== undefined && (
        <>
          <p className="m-0 text-sm text-foreground" data-directory-entry-signs>
            In the same press, your entry in the company&rsquo;s list of who files its records: the key your filings
            are signed with, as the page names it, with your records key and your seat. Other signers&rsquo; devices
            believe a record you file only when this entry checks out against the company&rsquo;s account.
          </p>
          <p className="m-0 text-sm text-muted-foreground">The key your filings are signed with, as the page names it</p>
          <p className="m-0 font-mono break-all text-sm" data-directory-entry-key>{request.signingKey}</p>
        </>
      )}
      <SeatStatus seats={seats} seated={seated} checking={checking} />
      {seats !== null && (
        <p className="m-0 text-sm text-muted-foreground" data-seats-read>
          {`The answer also says who holds the account now: ${seats.committee.length} committee key${seats.committee.length === 1 ? '' : 's'}, ${seats.threshold} of which must sign a change to its rules, and ${seats.seats.length} seat${seats.seats.length === 1 ? '' : 's'}.`}
          {' '}Committee keys: {seats.committee.map((k) => short(k.value)).join(', ') || 'none'}.
        </p>
      )}
      <VaultStatus request={request} vaultCheck={vaultCheck} vaultRead={vaultRead} />
    </Section>
  );
}

function SignButtons({ enabled, held, sign, onDecline }: {
  readonly enabled: boolean;
  readonly held: boolean;
  readonly sign: () => void;
  readonly onDecline: () => void;
}): ReactNode {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          size="lg" type="button" variant="default" onClick={sign} data-approve data-sign-records-key
          disabled={!enabled}
        >
          Sign my records key
        </Button>
        <Button size="lg" type="button" variant="ghost" data-decline onClick={onDecline}>
          Do not sign
        </Button>
      </div>
      {held && (
        <p className="m-0 text-sm text-muted-foreground" data-sign-held>
          This wallet signs your records key only for the account it has kept for this company, and none was handed to
          this window. Give your vault keys from the company&rsquo;s page instead.
        </p>
      )}
    </>
  );
}

export function ApproveRecordsKey({
  request, identity, channel, consent, whoIsAsking, onDecline, now = Date.now, readLabel = liveLabelReader,
  readVault = liveVaultReader, pinned = null, answerAtOnce = false,
}: {
  readonly request: RecordsKeyRequest;
  readonly identity: Identity;
  readonly channel: Channel | null;
  readonly consent: Consent;
  readonly whoIsAsking: ReactNode;
  readonly onDecline: () => void;
  readonly now?: () => number;
  readonly readLabel?: LabelReader;
  readonly readVault?: VaultReader;
  /** The account this wallet pinned for the company, or null when none is handed in: nothing is signed for another, or for none. */
  readonly pinned?: AccountAddress | null;
  /** True when the person approved this ask before the passkey: it is then answered without a press once the checks its buttons wait for agree. */
  readonly answerAtOnce?: boolean;
}): ReactNode {
  const [stage, setStage] = useState<Stage>({ of: 'ready' });
  const check = useCompanyCheck(request.company, request.account, readLabel);
  const onChain = accountCarriesTheLabel(check, request.company);
  const seats = check.of === 'carries' ? check.seats ?? null : null;
  const seated = seats !== null && seats.seats.includes(request.seat);
  const vaultCheck = useVaultCheck(request.vault, readVault);
  const vaultRead = vaultCheck.of === 'read' ? vaultCheck.holders : null;
  /* With no vault named there is none to read; with one named, it must be read and pinned to this account. */
  const vaultOk = request.vault === undefined || (vaultRead !== null && vaultRead.account === request.account);
  /* The key the press signs, shown before it is pressed. */
  const recordsKey = useMemo(() => recordsKeyFor(identity, request), [identity, request]);

  const sign = useCallback((): void => {
    if (!consent.ok || stage.of !== 'ready' || channel === null || !onChain || seats === null || !seated || !vaultOk) return;
    try {
      const at = now();
      /* With no account pinned, this refuses. */
      channel.answer(recordsKeyAnswerFor(identity, request, seats, at, vaultRead ?? undefined, pinned));
      setStage({ of: 'sent', at });
    } catch (e) {
      /* Only the wallet's own sentences reach the person; anything else is said plainly. */
      setStage({ of: 'refused', says: e instanceof RecordsKeyRefused ? e.message : 'Nothing has been signed. Close this window and try again from the page.' });
    }
  }, [consent, stage, channel, onChain, seats, seated, vaultOk, vaultRead, now, identity, request, pinned]);
  useAnswerAtOnce(answerAtOnce, consent.ok && stage.of === 'ready' && channel !== null && onChain && seated && vaultOk
    && pinned !== null, sign);

  if (stage.of === 'sent') return <RecordsKeySent request={request} at={stage.at} />;

  return (
    <>
      <h1 data-headline>{`Sign your records key for a company, for ${request.requester.origin}`}</h1>
      {stage.of === 'refused' && (
        <StatusAlert tone="danger" title="This wallet will not sign this">
          <p className="m-0" data-records-key-refused>{stage.says}</p>
        </StatusAlert>
      )}
      <WhatThisWalletSigns
        request={request} recordsKey={recordsKey} seats={seats} seated={seated}
        checking={check.of === 'checking'} vaultCheck={vaultCheck} vaultRead={vaultRead}
      />
      {request.vault !== undefined && request.firstSecret !== undefined && (
        <FirstSecretToConfirm vault={request.vault} firstSecret={request.firstSecret} />
      )}
      <Section list={false} box={false} aria-label="The company, as the page names it" title="The company, as the page names it" description="This wallet signs with the key it holds for this company and no other.">
        <CompanyOnChain label={request.company} account={request.account} check={check} doing="signed" compareWith={COMPARE_WITH_THE_INVITER} />
      </Section>
      {whoIsAsking}
      <SignButtons
        enabled={consent.ok && stage.of === 'ready' && channel !== null && onChain && seated && vaultOk && pinned !== null}
        held={pinned === null} sign={sign} onDecline={onDecline}
      />
    </>
  );
}
