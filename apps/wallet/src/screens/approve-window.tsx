import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Section, useText } from 'vaults-ui';
import { intentShapeOf, type Ask } from 'midnight-identity/profile/request';
import type { Channel, Framing } from 'midnight-identity/profile/channel';
import type { Port } from 'midnight-identity/profile/store';
import { useSession } from '../session.js';
import { allPasskeys } from '../accounts/passkey-records.js';
import { rememberPick } from '../lib/signed-in-here.js';
import { approveBeforeThePasskey, forgetApprovalBeforeThePasskey, useConsent } from '../framing.js';
import { ErrorNote, StatusNote } from '../components/ui.js';
import { BalanceRefused, readWhatThePageAsksToBalance } from '../chain/balance-for-page.js';
import type { LedgerForBalancing } from '../chain/balance-for-page.js';
import { CompanyOnChain, accountCarriesTheLabel, liveLabelReader, useCompanyCheck } from './company-on-chain.js';
import type { LabelReader } from './company-on-chain.js';
import { AskOver } from './ask-over.js';
import type { CompanyLabel, AccountAddress } from 'midnight-identity/profile/company-label';
import { actionFor } from '../actions/registry.js';
import { useShown } from '../actions/runner-screen.js';
import { Warnings, WhatItDoes, headlineFor } from './approve-window-says.js';
import type { Payment } from './approve-window-says.js';
import { WhichWalletOpens, useWalletThatOpens } from './approve-window-wallets.js';
import { isPayingAsk } from './approve-slot.js';
import { forgetPayingPick, keepPayingPick } from './paying-pick.js';

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
 *
 * **WHICH ACCOUNT PAYS.** An ask that pays (an action that pays, or a payment to balance) lists the accounts of those
 * same wallets, each under its wallet, in place of the list of wallets: the person picks the account once, here, and
 * the passkey opens the wallet it is in. The pick is kept for this ask (`keepPayingPick`); the opened wallet pays from
 * that account only, and pays nothing when it is not the wallet picked.
 *
 * **AN ACTION (`act`)** shows its three lists from its definition: what it acts on, each line this wallet's own
 * read or marked as the page's words; its steps; and what is checked after the passkey. An action this wallet has
 * no definition for, or whose lines cannot be read, is never offered for Approve.
 */

export type LedgerReader = () => Promise<LedgerForBalancing>;
const liveLedger: LedgerReader = async () =>
  (await import('@midnightntwrk/ledger-v9')) as unknown as LedgerForBalancing;

const companyOf = (request: Ask): { readonly label: CompanyLabel; readonly account: AccountAddress | null } | null => {
  if (request.kind === 'act') {
    const { company, account } = request.intent.fields;
    /* An action whose intent names no account acts on a company not yet on the chain (finishing a company deploys
     * its account), so there is no account to read its label from; the action checks the company itself, as one this
     * wallet drew, before its first step. Every intent that names an account must carry it, and is checked here. */
    if (!Object.prototype.hasOwnProperty.call(intentShapeOf(request.intent.name)?.fields ?? {}, 'account')) return null;
    return company === undefined ? null
      : { label: company as CompanyLabel, account: account === undefined ? null : account as AccountAddress };
  }
  return request.kind === 'unlock' || request.kind === 'balance' || request.kind === 'committee'
    || request.kind === 'records-key' || request.kind === 'join-code'
    || (request.kind === 'keyring' && request.company !== null)
    ? { label: request.company!, account: request.account } : null;
};

/** What the page asks this wallet to balance, read from its transaction before anything is unlocked. */
function usePaymentRead(request: Ask, channel: Channel | null, readLedger: LedgerReader): Payment {
  const t = useText();
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
        const read = readWhatThePageAsksToBalance(ledger, request.transaction, request.vault);
        setPayment({ of: 'read', leaves: read.leaves, pays: read.pays });
      } catch (e) {
        refuse(e instanceof BalanceRefused ? e.message : t('ask.balance.cannot-read'));
      }
    }, () => { if (alive) refuse(t('ask.balance.cannot-read')); });
    return () => { alive = false; };
    /* `t` and the channel are left out: the read is of the request alone, made once for each request. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, readLedger]);
  return payment;
}

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
  const { walletId, switchTo, unlock, busy, error } = useSession();
  const consent = useConsent(framing, request);
  const origin = request.requester.origin;
  const company = companyOf(request);
  const check = useCompanyCheck(company?.label ?? null, company?.account ?? null, readLabel);
  /* A company named beside opening the saved keys holds nothing up: once the check has read, its key is given or not. */
  const openedCompany = request.kind === 'keyring' && request.companyIfOnChain === true;
  const onChain = company === null || accountCarriesTheLabel(check, company.label) || (openedCompany && check.of !== 'checking');
  const [declined, setDeclined] = useState(false);
  const [tried, setTried] = useState(false);
  /* Said here when the wallet chosen cannot be asked for a passkey at all, before anything is switched or asked. */
  const [cannotOpen, setCannotOpen] = useState<string | null>(null);

  const payment = usePaymentRead(request, channel, readLedger);
  /* An action's definition and what it shows before the passkey; an action this wallet does not run is refused at once. */
  const acting = request.kind === 'act' ? request : null;
  const action = useMemo(() => (acting === null ? null : actionFor(acting.intent.name)), [acting]);
  const shown = useShown(acting, action);
  const notRun = acting !== null && action === null;
  /* A page that still sends a deploy it built for this wallet to sign is refused at once: finishing a company is an action. */
  const retired = request.kind === 'creation';
  useEffect(() => {
    if (notRun || retired) channel?.refuse('unreadable');
  }, [notRun, retired, channel]);
  const which = useWalletThatOpens(request, port, cannotOpen);
  const { held, refused, offerList, opens, nameOf } = which;

  if (declined) {
    return <AskOver framed={framing.of === 'framed'} />;
  }

  const paymentRead = request.kind !== 'balance' || payment.of === 'read';
  const actionRead = request.kind !== 'act' || (action !== null && shown.of === 'read');
  /* Kinds whose screen is pressed once more after the passkey: a disclosure's or a join's choices need the wallet
   * open, and a committee change is signed only after the person has seen every key it adds and removes, read from
   * the chain. */
  const choosesAfter = request.kind === 'disclosure' || request.kind === 'join' || request.kind === 'committee';
  const canApprove = consent.ok && busy === null && channel !== null && onChain && paymentRead && actionRead && !retired;

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
    /* An ask that pays pays from the account picked here, and from no other: kept for this ask, checked once open. */
    if (isPayingAsk(request)) keepPayingPick(request, which.payingPick());
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
    forgetPayingPick();
    channel?.refuse('declined');
    setDeclined(true);
  };

  const pays = payment.of === 'read' ? payment.pays : null;
  const headline = headlineFor(request, pays, action, t);

  return (
    <>
      <h1 data-ask-window={request.kind} data-headline>{headline}</h1>
      <WhatItDoes request={request} payment={payment} action={action} shown={shown} />
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

      <WhichWalletOpens request={request} which={which} busy={busy} />

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
