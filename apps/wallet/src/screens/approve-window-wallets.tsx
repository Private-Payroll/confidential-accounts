import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Section, useText } from 'vaults-ui';
import type { Ask } from 'midnight-identity/profile/request';
import type { Port } from 'midnight-identity/profile/store';
import { useSession } from '../session.js';
import { heldWallets } from '../accounts/wallets-held.js';
import { walletNameOnRecord } from '../accounts/storage.js';
import { subwalletsOnRecord } from '../accounts/subwallet-record.js';
import { MAIN_ACCOUNT } from '../accounts/subwallets.js';
import { pickedHere, signedInWalletHere } from '../lib/signed-in-here.js';
import { StatusAlert } from '../components/status.js';
import { isPayingAsk } from './approve-slot.js';
import type { PayingPick } from './paying-pick.js';
import { AccountChoices } from './approve-pays-from.js';

/**
 * Which wallet the window's Approve opens, and the list it is picked from when the page has none kept. For a paying
 * action the list is of accounts, each under its wallet: the wallets that may open, and the account that pays, are
 * picked together, once, here.
 */
export function useWalletThatOpens(request: Ask, port: Port, cannotOpen: string | null) {
  const t = useText();
  const { wallets, walletId, passkeyRefused } = useSession();
  const origin = request.requester.origin;
  /* Which wallet opens: decided from this browser's list and the page's last sign-in, before anything is unlocked. */
  const held = useMemo(() => heldWallets(), [wallets]);
  const remembered = useMemo(() => signedInWalletHere(port, origin, held), [port, origin, held]);
  const pick = useMemo(() => pickedHere(port, origin, held), [port, origin, held]);
  const kept = remembered.of === 'here' ? remembered.walletId : pick;
  /* A passkey refused because it cannot open the named wallet is not pressed again: the list is the way on. */
  const refused = passkeyRefused !== null || cannotOpen !== null;
  const fixed = request.kind !== 'sign-in' && !refused ? kept : null;
  const offerList = fixed === null && (wallets.length > 1 || remembered.of === 'gone' || refused);
  const [picked, setPicked] = useState<string>(() => (
    request.kind === 'sign-in' && remembered.of === 'here' ? remembered.walletId
      : remembered.of === 'no-place' && remembered.matches !== null ? remembered.matches
        : kept ?? walletId));
  const opens = fixed ?? (offerList ? picked : walletId);
  const nameOf = (id: string): string => {
    const index = wallets.findIndex((wallet) => wallet.id === id);
    return walletNameOnRecord(id) ?? t('ask.wallet.unnamed', { n: index + 1 });
  };
  /* The account an ask that pays pays from: the main account of the wallet that opens until the person picks another. */
  const [account, setAccount] = useState<number>(MAIN_ACCOUNT);
  const payingWallets = fixed !== null ? [fixed] : offerList ? wallets.map((wallet) => wallet.id) : [walletId];
  const fingerprintOf = (id: string): string | null =>
    held.find((wallet) => wallet.id === id)?.fingerprint ?? subwalletsOnRecord(id)?.fingerprint ?? null;
  /* A record whose fingerprint is not the wallet's own names nothing: another wallet's names never dress these accounts. */
  const accountNamesOf = (id: string): Readonly<Record<string, string>> => {
    const record = subwalletsOnRecord(id);
    const known = held.find((wallet) => wallet.id === id)?.fingerprint ?? null;
    return record !== null && (known === null || known === record.fingerprint) ? record.names : {};
  };
  const payingPick = (): PayingPick => ({ walletId: opens, fingerprint: fingerprintOf(opens), account });
  const pickToPay = (id: string, picking: number): void => { setPicked(id); setAccount(picking); };
  return {
    held, remembered, refused, fixed, offerList, picked, setPicked, opens, nameOf,
    account, payingWallets, accountNamesOf, payingPick, pickToPay,
  };
}
export type WalletThatOpens = ReturnType<typeof useWalletThatOpens>;

/** The wallet that opens, named, or the list to pick it from; for an ask that pays, the accounts to pick from. */
export function WhichWalletOpens({ request, which, busy }: {
  readonly request: Ask; readonly which: WalletThatOpens; readonly busy: string | null;
}): ReactNode {
  const t = useText();
  const { wallets } = useSession();
  const origin = request.requester.origin;
  const { remembered, fixed, offerList, picked, setPicked, nameOf } = which;
  if (isPayingAsk(request)) return <PayingAccounts origin={origin} which={which} busy={busy} />;
  return (
    <>
      {fixed !== null && <p className="m-0 text-sm text-muted-foreground" data-opens-wallet>{t('ask.wallet.opens', { wallet: nameOf(fixed) })}</p>}
      {offerList && (
        <Section
          list={false} box={false} aria-label={t('ask.wallet.choose')} title={t('ask.wallet.choose')}
          description={t('ask.wallet.choose-why', { count: wallets.length })}
        >
          {remembered.of === 'gone' && <RememberedWalletGone origin={origin} />}
          <ul className="plain" data-wallets-to-choose>
            {wallets.map((wallet) => (
              <li key={wallet.id}>
                <label className="flex items-baseline gap-2">
                  <input
                    type="radio" name="answering-wallet" value={wallet.id} checked={picked === wallet.id}
                    disabled={busy !== null} onChange={() => setPicked(wallet.id)} data-wallet-choice={wallet.id}
                  />
                  <span>{nameOf(wallet.id)}</span>
                </label>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

/** The page's remembered wallet is no longer held here. */
function RememberedWalletGone({ origin }: { readonly origin: string }): ReactNode {
  const t = useText();
  return (
    <StatusAlert tone="warning" role={null} title={t('ask.wallet.gone-title')}>
      <p className="m-0" data-remembered-wallet-gone>{t('ask.wallet.gone', { origin })}</p>
    </StatusAlert>
  );
}

/**
 * The accounts an ask that pays may pay from, each under the wallet it is in, by name. Only the wallets this window may
 * open are listed: the one the page's sign-in kept, or every wallet here when the page has none. Balances are not
 * shown: they need the wallet open.
 */
function PayingAccounts({ origin, which, busy }: {
  readonly origin: string; readonly which: WalletThatOpens; readonly busy: string | null;
}): ReactNode {
  const t = useText();
  const { remembered, opens, account, payingWallets, accountNamesOf, pickToPay, nameOf } = which;
  return (
    <Section list={false} box={false} aria-label={t('ask.pays.choose')} title={t('ask.pays.choose')} description={t('ask.pays.choose-why')}>
      {remembered.of === 'gone' && <RememberedWalletGone origin={origin} />}
      <ul className="plain" data-accounts-to-choose>
        {payingWallets.map((id) => {
          const names = accountNamesOf(id);
          return (
            <li key={id}>
              <p className="m-0 font-medium" data-paying-wallet>{nameOf(id)}</p>
              <ul className="plain ps-4">
                <AccountChoices
                  names={names} group="paying-account" picked={(each) => opens === id && account === each}
                  disabled={busy !== null} onPick={(each) => pickToPay(id, each)}
                  valueFor={(each) => `${id}:${each}`} marked={(each) => ({ 'data-pays-from': `${id}:${each}` })}
                />
              </ul>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
