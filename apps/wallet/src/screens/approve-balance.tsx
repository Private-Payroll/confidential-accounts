import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Identity } from 'midnight-identity/keys/derivation';
import type { BalanceRequest } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import { balancedAnswerFor } from 'midnight-identity/profile/balance';
import type { LeavesTheWallet } from 'midnight-identity/profile/balance';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import { Alert, Button, Section } from '../kit/index.js';
import { hrefOf } from '../routes.js';
import {
  BalanceRefused, payForThePage, readWhatThePageAsks,
} from '../chain/balance-for-page.js';
import type {
  BalanceDoors, FacadeForBalancing, LedgerForBalancing, PageAskPays, UnboundTransactionLike,
} from '../chain/balance-for-page.js';
import { facadeFor, facadeKeysFor } from '../chain/facade.js';
import { makeBrowserProvingService } from '../chain/proving.js';
import { unshieldedKeystoreFor } from '../chain/unshielded.js';
import { nightFromStars } from '../chain/amount.js';
import type { Consent } from '../framing.js';

/**
 * THE SCREEN FOR A PAGE ASKING THIS WALLET TO PAY FOR A TRANSACTION.
 *
 * **THE ONLY ASK THAT MOVES MONEY OUT OF THIS WALLET**, so it is written the
 * way the send screen is: what leaves, read from the transaction itself; where
 * it goes, as the page names it and whole; and a press that is the only way
 * anything is paid. The network fee is not on this screen because this wallet
 * does not pay it.
 */

/** The live doors: the wallet the person chose, on the real network, proving in this browser. */
export const liveBalanceDoors = (identity: Identity, account: number): BalanceDoors & { stop: () => Promise<void> } => {
  let running: Promise<Awaited<ReturnType<typeof facadeFor>>> | null = null;
  const facade = () => {
    running ??= (async () => {
      const started = await facadeFor(identity, account, makeBrowserProvingService());
      const keys = facadeKeysFor(identity, account);
      await started.start(keys.shielded, keys.dust);
      return started;
    })();
    return running as unknown as Promise<FacadeForBalancing>;
  };
  return {
    ledger: async () => (await import('@midnightntwrk/ledger-v9')) as unknown as LedgerForBalancing,
    facade,
    keys: () => {
      const keys = facadeKeysFor(identity, account);
      return { shieldedSecretKeys: keys.shielded, dustSecretKey: keys.dust };
    },
    signSegment: () => unshieldedKeystoreFor(identity, account).signDataAsync,
    ownPublicAddress: () => String(unshieldedKeystoreFor(identity, account).getAddress()),
    stop: async () => {
      if (running === null) return;
      const f = await running.catch(() => null);
      running = null;
      await f?.stop().catch(() => { /* already stopping */ });
    },
  };
};

/** One figure, in words a person reads. NIGHT is named; any other token is shown by its identifier. */
const NIGHT_TOKEN = '0'.repeat(64);
const describeLeaving = (l: LeavesTheWallet): string =>
  l.kind === 'unshielded' && l.token === NIGHT_TOKEN
    ? `${nightFromStars(BigInt(l.amount))} NIGHT, from your public balance`
    : `${l.amount} base units of the ${l.kind === 'shielded' ? 'private' : 'public'} token below`;

type Stage =
  | { of: 'reading' }
  | { of: 'ready'; tx: UnboundTransactionLike; leaves: LeavesTheWallet[]; pays: PageAskPays }
  | { of: 'refused'; says: string }
  | { of: 'paying'; leaves: LeavesTheWallet[]; pays: PageAskPays }
  | { of: 'failed'; says: string; leaves: LeavesTheWallet[]; pays: PageAskPays }
  | { of: 'sent'; at: number; leaves: LeavesTheWallet[]; pays: PageAskPays };

export function ApproveBalance({
  request, identity, account, channel, consent, whoIsAsking, whichWallet, onDecline,
  doorsFor = liveBalanceDoors, now = Date.now,
}: {
  readonly request: BalanceRequest;
  readonly identity: Identity;
  readonly account: number;
  readonly channel: Channel | null;
  readonly consent: Consent;
  readonly whoIsAsking: ReactNode;
  readonly whichWallet: ReactNode;
  readonly onDecline: () => void;
  readonly doorsFor?: (identity: Identity, account: number) => BalanceDoors;
  readonly now?: () => number;
}): ReactNode {
  const doors = useMemo(() => doorsFor(identity, account), [doorsFor, identity, account]);
  const [stage, setStage] = useState<Stage>({ of: 'reading' });

  /* Read once per ask and per wallet. Reading pays nothing and books nothing. */
  useEffect(() => {
    let alive = true;
    setStage({ of: 'reading' });
    void doors.ledger().then((ledger) => {
      if (!alive) return;
      try {
        const read = readWhatThePageAsks(ledger, request.transaction, request.vault);
        setStage({ of: 'ready', tx: read.tx, leaves: read.leaves, pays: read.pays });
      } catch (e) {
        setStage({ of: 'refused', says: e instanceof BalanceRefused ? e.message : 'Nothing has been paid.' });
      }
    }, () => { if (alive) setStage({ of: 'refused', says: 'This wallet could not load what it reads a transaction with. Nothing has been paid.' }); });
    return () => { alive = false; };
  }, [doors, request.transaction, request.vault]);

  const pay = useCallback((): void => {
    if (stage.of !== 'ready' || channel === null) return;
    const { tx, leaves, pays } = stage;
    setStage({ of: 'paying', leaves, pays });
    void payForThePage(doors, tx, { pays, leaves }).then((finished) => {
      const at = now();
      channel.answer(balancedAnswerFor(request, finished, leaves, at));
      setStage({ of: 'sent', at, leaves, pays });
    }, (e: unknown) => {
      setStage({
        of: 'failed', leaves, pays,
        says: pays === 'public'
          ? `${e instanceof Error ? e.message : String(e)} The page was given nothing back.`
          : `${e instanceof Error ? e.message : String(e)} Anything this wallet set aside for it has been let go, and nothing was handed back to the page.`,
      });
    });
  }, [stage, channel, doors, request, now]);

  const publicly = stage.of !== 'reading' && stage.of !== 'refused' && stage.pays === 'public';
  const headline = (
    <h1 data-headline>
      {publicly
        ? `Pay publicly into a company vault for ${request.requester.origin}`
        : `Pay into a company vault for ${request.requester.origin}`}
    </h1>
  );

  const where = (
    <Section
      title="Where the money goes"
      description={publicly
        ? 'What the page says. This wallet checked that the transaction calls this vault\'s public deposit and nothing else, and that it puts exactly the amount shown above into this vault.'
        : 'What the page says. This wallet checked that the transaction calls this vault and nothing else, and that the one coin it creates belongs to this vault.'}
    >
      <p className="m-0 text-sm text-muted">The company, as the page names it</p>
      <p className="m-0 font-mono tracking-wide text-ink text-xl" data-company-fingerprint>
        {companyFingerprint(request.company)}
      </p>
      <p className="m-0 font-mono break-all text-sm text-muted" data-company>{request.company}</p>
      <p className="m-0 text-sm text-muted" style={{ marginTop: '0.75rem' }}>The vault the transaction pays into</p>
      <p className="m-0 font-mono break-all text-ink text-lg" data-vault>{request.vault}</p>
      <p className="m-0 text-sm text-muted">
        This wallet cannot check that the vault belongs to that company. The company&rsquo;s own service refuses a
        deposit into a vault whose rules its committee does not hold.
      </p>
    </Section>
  );

  const leavingList = (leaves: readonly LeavesTheWallet[]) => (
    <div data-leaves>
      {leaves.map((l) => (
        <div key={`${l.kind}:${l.token}`} style={{ marginBottom: '0.5rem' }}>
          <p className="m-0 text-ink text-lg" data-leaving-amount>{describeLeaving(l)}</p>
          <p className="m-0 font-mono break-all text-sm text-muted" data-leaving-token>{`${l.kind} token ${l.token}`}</p>
        </div>
      ))}
    </div>
  );

  if (stage.of === 'sent' && stage.pays === 'public') {
    return (
      <>
        <h1 data-paid-heading>{`You paid publicly for a deposit for ${request.requester.origin}`}</h1>
        <p className="lede" data-paid>
          {`On ${new Date(stage.at).toLocaleString()} this wallet added the public money below to the deposit and handed it back. `}
          The company&rsquo;s service sends it. Until the chain has it, nothing has moved, and your public balance still
          shows this money. Do not spend it elsewhere first, or this deposit will fail.
        </p>
        {leavingList(stage.leaves)}
        <p className="m-0 font-mono break-all text-sm text-muted">{request.vault}</p>
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>&larr; Your wallet</a></p>
      </>
    );
  }

  if (stage.of === 'sent') {
    return (
      <>
        <h1 data-paid-heading>{`You paid for a deposit for ${request.requester.origin}`}</h1>
        <p className="lede" data-paid>
          {`On ${new Date(stage.at).toLocaleString()} this wallet added the coins below to the transaction and handed it back. `}
          The company&rsquo;s service sends it. Until the chain has it, nothing has moved, and the coins it uses are set
          aside in this wallet. If the transaction is never sent, they may stay set aside.
        </p>
        {leavingList(stage.leaves)}
        <p className="m-0 font-mono break-all text-sm text-muted">{request.vault}</p>
        <p style={{ marginTop: '1.5rem' }}><a href={hrefOf('home')}>&larr; Your wallet</a></p>
      </>
    );
  }

  return (
    <>
      {headline}
      {stage.of === 'reading' && <p className="lede" data-reading>Reading what the page sent. Nothing has been paid.</p>}
      {stage.of === 'refused' && (
        <Alert tone="danger" title="This wallet will not pay for this">
          <p className="m-0" data-balance-refused>{stage.says}</p>
        </Alert>
      )}
      {(stage.of === 'ready' || stage.of === 'paying' || stage.of === 'failed') && (
        <Section
          title="What leaves this wallet"
          description="Worked out from the transaction itself, not from anything the page said."
        >
          {leavingList(stage.leaves)}
          <p className="m-0 text-sm text-muted" data-no-fee>
            You pay no network fee. The company pays it.
          </p>
        </Section>
      )}
      {publicly && (
        <Alert tone="warning" role={null} title="This deposit is public">
          <p className="m-0" data-public-deposit>
            The token and the amount above leave your public balance, and anyone reading the chain can see them, your
            wallet&rsquo;s public address, and the vault they went into.
          </p>
          {stage.leaves.some((l) => l.token === NIGHT_TOKEN) && (
            <p className="m-0" data-night-stops-dust>
              NIGHT that goes into the vault no longer generates DUST for this wallet.
            </p>
          )}
        </Alert>
      )}
      {where}
      {whoIsAsking}
      {whichWallet}
      {stage.of === 'paying' && !publicly && (
        <p className="lede" data-paying>
          Adding your coins and proving them in this browser. This can take a few minutes, and nothing is sent to the
          network from here.
        </p>
      )}
      {stage.of === 'paying' && publicly && (
        <p className="lede" data-paying>
          Adding your public coins and signing in this browser. Nothing is sent to the network from here.
        </p>
      )}
      {stage.of === 'failed' && (
        <Alert tone="danger" title="Nothing was paid">
          <p className="m-0" data-balance-failed>{stage.says}</p>
        </Alert>
      )}
      <Alert tone="warning" role={null} title="What is paid, is paid">
        <p className="m-0">
          Once the company sends this transaction, the money is in its vault. Who can move it from there is decided by
          the company&rsquo;s account and its vault, not by this wallet, and nothing in this wallet can take it back.
        </p>
      </Alert>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary" onClick={pay} data-approve data-pay
          disabled={!consent.ok || stage.of !== 'ready' || channel === null}
        >
          {publicly ? 'Pay publicly into the vault' : 'Pay into the vault'}
        </Button>
        <Button variant="ghost" data-decline onClick={onDecline} disabled={stage.of === 'paying'}>
          Do not pay
        </Button>
      </div>
    </>
  );
}
