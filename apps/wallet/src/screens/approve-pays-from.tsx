/*
 * What the opened window says about the account an ask that pays pays from: the account picked before the passkey,
 * named; this open wallet's accounts to pick from when none was picked; or a refusal when another wallet opened.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Section, useText } from 'vaults-ui';
import type { Ask } from 'midnight-identity/profile/request';
import type { Secret } from 'midnight-identity/keys/derivation';
import { useSession } from '../session.js';
import { walletNameOf } from '../accounts/storage.js';
import { loadSubwallets } from '../accounts/subwallet-record.js';
import { MAIN_ACCOUNT, WALLET_ACCOUNTS, displayNameOf } from '../accounts/subwallets.js';
import { openWalletId } from '../accounts/wallets-held.js';
import { StatusAlert } from '../components/status.js';
import { OFFERED, keepPayingPick, paysFrom } from './paying-pick.js';
import type { PaysFrom } from './paying-pick.js';
import { paysCoins } from './approve-slot.js';

/**
 * The words for what an ask that pays takes from the account picked: the key as it is for coins, and its `-fee` form
 * for an ask whose only cost from that account is a network fee not covered for the person.
 */
export const paidWords = (request: Ask, key: 'ask.pays.choose-why' | 'ask.pays.choose-open'): string =>
  paysCoins(request) ? key : `${key}-fee`;

/**
 * How the account an ask pays from came to be its account: picked in the window before the passkey, picked here in a
 * wallet already open, or left on the account this wallet offers the site, which only an ask paying a fee is.
 */
export type PickedHow = 'before' | 'here' | 'offered';

/** The line naming the account an ask pays from, for what it pays and how that account came to be picked. */
const paysFromWords = (request: Ask, how: PickedHow): string => {
  const what = paysCoins(request) ? 'ask.pays.from' : 'ask.pays.from-fee';
  return how === 'before' ? what : `${what}-${how}`;
};

/**
 * The account the ask pays from, and the wallet it is in, by name; and, when other sites already hold that account's
 * address, which ones, so the press is made knowing it.
 */
export function PaysFromAccount({
  request,
  how,
  secret,
  account,
  shared,
  recordUnread = false
}: {
  readonly request: Ask;
  readonly how: PickedHow;
  readonly secret: Secret;
  readonly account: number;
  readonly shared: readonly string[];
  /** This wallet's record could not be read, so whether another site holds the account's address is not known. */
  readonly recordUnread?: boolean;
}): ReactNode {
  const t = useText();
  const wallet = walletNameOf(secret) ?? t('ask.pays.this-wallet');
  return (
    <>
      <p className="m-0 text-sm" data-pays-from-account>
        {t(paysFromWords(request, how), { account: displayNameOf(account, loadSubwallets(secret).names), wallet })}
      </p>
      {recordUnread && (
        <p className="m-0 text-sm" data-pays-from-record-unread>
          {t('ask.pays.record-unread')}
        </p>
      )}
      {shared.length > 0 && (
        <StatusAlert tone="warning" role={null} title={t('ask.pays.shared-title')}>
          <div data-pays-from-shared>
            {shared.map((origin) => (
              <p className="m-0 font-mono text-foreground" key={origin}>
                {origin}
              </p>
            ))}
          </div>
          <p className="m-0">{t('ask.pays.shared')}</p>
        </StatusAlert>
      )}
    </>
  );
}

/**
 * An ask that pays with no account to pay from: none was picked for this ask before the passkey, or the wallet the
 * passkey opened is not the one picked. Nothing runs. Pick again locks this wallet, so the window before the passkey
 * shows the list again for the same ask; Decline answers declined.
 */
export function PaysFromRefused({
  why,
  onDecline
}: {
  readonly why: 'another-wallet';
  readonly onDecline: () => void;
}): ReactNode {
  const t = useText();
  const { lock } = useSession();
  return (
    <>
      <StatusAlert tone="danger" title={t('ask.pays.refused-title')}>
        <p className="m-0" data-pays-from-refused={why}>
          {t(`ask.pays.${why}`)}
        </p>
      </StatusAlert>
      <div className="flex flex-wrap gap-2" data-ask-actions>
        <Button size="lg" type="button" variant="default" onClick={() => lock()} data-pick-again>
          {t('ask.pays.again')}
        </Button>
        <Button size="lg" type="button" variant="ghost" onClick={onDecline} data-decline>
          {t('ask.decline')}
        </Button>
      </div>
    </>
  );
}

/** The account an ask that pays pays from in the wallet open now, taken once for this ask (`paysFrom`). */
const paidFromOpen = (request: Ask, thisWallet: string): PaysFrom =>
  paysFrom(request, { walletId: openWalletId(), fingerprint: thisWallet });

/**
 * An ask that pays runs only from an account picked for it. Picked before the passkey, it runs at once; reaching a
 * wallet already open, with none picked, this wallet's accounts are listed and nothing runs until the person picks
 * one and presses; another wallet opened than the one picked is refused. A pick left on the account offered to the
 * site runs from that account once this wallet's record is read, and nothing runs before.
 */
export function PaysWhenPicked(props: PaysWhenPickedProps): ReactNode {
  /* Each ask, in each wallet, is judged afresh: a pick kept for one ask never carries into the next. */
  return <PaysWhenPickedFor key={`${props.request.nonce}:${props.thisWallet}`} {...props} />;
}

interface PaysWhenPickedProps {
  readonly request: Ask;
  readonly thisWallet: string;
  readonly secret: Secret;
  readonly onDecline: () => void;
  readonly render: (account: number, how: PickedHow) => ReactNode;
  /** The account this wallet offers the asking site, once this wallet's record is read; null until then. */
  readonly offered: number | null;
}

function PaysWhenPickedFor({
  request,
  thisWallet,
  secret,
  onDecline,
  render,
  offered
}: PaysWhenPickedProps): ReactNode {
  const t = useText();
  const [pays, setPays] = useState<PaysFrom>(() => paidFromOpen(request, thisWallet));
  const [pickedHere, setPickedHere] = useState(false);
  if (pays.of === 'another-wallet') return <PaysFromRefused why="another-wallet" onDecline={onDecline} />;
  /* The account offered to the site is read from this wallet's record, so nothing runs or is offered before it is. */
  const waitsForOffered = offered === null && (pays.of === 'picked' ? pays.account === OFFERED : !paysCoins(request));
  if (waitsForOffered)
    return (
      <p className="m-0 text-sm text-muted-foreground" data-reading-offered>
        {t('ask.pays.reading-offered')}
      </p>
    );
  if (pays.of === 'picked') {
    return pays.account === OFFERED
      ? render(offered!, 'offered')
      : render(pays.account, pickedHere ? 'here' : 'before');
  }
  const pick = (account: number): void => {
    keepPayingPick(request, { walletId: openWalletId(), fingerprint: thisWallet, account });
    setPickedHere(true);
    setPays(paidFromOpen(request, thisWallet));
  };
  /* An ask that pays only a fee starts on the account offered to the site; one that pays coins on the main account. */
  const first = paysCoins(request) || offered === null ? MAIN_ACCOUNT : offered;
  return <PickInOpenWallet request={request} secret={secret} first={first} onPick={pick} onDecline={onDecline} />;
}

function PickInOpenWallet({
  request,
  secret,
  first,
  onPick,
  onDecline
}: {
  readonly request: Ask;
  readonly secret: Secret;
  readonly first: number;
  readonly onPick: (account: number) => void;
  readonly onDecline: () => void;
}): ReactNode {
  const t = useText();
  const [account, setAccount] = useState<number>(first);
  const { names } = loadSubwallets(secret);
  return (
    <Section
      list={false}
      box={false}
      aria-label={t('ask.pays.choose')}
      title={t('ask.pays.choose')}
      description={t(paidWords(request, 'ask.pays.choose-open'))}
    >
      <ul className="plain" data-accounts-in-open-wallet>
        <AccountChoices
          names={names}
          group="paying-account-open"
          picked={(each) => account === each}
          disabled={false}
          onPick={setAccount}
          marked={(each) => ({ 'data-pays-from-open': String(each) })}
        />
      </ul>
      <div className="flex flex-wrap gap-2" data-ask-actions>
        <Button size="lg" type="button" variant="default" onClick={() => onPick(account)} data-pay-from-open>
          {t('ask.pays.use')}
        </Button>
        <Button size="lg" type="button" variant="ghost" onClick={onDecline} data-decline>
          {t('ask.decline')}
        </Button>
      </div>
    </Section>
  );
}

/**
 * A wallet's accounts as one choice each, by name: the list the window before the passkey shows for every wallet,
 * and the one an open wallet shows when no account was picked for the ask.
 */
export function AccountChoices({
  names,
  group,
  picked,
  disabled,
  onPick,
  marked,
  valueFor = String
}: {
  readonly names: Readonly<Record<string, string>>;
  readonly group: string;
  readonly picked: (account: number) => boolean;
  readonly disabled: boolean;
  readonly onPick: (account: number) => void;
  readonly marked: (account: number) => Readonly<Record<string, string>>;
  readonly valueFor?: (account: number) => string;
}): ReactNode {
  return (
    <>
      {WALLET_ACCOUNTS.map((each) => (
        <li key={each}>
          <label className="flex items-baseline gap-2">
            <input
              type="radio"
              name={group}
              value={valueFor(each)}
              checked={picked(each)}
              disabled={disabled}
              onChange={() => onPick(each)}
              {...marked(each)}
            />
            <span>{displayNameOf(each, names)}</span>
          </label>
        </li>
      ))}
    </>
  );
}
