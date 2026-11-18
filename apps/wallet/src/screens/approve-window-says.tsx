import type { ReactNode } from 'react';
import { Section, useText } from 'vaults-ui';
import type { Ask } from 'midnight-identity/profile/request';
import { REGISTRY } from 'midnight-identity/profile/attributes';
import type { LeavesTheWallet } from 'midnight-identity/profile/balance';
import { StatusAlert } from '../components/status.js';
import type { PageAskPays } from '../chain/balance-for-page.js';
import { FirstSecretToConfirm } from './approve-records-key.js';
import { NIGHT_TOKEN, describeLeaving } from './approve-balance.js';
import { ActWhatItDoes } from '../actions/runner-screen.js';
import type { ShownState } from '../actions/runner-screen.js';
import type { ActionDefinition } from '../actions/definition.js';

export type Payment =
  | { readonly of: 'reading' }
  | { readonly of: 'read'; readonly leaves: readonly LeavesTheWallet[]; readonly pays: PageAskPays }
  | { readonly of: 'refused'; readonly says: string };


/** What the ask does, in plain words, from the request and - for a payment - the transaction this wallet read. */
export function WhatItDoes({ request, payment, action, shown }: {
  readonly request: Ask; readonly payment: Payment; readonly action: ActionDefinition | null; readonly shown: ShownState;
}): ReactNode {
  const t = useText();
  const origin = request.requester.origin;
  const lede = (text: string) => <p className="lede" data-what-it-does>{text}</p>;
  switch (request.kind) {
    case 'sign-in': return lede(t('ask.sign-in.lede', { origin }));
    case 'unlock': return lede(t('ask.unlock.lede', { origin }));
    case 'keyring': return <KeyringAskShown request={request} />;
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
          <p className="m-0 text-sm text-muted-foreground" data-which-account-pays>{t('ask.pays.which-account')}</p>
          <p className="m-0 text-sm text-muted-foreground break-all" data-vault>{t('ask.balance.vault', { vault: request.vault })}</p>
        </Section>
      );
    case 'committee': return <CommitteeAskShown request={request} />;
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
      <StatusAlert tone="danger" title={t('ask.creation.retired-title')}>
        <p className="m-0" data-creation-retired>{t('ask.creation.retired')}</p>
      </StatusAlert>
    );
    case 'join-code': return (
      <>
        {lede(request.parts.kind === 'signer' ? t('ask.join-code.lede-signer') : request.parts.kind === 'payee' ? t('ask.join-code.lede-payee', { address: request.parts.address }) : t('ask.join-code.lede-reader'))}
        <p className="m-0 text-sm break-all" data-join-code-person>{t('ask.join-code.person', { person: request.person })}</p>
      </>
    );
    case 'addresses-and-balances': return lede(t('ask.addresses.lede', { origin }));
    case 'act':
      if (action === null) {
        return (
          <StatusAlert tone="danger" title={t('ask.act.not-run-title')}>
            <p className="m-0" data-act-not-run>{t('ask.act.not-run')}</p>
          </StatusAlert>
        );
      }
      return <ActWhatItDoes request={request} action={action} shown={shown} />;
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

/** What a keyring ask gives, before the passkey: whose saved keys, and the company named beside them. */
function KeyringAskShown({ request }: { request: Extract<Ask, { kind: 'keyring' }> }) {
  const t = useText();
  const lede = (text: string) => <p className="lede" data-what-it-does>{text}</p>;
  return (
    <>
      {lede(t('ask.keyring.lede'))}
      <p className="m-0 text-sm" data-keyring-person>{t('ask.keyring.person', { person: request.person })}</p>
      {request.signedInAs !== null && <p className="m-0 text-sm" data-signed-in-as>{t('ask.keyring.signed-in-as', { address: request.signedInAs })}</p>}
      {request.drawLabel && <p className="m-0 text-sm" data-new-company>{t('ask.keyring.new-company')}</p>}
      {request.companyIfOnChain === true && <p className="m-0 text-sm" data-also-company>{t('ask.keyring.also-company')}</p>}
      {request.drawLabel && request.founding !== undefined && (
        <p className="m-0 text-sm" data-shown-from="page" data-founding>
          {t('ask.keyring.founding', { name: request.founding.name, signer: request.founding.signer.name, role: request.founding.signer.role })}
        </p>
      )}
    </>
  );
}

/** What a committee ask does, before the passkey: a request to the company's service changes nothing; a change says what it installs. */
function CommitteeAskShown({ request }: { request: Extract<Ask, { kind: 'committee' }> }) {
  const t = useText();
  if (request.press === 'request') {
    return (
      <>
        <p className="lede" data-what-it-does>{t('ask.committee.request')}</p>
        <p className="m-0 text-sm" data-checked-after-the-passkey>{t('ask.committee.request-check')}</p>
      </>
    );
  }
  return (
    <>
      <p className="lede" data-what-it-does>{t(`ask.committee.${request.press}`)}</p>
      <p className="m-0 text-sm" data-new-committee>{t('ask.committee.to', { count: request.to.committee.length, threshold: request.to.threshold })}</p>
      <p className="m-0 text-sm" data-checked-after-the-passkey>{t('ask.committee.check')}</p>
    </>
  );
}

/** The warnings a screen gives about this ask, kept in sight above Approve. */
export function Warnings({ request, pays, payment }: {
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
  if (request.kind === 'act') {
    return (
      <StatusAlert tone="warning" role={null} title={t('ask.act.sent-title')}>
        <p className="m-0" data-warning>{t('ask.act.sent')}</p>
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

/** The window's headline: what the ask does, in one line. */
export function headlineFor(
  request: Ask, pays: PageAskPays | null, action: ActionDefinition | null, t: (key: string, values?: Record<string, unknown>) => string,
): string {
  const origin = request.requester.origin;
  return request.kind === 'balance' && pays === 'public'
    ? t('ask.balance.headline-public', { origin })
    : request.kind === 'join' ? t('ask.join.headline', { origin })
      : request.kind === 'committee' && request.press === 'request' ? t('ask.committee.request-headline', { origin })
      : request.kind === 'act' ? t(action?.headline ?? 'ask.act.headline', { origin })
      : t(`ask.${request.kind === 'addresses-and-balances' ? 'addresses' : request.kind}.headline`, { origin });
}
