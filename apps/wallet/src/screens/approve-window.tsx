import type { Channel, Framing } from 'midnight-identity/profile/channel';
import {
  type AccountAddress,
  type CompanyLabel,
  readAccountAddress,
  readCompanyLabel
} from 'midnight-identity/profile/company-label';
import { type Ask, intentShapeOf } from 'midnight-identity/profile/request';
import type { Port } from 'midnight-identity/profile/store';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Button, Section, useText } from 'vaults-ui';

import { allPasskeys } from '../accounts/passkey-records.js';
import { actionFor } from '../actions/registry.js';
import { useShown } from '../actions/runner-screen.js';
import type { LedgerForBalancing } from '../chain/balance-for-page.js';
import { BalanceRefused, readWhatThePageAsksToBalance } from '../chain/balance-for-page.js';
import { ErrorNote, StatusNote } from '../components/ui.js';
import { approveBeforeThePasskey, type Consent, forgetApprovalBeforeThePasskey, useConsent } from '../framing.js';
import { rememberPick } from '../lib/signed-in-here.js';
import { type Session, useSession } from '../session.js';
import { isPayingAsk } from './approve-slot.js';
import type { Payment } from './approve-window-says.js';
import { headlineFor, Warnings, WhatItDoes } from './approve-window-says.js';
import { useWalletThatOpens, WhichWalletOpens } from './approve-window-wallets.js';
import { AskOver } from './ask-over.js';
import type { CompanyCheck, LabelReader } from './company-on-chain.js';
import { accountCarriesTheLabel, CompanyOnChain, liveLabelReader, useCompanyCheck } from './company-on-chain.js';
import { forgetPayingPick, keepPayingPick } from './paying-pick.js';

/* The window for an ask that reaches a locked wallet. Everything it shows was sent by the page or read by this wallet
 * itself, so every warning about the ask is seen before Approve; the passkey then opens the wallet that answers. */

export type LedgerReader = () => Promise<LedgerForBalancing>;
const liveLedger: LedgerReader = async () => import('@midnightntwrk/ledger-v9');

const companyOf = (request: Ask): { readonly label: CompanyLabel; readonly account: AccountAddress | null } | null => {
  if (request.kind === 'act') {
    const { company, account } = request.intent.fields;
    /* An intent with no account field acts on a company not yet on the chain, so there is no label to read here;
     * the action checks that company itself before its first step. */
    if (!Object.prototype.hasOwnProperty.call(intentShapeOf(request.intent.name)?.fields ?? {}, 'account')) return null;
    const label = readCompanyLabel(company);
    return label === null ? null : { label, account: readAccountAddress(account) };
  }
  return request.kind === 'unlock' ||
    request.kind === 'balance' ||
    request.kind === 'committee' ||
    request.kind === 'records-key' ||
    request.kind === 'join-code' ||
    (request.kind === 'keyring' && request.company !== null)
    ? { label: request.company!, account: request.account }
    : null;
};

const READING: Payment = { of: 'reading' };

/** What the page asks this wallet to balance, read from its transaction before anything is unlocked. */
function usePaymentRead(request: Ask, channel: Channel | null, readLedger: LedgerReader): Payment {
  const t = useText();
  /* Kept with the request and reader it was read for, so a new request reads as `reading` until its own read lands. */
  const [read, setRead] = useState<{
    readonly request: Ask;
    readonly readLedger: LedgerReader;
    readonly payment: Payment;
  } | null>(null);
  useEffect(() => {
    if (request.kind !== 'balance') return undefined;
    let alive = true;
    const settle = (payment: Payment): void => setRead({ request, readLedger, payment });
    const refuse = (says: string): void => {
      settle({ of: 'refused', says });
      channel?.refuse('unreadable');
    };
    readLedger().then(
      (ledger) => {
        if (!alive) return;
        try {
          const found = readWhatThePageAsksToBalance(ledger, request.transaction, request.vault);
          settle({ of: 'read', leaves: found.leaves, pays: found.pays });
        } catch (e) {
          refuse(e instanceof BalanceRefused ? e.message : t('ask.balance.cannot-read'));
        }
      },
      () => {
        if (alive) refuse(t('ask.balance.cannot-read'));
      }
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` and the channel are left out: the read is of the request alone, made once for each request.
  }, [request, readLedger]);
  return read !== null && read.request === request && read.readLedger === readLedger ? read.payment : READING;
}

/** How many passkeys this browser keeps for a wallet; none when they cannot be read. */
const passkeysKept = (walletId: string): number => {
  try {
    return allPasskeys(walletId).length;
  } catch {
    // Storage this page cannot read keeps no passkey it could use.
    return 0;
  }
};

function useCompanyOnChain(
  request: Ask,
  readLabel: LabelReader
): { readonly company: ReturnType<typeof companyOf>; readonly check: CompanyCheck; readonly onChain: boolean } {
  const company = companyOf(request);
  const check = useCompanyCheck(company?.label ?? null, company?.account ?? null, readLabel);
  /* A company named beside opening the saved keys holds nothing up: once the check has read, its key is given or not. */
  const openedCompany = request.kind === 'keyring' && request.companyIfOnChain === true;
  const onChain =
    company === null || accountCarriesTheLabel(check, company.label) || (openedCompany && check.of !== 'checking');
  return { company, check, onChain };
}

/** The ask's company as this wallet read it on the chain. */
function CompanySection({
  request,
  company,
  check
}: {
  readonly request: Ask;
  readonly company: { readonly label: CompanyLabel; readonly account: AccountAddress | null };
  readonly check: CompanyCheck;
}): ReactNode {
  const t = useText();
  return (
    <Section list={false} box={false} aria-label={t('ask.company-title')} title={t('ask.company-title')}>
      <CompanyOnChain
        label={company.label}
        account={company.account}
        check={check}
        doing={
          request.kind === 'balance'
            ? 'paid'
            : request.kind === 'unlock' || request.kind === 'keyring'
              ? 'given'
              : 'signed'
        }
        compareWith={t(`ask.${request.kind}.compare`)}
      />
    </Section>
  );
}

/** Who asked, as the page names itself and as the browser saw it, and why. */
function AskDetails({ request }: { readonly request: Ask }): ReactNode {
  const t = useText();
  return (
    <details data-ask-details>
      <summary>{t('ask.details')}</summary>
      <p className="m-0 text-sm" data-requester-name>
        {t('ask.who.claims', { name: request.requester.name })}
      </p>
      <p className="m-0 text-sm" data-requester-origin>
        {t('ask.who.origin', { origin: request.requester.origin })}
      </p>
      <p className="m-0 text-sm text-muted-foreground" data-purpose>
        {t('ask.who.purpose', { purpose: request.purpose })}
      </p>
    </details>
  );
}

/** Approve and Decline, with what stands in the way of Approve and what the passkey said. */
function ApproveActions({
  request,
  choosesAfter,
  canApprove,
  approve,
  decline,
  consent,
  busy,
  error,
  cannotOpen,
  tried,
  refused
}: {
  readonly request: Ask;
  readonly choosesAfter: boolean;
  readonly canApprove: boolean;
  readonly approve: () => void;
  readonly decline: () => void;
  readonly consent: Consent;
  readonly busy: Session['busy'];
  readonly error: Session['error'];
  readonly cannotOpen: string | null;
  readonly tried: boolean;
  readonly refused: boolean;
}): ReactNode {
  const t = useText();
  return (
    <>
      {!choosesAfter && (
        <p className="m-0 text-sm text-muted-foreground" data-passkey-is-the-approval>
          {t('ask.approve-with-passkey')}
        </p>
      )}
      {/* The buttons stay in sight at the bottom of the frame however long the window is; what must be read before
       * Approve is above them. */}
      <div
        className="sticky bottom-0 z-10 -mx-1 flex flex-col gap-2 border-t border-border bg-background px-1 py-3"
        data-ask-actions
      >
        <div className="flex flex-wrap gap-2">
          <Button
            size="lg"
            type="button"
            variant="default"
            onClick={approve}
            disabled={!canApprove}
            data-approve
            data-approve-window
          >
            {request.kind === 'committee'
              ? t('ask.committee.approve')
              : choosesAfter
                ? t('ask.disclosure.approve')
                : t('ask.approve')}
          </Button>
          <Button size="lg" type="button" variant="ghost" onClick={decline} disabled={busy !== null} data-decline>
            {t('ask.decline')}
          </Button>
          {!consent.ok && (
            <p className="m-0 w-full text-sm text-muted-foreground" data-consent-refused>
              {consent.says.charAt(0).toUpperCase() + consent.says.slice(1)}
            </p>
          )}
        </div>
        <StatusNote message={busy === null ? null : t('ask.waiting-for-passkey')} />
        <ErrorNote message={cannotOpen ?? error} />
        {tried && error !== null && busy === null && !refused && (
          <p className="m-0 text-sm text-muted-foreground" data-passkey-again>
            {t('ask.passkey-again')}
          </p>
        )}
      </div>
    </>
  );
}

export function ApproveWindow({
  request,
  channel,
  framing,
  port,
  readLabel = liveLabelReader,
  readLedger = liveLedger
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
  const { company, check, onChain } = useCompanyOnChain(request, readLabel);
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
  /* Kinds pressed once more after the passkey: their choices need the wallet open, and a committee change is signed
   * only after every key it adds and removes has been read from the chain and seen. */
  const choosesAfter = request.kind === 'disclosure' || request.kind === 'join' || request.kind === 'committee';
  const canApprove =
    consent.ok && busy === null && channel !== null && onChain && paymentRead && actionRead && !retired;

  const approve = (): void => {
    if (!canApprove) return;
    setCannotOpen(null);
    /* A wallet with no passkey kept here cannot be asked for one; said here rather than switched to, which would
     * replace this window with that wallet's own screen. */
    if (passkeysKept(opens) === 0) {
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
      try {
        rememberPick(port, origin, opens, held.find((wallet) => wallet.id === opens)?.fingerprint ?? null);
      } catch {
        /* the list is offered again */
      }
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
      <h1 data-ask-window={request.kind} data-headline>
        {headline}
      </h1>
      <WhatItDoes request={request} payment={payment} action={action} shown={shown} />
      <Warnings request={request} pays={pays} payment={payment} />
      {company !== null && <CompanySection request={request} company={company} check={check} />}

      <WhichWalletOpens request={request} which={which} busy={busy} />

      <AskDetails request={request} />

      <ApproveActions
        request={request}
        choosesAfter={choosesAfter}
        canApprove={canApprove}
        approve={approve}
        decline={decline}
        consent={consent}
        busy={busy}
        error={error}
        cannotOpen={cannotOpen}
        tried={tried}
        refused={refused}
      />
    </>
  );
}
