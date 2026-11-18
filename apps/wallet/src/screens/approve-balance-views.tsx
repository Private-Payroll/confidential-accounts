import type { ReactNode } from 'react';
import type { BalanceRequest } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import type { LeavesTheWallet } from 'midnight-identity/profile/balance';
import { CompanyOnChain } from './company-on-chain.js';
import { Button, Section } from 'vaults-ui';
import { StatusAlert } from '../components/status.js';
import { hrefOf } from '../routes.js';
import type { PageAskPays, UnboundTransactionLike } from '../chain/balance-for-page.js';
import { nightFromStars } from '../chain/amount.js';
import type { Consent } from '../framing.js';
import type { CompanyCheck } from './company-on-chain.js';

/** One figure, in words a person reads. NIGHT is named; any other token is shown by its identifier. */
export const NIGHT_TOKEN = '0'.repeat(64);
export const describeLeaving = (l: LeavesTheWallet): string =>
  l.kind === 'unshielded' && l.token === NIGHT_TOKEN
    ? `${nightFromStars(BigInt(l.amount))} NIGHT, from your public balance`
    : `${l.amount} base units of the ${l.kind === 'shielded' ? 'private' : 'public'} token below`;

export type Stage =
  | { of: 'reading' }
  | { of: 'ready'; tx: UnboundTransactionLike; leaves: LeavesTheWallet[]; pays: PageAskPays }
  | { of: 'refused'; says: string }
  /** `reading`: the wallet is still reading the chain, nothing is booked, and the person may still say no. */
  | { of: 'paying'; reading: boolean; proving: boolean; leaves: LeavesTheWallet[]; pays: PageAskPays }
  | { of: 'failed'; says: string; leaves: LeavesTheWallet[]; pays: PageAskPays }
  | { of: 'sent'; at: number; leaves: LeavesTheWallet[]; pays: PageAskPays };

/** What this wallet cannot check of the vault, and the one check that is made: by the company's own service, and only there. */
const VAULT_CHECK = 'This wallet cannot check that the vault belongs to that company. If this page is run by the company\u2019s own service, '
  + 'that service will not send a deposit into a vault it did not see created for the company and that is not pinned to the '
  + 'company\u2019s account on the chain. A page run by someone else gives you no such check. Compare the vault with one the '
  + 'company gave you another way.';

/** The coins that leave this wallet, one block each. */
export const leavingList = (leaves: readonly LeavesTheWallet[]) => (
  <div data-leaves>
    {leaves.map((l) => (
      <div key={`${l.kind}:${l.token}`} style={{ marginBottom: '0.5rem' }}>
        <p className="m-0 text-foreground text-lg" data-leaving-amount>{describeLeaving(l)}</p>
        <p className="m-0 font-mono break-all text-sm text-muted-foreground" data-leaving-token>{`${l.kind} token ${l.token}`}</p>
      </div>
    ))}
  </div>
);

/** Where the money goes: the company as the page names it, and the vault. */
function WhereTheMoneyGoes({ request, check, publicly }: {
  readonly request: BalanceRequest;
  readonly check: CompanyCheck;
  readonly publicly: boolean;
}): ReactNode {
  return (
    <Section
      list={false} box={false} aria-label="Where the money goes"
      title="Where the money goes"
      description={publicly
        ? 'What the page says. This wallet checked that the transaction calls this vault\'s public deposit and nothing else, and that it puts exactly the amount shown above into this vault.'
        : 'What the page says. This wallet checked that the transaction calls this vault and nothing else, and that the one coin it creates belongs to this vault.'}
    >
      <p className="m-0 text-sm text-muted-foreground">The company, as the page names it</p>
      <CompanyOnChain
        label={request.company} account={request.account} check={check} doing="paid"
        compareWith="the person at this company who asked you to pay gave you themselves, and not through this page"
      />
      <p className="m-0 text-sm text-muted-foreground" style={{ marginTop: '0.75rem' }}>The vault the transaction pays into</p>
      <p className="m-0 font-mono break-all text-foreground text-lg" data-vault>{request.vault}</p>
      <p className="m-0 text-sm text-muted-foreground" data-vault-check>{VAULT_CHECK}</p>
    </Section>
  );
}

/** The page after this wallet has added its coins and handed the transaction back. */
export function PaidPublicly({ request, stage }: {
  readonly request: BalanceRequest;
  readonly stage: Extract<Stage, { of: 'sent' }>;
}): ReactNode {
  return (
    <>
      <h1 data-paid-heading>{`You paid publicly for a deposit for ${request.requester.origin}`}</h1>
      <p className="lede" data-paid>
        {`On ${new Date(stage.at).toLocaleString()} this wallet added the public money below to the deposit and handed it back. `}
        The company&rsquo;s service sends it. Until the chain has it, nothing has moved, and your public balance still
        shows this money. Do not spend it elsewhere first, or this deposit will fail.
      </p>
      {leavingList(stage.leaves)}
      <p className="m-0 font-mono break-all text-sm text-muted-foreground">{request.vault}</p>
      <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>&larr; Your wallet</a></p>
    </>
  );
}

/** The page after this wallet has added its coins and handed the transaction back. */
export function PaidPrivately({ request, stage }: {
  readonly request: BalanceRequest;
  readonly stage: Extract<Stage, { of: 'sent' }>;
}): ReactNode {
  return (
    <>
      <h1 data-paid-heading>{`You paid for a deposit for ${request.requester.origin}`}</h1>
      <p className="lede" data-paid>
        {`On ${new Date(stage.at).toLocaleString()} this wallet added the coins below to the transaction and handed it back. `}
        The company&rsquo;s service sends it. Until the chain has it, nothing has moved, and the coins it uses are set
        aside in this wallet. If the transaction is never sent, they may stay set aside.
      </p>
      {leavingList(stage.leaves)}
      <p className="m-0 font-mono break-all text-sm text-muted-foreground">{request.vault}</p>
      <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>&larr; Your wallet</a></p>
    </>
  );
}

/** What leaves this wallet, and on a public deposit, that it is public. */
function WhatLeaves({ stage }: { readonly stage: Exclude<Stage, { of: 'sent' }> }): ReactNode {
  const publicly = stage.of !== 'reading' && stage.of !== 'refused' && stage.pays === 'public';
  return (
    <>
      {(stage.of === 'ready' || stage.of === 'paying' || stage.of === 'failed') && (
        <Section
          list={false} box={false} aria-label="What leaves this wallet"
          title="What leaves this wallet"
          description="Worked out from the transaction itself, not from anything the page said."
        >
          {leavingList(stage.leaves)}
          <p className="m-0 text-sm text-muted-foreground" data-no-fee>
            You pay no network fee. The company pays it.
          </p>
        </Section>
      )}
      {publicly && (
        <StatusAlert tone="warning" role={null} title="This deposit is public">
          <p className="m-0" data-public-deposit>
            The token and the amount above leave your public balance, and anyone reading the chain can see them, your
            wallet&rsquo;s public address, and the vault they went into.
          </p>
          {stage.leaves.some((l) => l.token === NIGHT_TOKEN) && (
            <p className="m-0" data-night-stops-dust>
              NIGHT that goes into the vault no longer generates DUST for this wallet.
            </p>
          )}
        </StatusAlert>
      )}
    </>
  );
}

/** What the wallet says while a press is working. */
function PayingNotice({ stage }: { readonly stage: Exclude<Stage, { of: 'sent' }> }): ReactNode {
  const publicly = stage.of !== 'reading' && stage.of !== 'refused' && stage.pays === 'public';
  return (
    <>
      {stage.of === 'paying' && stage.reading && (
        <p className="lede" data-reading-the-chain>
          {publicly
            ? 'Your wallet is reading the network to find your public coins before it adds them. Nothing has been paid, and you can still choose not to pay.'
            : 'Your wallet is reading the network to find your private coins before it adds them. This can take a few minutes. Nothing has been paid, and you can still choose not to pay.'}
        </p>
      )}
      {stage.of === 'paying' && !stage.reading && !publicly && !stage.proving && (
        <p className="lede" data-paying>
          Adding your private coins and signing in this browser. Nothing is sent to the network from here.
        </p>
      )}
      {stage.of === 'paying' && !stage.reading && !publicly && stage.proving && (
        <p className="lede" data-paying data-proving>
          Proving your coins in this browser. This can take a few minutes, and nothing is sent to the network from
          here.
        </p>
      )}
      {stage.of === 'paying' && !stage.reading && publicly && (
        <p className="lede" data-paying>
          Adding your public coins and signing in this browser. Nothing is sent to the network from here.
        </p>
      )}
    </>
  );
}

/** Pay, and Close or Do not pay, with the reasons each is held back. */
function Decision({ stage, consent, channel, busy, held, onChain, publicly, pay, close, decline }: {
  readonly stage: Exclude<Stage, { of: 'sent' }>;
  readonly consent: Consent;
  readonly channel: Channel | null;
  readonly busy: boolean;
  readonly held: boolean;
  readonly onChain: boolean;
  readonly publicly: boolean;
  readonly pay: () => void;
  readonly close: () => void;
  readonly decline: () => void;
}): ReactNode {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          size="lg"
          type="button"
          variant="default" onClick={pay} data-approve data-pay
          disabled={!consent.ok || stage.of !== 'ready' || channel === null || busy || channel.over() || !onChain}
        >
          {publicly ? 'Pay publicly into the vault' : 'Pay into the vault'}
        </Button>
        {stage.of === 'refused' ? (
          <Button size="lg" type="button" variant="ghost" data-close onClick={close} disabled={busy}>
            Close
          </Button>
        ) : (
          <Button size="lg" type="button" variant="ghost" data-decline onClick={decline} disabled={held || (stage.of === 'paying' && !stage.reading)}>
            Do not pay
          </Button>
        )}
      </div>
    </>
  );
}

/** The screen while the ask is read, refused, ready to pay, paying or failed. */
export function BalanceAsk({ stage, request, check, consent, channel, busy, held, onChain, whoIsAsking, whichWallet, pay, close, decline }: {
  readonly stage: Exclude<Stage, { of: 'sent' }>;
  readonly request: BalanceRequest;
  readonly check: CompanyCheck;
  readonly consent: Consent;
  readonly channel: Channel | null;
  readonly busy: boolean;
  readonly held: boolean;
  readonly onChain: boolean;
  readonly whoIsAsking: ReactNode;
  readonly whichWallet: ReactNode;
  readonly pay: () => void;
  readonly close: () => void;
  readonly decline: () => void;
}): ReactNode {
  const publicly = stage.of !== 'reading' && stage.of !== 'refused' && stage.pays === 'public';
  const headline = (
    <h1 data-headline>
      {publicly
        ? `Pay publicly into a company vault for ${request.requester.origin}`
        : `Pay into a company vault for ${request.requester.origin}`}
    </h1>
  );
  return (
    <>
      {headline}
      {stage.of === 'reading' && <p className="lede" data-reading>Reading what the page sent. Nothing has been paid.</p>}
      {stage.of === 'refused' && (
        <StatusAlert tone="danger" title="This wallet will not pay for this">
          <p className="m-0" data-balance-refused>{stage.says}</p>
        </StatusAlert>
      )}
      <WhatLeaves stage={stage} />
      <WhereTheMoneyGoes request={request} check={check} publicly={publicly} />
      {whoIsAsking}
      {whichWallet}
      <PayingNotice stage={stage} />
      {stage.of === 'failed' && (
        <StatusAlert tone="danger" title="Nothing was paid">
          <p className="m-0" data-balance-failed>{stage.says}</p>
        </StatusAlert>
      )}
      <StatusAlert tone="warning" role={null} title="What is paid, is paid">
        <p className="m-0">
          Once the company sends this transaction, the money is in its vault. Who can move it from there is decided by
          the company&rsquo;s account and its vault, not by this wallet, and nothing in this wallet can take it back.
        </p>
      </StatusAlert>
      <Decision
        stage={stage}
        consent={consent}
        channel={channel}
        busy={busy}
        held={held}
        onChain={onChain}
        publicly={publicly}
        pay={pay}
        close={close}
        decline={decline}
      />
    </>
  );
}
