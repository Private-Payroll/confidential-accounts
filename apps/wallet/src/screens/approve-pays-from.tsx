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
import { keepPayingPick, paysFrom } from './paying-pick.js';
import type { PaysFrom } from './paying-pick.js';

/**
 * The account the ask pays from, and the wallet it is in, by name; and, when other sites already hold that account's
 * address, which ones, so the press is made knowing it.
 */
export function PaysFromAccount({ secret, account, shared }: {
  readonly secret: Secret; readonly account: number; readonly shared: readonly string[];
}): ReactNode {
  const t = useText();
  const wallet = walletNameOf(secret) ?? t('ask.pays.this-wallet');
  return (
    <>
      <p className="m-0 text-sm" data-pays-from-account>
        {t('ask.pays.from', { account: displayNameOf(account, loadSubwallets(secret).names), wallet })}
      </p>
      {shared.length > 0 && (
        <StatusAlert tone="warning" role={null} title={t('ask.pays.shared-title')}>
          <div data-pays-from-shared>
            {shared.map((origin) => <p className="m-0 font-mono text-foreground" key={origin}>{origin}</p>)}
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
export function PaysFromRefused({ why, onDecline }: {
  readonly why: 'another-wallet'; readonly onDecline: () => void;
}): ReactNode {
  const t = useText();
  const { lock } = useSession();
  return (
    <>
      <StatusAlert tone="danger" title={t('ask.pays.refused-title')}>
        <p className="m-0" data-pays-from-refused={why}>{t(`ask.pays.${why}`)}</p>
      </StatusAlert>
      <div className="flex flex-wrap gap-2" data-ask-actions>
        <Button size="lg" type="button" variant="default" onClick={() => lock()} data-pick-again>{t('ask.pays.again')}</Button>
        <Button size="lg" type="button" variant="ghost" onClick={onDecline} data-decline>{t('ask.decline')}</Button>
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
 * one and presses; another wallet opened than the one picked is refused.
 */
export function PaysWhenPicked(props: PaysWhenPickedProps): ReactNode {
  /* Each ask, in each wallet, is judged afresh: a pick kept for one ask never carries into the next. */
  return <PaysWhenPickedFor key={`${props.request.nonce}:${props.thisWallet}`} {...props} />;
}

interface PaysWhenPickedProps {
  readonly request: Ask; readonly thisWallet: string; readonly secret: Secret; readonly onDecline: () => void;
  readonly render: (account: number) => ReactNode;
}

function PaysWhenPickedFor({ request, thisWallet, secret, onDecline, render }: PaysWhenPickedProps): ReactNode {
  const [pays, setPays] = useState<PaysFrom>(() => paidFromOpen(request, thisWallet));
  if (pays.of === 'picked') return render(pays.account);
  if (pays.of === 'another-wallet') return <PaysFromRefused why="another-wallet" onDecline={onDecline} />;
  const pick = (account: number): void => {
    keepPayingPick(request, { walletId: openWalletId(), fingerprint: thisWallet, account });
    setPays(paidFromOpen(request, thisWallet));
  };
  return <PickInOpenWallet secret={secret} onPick={pick} onDecline={onDecline} />;
}

function PickInOpenWallet({ secret, onPick, onDecline }: {
  readonly secret: Secret; readonly onPick: (account: number) => void; readonly onDecline: () => void;
}): ReactNode {
  const t = useText();
  const [account, setAccount] = useState<number>(MAIN_ACCOUNT);
  const { names } = loadSubwallets(secret);
  return (
    <Section list={false} box={false} aria-label={t('ask.pays.choose')} title={t('ask.pays.choose')} description={t('ask.pays.choose-open')}>
      <ul className="plain" data-accounts-in-open-wallet>
        <AccountChoices
          names={names} group="paying-account-open" picked={(each) => account === each} disabled={false}
          onPick={setAccount} marked={(each) => ({ 'data-pays-from-open': String(each) })}
        />
      </ul>
      <div className="flex flex-wrap gap-2" data-ask-actions>
        <Button size="lg" type="button" variant="default" onClick={() => onPick(account)} data-pay-from-open>{t('ask.pays.use')}</Button>
        <Button size="lg" type="button" variant="ghost" onClick={onDecline} data-decline>{t('ask.decline')}</Button>
      </div>
    </Section>
  );
}

/**
 * A wallet's accounts as one choice each, by name: the list the window before the passkey shows for every wallet,
 * and the one an open wallet shows when no account was picked for the ask.
 */
export function AccountChoices({ names, group, picked, disabled, onPick, marked, valueFor = String }: {
  readonly names: Readonly<Record<string, string>>; readonly group: string; readonly picked: (account: number) => boolean;
  readonly disabled: boolean; readonly onPick: (account: number) => void;
  readonly marked: (account: number) => Readonly<Record<string, string>>; readonly valueFor?: (account: number) => string;
}): ReactNode {
  return (
    <>
      {WALLET_ACCOUNTS.map((each) => (
        <li key={each}>
          <label className="flex items-baseline gap-2">
            <input
              type="radio" name={group} value={valueFor(each)} checked={picked(each)}
              disabled={disabled} onChange={() => onPick(each)} {...marked(each)}
            />
            <span>{displayNameOf(each, names)}</span>
          </label>
        </li>
      ))}
    </>
  );
}
