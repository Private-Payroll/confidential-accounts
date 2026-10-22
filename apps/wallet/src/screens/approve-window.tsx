import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Section, useText } from 'vaults-ui';
import type { Ask } from 'midnight-identity/profile/request';
import type { Channel, Framing } from 'midnight-identity/profile/channel';
import { REGISTRY } from 'midnight-identity/profile/attributes';
import type { LeavesTheWallet } from 'midnight-identity/profile/balance';
import type { Port } from 'midnight-identity/profile/store';
import { useSession } from '../session.js';
import { heldWallets } from '../accounts/wallets-held.js';
import { allPasskeys, walletNameOnRecord } from '../accounts/storage.js';
import { pickedHere, rememberPick, signedInWalletHere } from '../lib/signed-in-here.js';
import { approveBeforeThePasskey, forgetApprovalBeforeThePasskey, useConsent } from '../framing.js';
import { ErrorNote, StatusNote } from '../components/ui.js';
import { StatusAlert } from '../components/status.js';
import { BalanceRefused, readWhatThePageAsks } from '../chain/balance-for-page.js';
import type { LedgerForBalancing, PageAskPays } from '../chain/balance-for-page.js';
import { CompanyOnChain, accountCarriesTheLabel, liveLabelReader, useCompanyCheck } from './company-on-chain.js';
import type { LabelReader } from './company-on-chain.js';
import { FirstSecretToConfirm } from './approve-records-key.js';
import { NIGHT_TOKEN, describeLeaving } from './approve-balance.js';
import { AskOver } from './ask-over.js';

/**
 * **ONE WINDOW FOR AN ASK THAT REACHES A LOCKED WALLET.** It says what the ask does, from the request this wallet
 * parsed and, for a payment, from the transaction it reads itself; Approve asks for the passkey, which opens the
 * wallet, and the opened wallet answers without another press when its own checks agree (`useAnswerAtOnce`).
 * Everything here is what the page sent or what this wallet read from the chain - nothing that needs the wallet open
 * - so every warning a screen gives about the ask is shown before Approve. Decline answers declined. A passkey that
 * is cancelled, times out or fails leaves this window as it was, to press again; a passkey that cannot open the
 * wallet named - none kept here, or another wallet's - says so and offers the list instead.
 *
 * **WHICH WALLET OPENS.** A sign-in offers the list of wallets in this browser when there are two or more, and the
 * one that answers is remembered for that page. Every other ask from that page opens that wallet and offers only
 * its passkeys. The list appears for another ask only when no wallet is kept for the page and this browser holds
 * two or more, or the one kept is no longer held here; the wallet picked there is then kept for the page
 * (`rememberPick`). A sign-in record from before wallets' places were kept preselects the wallet it names.
 */

export type LedgerReader = () => Promise<LedgerForBalancing>;
const liveLedger: LedgerReader = async () =>
  (await import('@midnightntwrk/ledger-v9')) as unknown as LedgerForBalancing;

type Payment =
  | { readonly of: 'reading' }
  | { readonly of: 'read'; readonly leaves: readonly LeavesTheWallet[]; readonly pays: PageAskPays }
  | { readonly of: 'refused'; readonly says: string };

const companyOf = (request: Ask) => (
  request.kind === 'unlock' || request.kind === 'balance' || request.kind === 'committee'
    || request.kind === 'records-key' || request.kind === 'join-code'
    || (request.kind === 'keyring' && request.company !== null)
    ? { label: request.company!, account: request.account } : null);

export function ApproveWindow({
  request, channel, framing, port, readLabel = liveLabelReader, readLedger = liveLedger,
}: {
  readonly request: Ask;
  readonly channel: Channel | null;
  readonly framing: Framing;
  readonly port: Port;
  readonly readLabel?: LabelReader;
  readonly readLedger?: LedgerReader;
}): ReactNode {
  const t = useText();
  const { wallets, walletId, switchTo, unlock, busy, error, passkeyRefused } = useSession();
  const consent = useConsent(framing, request);
  const origin = request.requester.origin;
  const company = companyOf(request);
  const check = useCompanyCheck(company?.label ?? null, company?.account ?? null, readLabel);
  const onChain = company === null || accountCarriesTheLabel(check, company.label);
  const [declined, setDeclined] = useState(false);
  const [tried, setTried] = useState(false);
  /* Said here when the wallet chosen cannot be asked for a passkey at all, before anything is switched or asked. */
  const [cannotOpen, setCannotOpen] = useState<string | null>(null);

  const [payment, setPayment] = useState<Payment>({ of: 'reading' });
  useEffect(() => {
    if (request.kind !== 'balance') return undefined;
    let alive = true;
    setPayment({ of: 'reading' });
    const refuse = (says: string): void => {
      setPayment({ of: 'refused', says });
      channel?.refuse('unreadable');
    };
    readLedger().then((ledger) => {
      if (!alive) return;
      try {
        const read = readWhatThePageAsks(ledger, request.transaction, request.vault);
        setPayment({ of: 'read', leaves: read.leaves, pays: read.pays });
      } catch (e) {
        refuse(e instanceof BalanceRefused ? e.message : t('ask.balance.cannot-read'));
      }
    }, () => { if (alive) refuse(t('ask.balance.cannot-read')); });
    return () => { alive = false; };
    /* `t` and the channel are left out: the read is of the request alone, made once for each request. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, readLedger]);

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

  if (declined) {
    return <AskOver framed={framing.of === 'framed'} />;
  }

  const paymentRead = request.kind !== 'balance' || payment.of === 'read';
  /* Kinds whose screen is pressed once more after the passkey: a disclosure's or a join's choices need the wallet
   * open, and a committee change is signed only after the person has seen every key it adds and removes, read from
   * the chain. */
  const choosesAfter = request.kind === 'disclosure' || request.kind === 'join' || request.kind === 'committee';
  const canApprove = consent.ok && busy === null && channel !== null && onChain && paymentRead;

  const approve = (): void => {
    if (!canApprove) return;
    setCannotOpen(null);
    /* A wallet with no passkey kept here cannot be asked for one; said here rather than switched to, which would
     * replace this window with that wallet's own screen. */
    let passkeys = 0;
    try { passkeys = allPasskeys(opens).length; } catch { passkeys = 0; }
    if (passkeys === 0) {
      setCannotOpen(t('ask.passkey.none-here', { wallet: nameOf(opens) }));
      return;
    }
    approveBeforeThePasskey(request);
    setTried(true);
    /* A wallet picked from the list for an ask that is not a sign-in is kept for this page, so the list is not
     * offered again; a sign-in keeps the wallet that answers it when it is answered. */
    if (offerList && request.kind !== 'sign-in') {
      try { rememberPick(port, origin, opens, held.find((wallet) => wallet.id === opens)?.fingerprint ?? null); } catch { /* the list is offered again */ }
    }
    if (opens !== walletId && switchTo(opens).name !== 'locked') return;
    void unlock({ onlyTheOpenWallet: true, onlyThatWallet: true });
  };
  const decline = (): void => {
    forgetApprovalBeforeThePasskey();
    channel?.refuse('declined');
    setDeclined(true);
  };

  const pays = payment.of === 'read' ? payment.pays : null;
  const headline = request.kind === 'balance' && pays === 'public'
    ? t('ask.balance.headline-public', { origin })
    : request.kind === 'join' ? t('ask.join.headline', { origin })
      : t(`ask.${request.kind === 'addresses-and-balances' ? 'addresses' : request.kind}.headline`, { origin });

  return (
    <>
      <h1 data-ask-window={request.kind} data-headline>{headline}</h1>
      <WhatItDoes request={request} payment={payment} />
      <Warnings request={request} pays={pays} payment={payment} />
      {company !== null && (
        <Section list={false} box={false} aria-label={t('ask.company-title')} title={t('ask.company-title')}>
          <CompanyOnChain
            label={company.label} account={company.account} check={check}
            doing={request.kind === 'balance' ? 'paid' : request.kind === 'unlock' || request.kind === 'keyring' ? 'given' : 'signed'}
            compareWith={t(`ask.${request.kind}.compare`)}
          />
        </Section>
      )}

      {fixed !== null && <p className="m-0 text-sm text-muted-foreground" data-opens-wallet>{t('ask.wallet.opens', { wallet: nameOf(fixed) })}</p>}
      {offerList && (
        <Section
          list={false} box={false} aria-label={t('ask.wallet.choose')} title={t('ask.wallet.choose')}
          description={t('ask.wallet.choose-why', { count: wallets.length })}
        >
          {remembered.of === 'gone' && (
            <StatusAlert tone="warning" role={null} title={t('ask.wallet.gone-title')}>
              <p className="m-0" data-remembered-wallet-gone>{t('ask.wallet.gone', { origin })}</p>
            </StatusAlert>
          )}
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

      <details data-ask-details>
        <summary>{t('ask.details')}</summary>
        <p className="m-0 text-sm" data-requester-name>{t('ask.who.claims', { name: request.requester.name })}</p>
        <p className="m-0 text-sm" data-requester-origin>{t('ask.who.origin', { origin })}</p>
        <p className="m-0 text-sm text-muted-foreground" data-purpose>{t('ask.who.purpose', { purpose: request.purpose })}</p>
      </details>

      {!choosesAfter && <p className="m-0 text-sm text-muted-foreground" data-passkey-is-the-approval>{t('ask.approve-with-passkey')}</p>}
      {/* The buttons stay in sight at the bottom of the frame however long the window is; what must be read before
        * Approve is above them. */}
      <div className="sticky bottom-0 z-10 -mx-1 flex flex-col gap-2 border-t border-border bg-background px-1 py-3" data-ask-actions>
      <div className="flex flex-wrap gap-2">
        <Button size="lg" type="button" variant="default" onClick={approve} disabled={!canApprove} data-approve data-approve-window>
          {request.kind === 'committee' ? t('ask.committee.approve') : choosesAfter ? t('ask.disclosure.approve') : t('ask.approve')}
        </Button>
        <Button size="lg" type="button" variant="ghost" onClick={decline} disabled={busy !== null} data-decline>
          {t('ask.decline')}
        </Button>
        {!consent.ok && <p className="m-0 w-full text-sm text-muted-foreground" data-consent-refused>{consent.says.charAt(0).toUpperCase() + consent.says.slice(1)}</p>}
      </div>
      <StatusNote message={busy === null ? null : t('ask.waiting-for-passkey')} />
      <ErrorNote message={cannotOpen ?? error} />
      {tried && error !== null && busy === null && !refused && <p className="m-0 text-sm text-muted-foreground" data-passkey-again>{t('ask.passkey-again')}</p>}
      </div>
    </>
  );
}

/** What the ask does, in plain words, from the request and - for a payment - the transaction this wallet read. */
function WhatItDoes({ request, payment }: { readonly request: Ask; readonly payment: Payment }): ReactNode {
  const t = useText();
  const origin = request.requester.origin;
  const lede = (text: string) => <p className="lede" data-what-it-does>{text}</p>;
  switch (request.kind) {
    case 'sign-in': return lede(t('ask.sign-in.lede', { origin }));
    case 'unlock': return lede(t('ask.unlock.lede', { origin }));
    case 'keyring': return (
      <>
        {lede(t('ask.keyring.lede'))}
        <p className="m-0 text-sm" data-keyring-person>{t('ask.keyring.person', { person: request.person })}</p>
        {request.signedInAs !== null && <p className="m-0 text-sm" data-signed-in-as>{t('ask.keyring.signed-in-as', { address: request.signedInAs })}</p>}
        {request.drawLabel && <p className="m-0 text-sm" data-new-company>{t('ask.keyring.new-company')}</p>}
      </>
    );
    case 'balance':
      if (payment.of === 'reading') return <p className="lede" data-reading>{t('ask.balance.reading')}</p>;
      if (payment.of === 'refused') {
        return (
          <StatusAlert tone="danger" title={t('ask.balance.refused-title')}>
            <p className="m-0" data-balance-refused>{payment.says}</p>
          </StatusAlert>
        );
      }
      return (
        <Section list={false} box={false} aria-label={t('ask.balance.leaves-title')} title={t('ask.balance.leaves-title')} description={t('ask.balance.leaves-why')}>
          <div data-leaves>
            {payment.leaves.map((l) => (
              <div key={`${l.kind}:${l.token}`}>
                <p className="m-0 text-foreground text-lg" data-leaving-amount>{describeLeaving(l)}</p>
                <p className="m-0 font-mono break-all text-sm text-muted-foreground" data-leaving-token>{t('ask.balance.token', { kind: l.kind, token: l.token })}</p>
              </div>
            ))}
          </div>
          <p className="m-0 text-sm text-muted-foreground" data-no-fee>{t('ask.balance.no-fee')}</p>
          <p className="m-0 text-sm text-muted-foreground" data-which-account-pays>{t('ask.balance.which-account')}</p>
          <p className="m-0 text-sm text-muted-foreground break-all" data-vault>{t('ask.balance.vault', { vault: request.vault })}</p>
        </Section>
      );
    case 'committee': return (
      <>
        {lede(t(`ask.committee.${request.press}`))}
        <p className="m-0 text-sm" data-new-committee>{t('ask.committee.to', { count: request.to.committee.length, threshold: request.to.threshold })}</p>
        <p className="m-0 text-sm" data-checked-after-the-passkey>{t('ask.committee.check')}</p>
      </>
    );
    case 'records-key': return (
      <>
        {lede(t('ask.records-key.lede'))}
        <p className="m-0 text-sm break-all" data-records-key-seat>{t('ask.records-key.seat', { seat: request.seat })}</p>
        {request.signingKey !== undefined && <p className="m-0 text-sm break-all" data-directory-entry-key>{t('ask.records-key.directory', { key: request.signingKey })}</p>}
        {request.vault !== undefined && request.firstSecret !== undefined && <FirstSecretToConfirm vault={request.vault} firstSecret={request.firstSecret} />}
        <p className="m-0 text-sm" data-compare-fingerprint>{t('ask.records-key.compare-press')}</p>
      </>
    );
    case 'creation': return (
      <>
        {lede(t('ask.creation.lede'))}
        <p className="m-0 text-sm" data-held-by-you>{t('ask.creation.held')}</p>
        <p className="m-0 text-sm" data-label>{t('ask.creation.label')}</p>
        <p className="m-0 font-mono text-sm break-all" data-label-given>{request.company}</p>
        <p className="m-0 text-sm" data-shown-after>{t('ask.creation.after')}</p>
      </>
    );
    case 'join-code': return (
      <>
        {lede(request.parts.kind === 'signer' ? t('ask.join-code.lede-signer') : t('ask.join-code.lede-payee', { address: request.parts.address }))}
        <p className="m-0 text-sm break-all" data-join-code-person>{t('ask.join-code.person', { person: request.person })}</p>
      </>
    );
    case 'addresses-and-balances': return lede(t('ask.addresses.lede', { origin }));
    case 'disclosure':
    case 'join': return (
      <>
        {lede(t('ask.disclosure.lede'))}
        <ul className="m-0 ps-6" data-asked-for>
          {request.wants.map((want) => {
            const label = REGISTRY.definitionOf(want.attribute)?.render.label ?? want.attribute;
            return <li key={want.attribute} className="text-sm">{t(want.required ? 'ask.disclosure.wants' : 'ask.disclosure.wants-optional', { label })}</li>;
          })}
        </ul>
        {request.kind === 'join' && <p className="m-0 text-sm break-all" data-inbox-key>{t('ask.join.sealed', { key: request.inboxPublicKey })}</p>}
      </>
    );
    default: return null;
  }
}

/** The warnings a screen gives about this ask, kept in sight above Approve. */
function Warnings({ request, pays, payment }: {
  readonly request: Ask; readonly pays: PageAskPays | null; readonly payment: Payment;
}): ReactNode {
  const t = useText();
  const origin = request.requester.origin;
  if (request.kind === 'sign-in') {
    return (
      <StatusAlert tone="warning" role={null} title={t('ask.sign-in.warn-title')}>
        <p className="m-0" data-warning>{t('ask.sign-in.warn', { origin })}</p>
      </StatusAlert>
    );
  }
  if (request.kind === 'unlock' || request.kind === 'keyring') {
    return (
      <StatusAlert tone="warning" role={null} title={t('ask.warn.given-title')}>
        <p className="m-0" data-warning>{t('ask.warn.how-long')}</p>
        <p className="m-0" data-warning>{t('ask.warn.given')}</p>
      </StatusAlert>
    );
  }
  if (request.kind === 'balance' && payment.of === 'read') {
    return (
      <>
        {pays === 'public' && (
          <StatusAlert tone="warning" role={null} title={t('ask.balance.public-title')}>
            <p className="m-0" data-public-deposit>{t('ask.balance.public')}</p>
            {payment.leaves.some((l) => l.token === NIGHT_TOKEN) && <p className="m-0" data-night-stops-dust>{t('ask.balance.night-stops-dust')}</p>}
          </StatusAlert>
        )}
        <StatusAlert tone="warning" role={null} title={t('ask.balance.paid-title')}>
          <p className="m-0" data-warning>{t('ask.balance.paid')}</p>
        </StatusAlert>
      </>
    );
  }
  return null;
}
