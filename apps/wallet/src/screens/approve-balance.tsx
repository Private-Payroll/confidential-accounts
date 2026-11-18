import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Identity } from 'midnight-identity/keys/derivation';
import type { BalanceRequest } from 'midnight-identity/profile/request';
import type { Channel } from 'midnight-identity/profile/channel';
import { accountCarriesTheLabel, liveLabelReader, useCompanyCheck } from './company-on-chain.js';
import type { LabelReader } from './company-on-chain.js';
import { BalanceRefused, readWhatThePageAsksToBalance } from '../chain/balance-for-page.js';
import type { BalanceDoors } from '../chain/balance-for-page.js';
import { liveBalanceDoors } from '../chain/balance-doors.js';
import { useAnswerAtOnce } from '../framing.js';
import type { Consent } from '../framing.js';
import { BalanceAsk, PaidPublicly, PaidPrivately } from './approve-balance-views.js';
import type { Stage } from './approve-balance-views.js';
import { startPaying } from './approve-balance-pay.js';

export { NIGHT_TOKEN, describeLeaving } from './approve-balance-views.js';

export interface ApproveBalanceProps {
  readonly request: BalanceRequest;
  readonly identity: Identity;
  readonly account: number;
  readonly channel: Channel | null;
  readonly consent: Consent;
  readonly whoIsAsking: ReactNode;
  readonly whichWallet: ReactNode;
  /** The person turned the request down, or closed a request this wallet refused: `unreadable` says which. */
  readonly onDecline: (why?: 'unreadable') => void;
  readonly doorsFor?: (identity: Identity, account: number) => BalanceDoors;
  readonly now?: () => number;
  /** Told each stage as it goes on screen, for the wallet's own record. */
  readonly onStage?: (stage: string) => void;
  /** Told whether the wallet that pays may still be changed: not while a press runs, and not once the page has its answer. */
  readonly onBusy?: (locked: boolean) => void;
  /** How the company's account is read off the chain. Replaceable so a test can answer. */
  readonly readLabel?: LabelReader;
  /** True when the person approved this ask before the passkey: it is then answered without a press once the checks its button waits for agree and the wallet that pays is one no other site has. */
  readonly answerAtOnce?: boolean;
  /**
   * How what the page sent is read: a public deposit is paid, and a private deposit the page built is refused, since
   * this wallet makes a private deposit whole as an action. Replaceable so a test can read a payment of any kind.
   */
  readonly reads?: typeof readWhatThePageAsksToBalance;
}

/**
 * THE SCREEN FOR A PAGE ASKING THIS WALLET TO PAY FOR A PUBLIC DEPOSIT IT BUILT.
 * A private deposit a page built is refused here: this wallet makes a private
 * deposit whole, in its own action, from its own reads.
 *
 * **THE ONLY ASK THAT PAYS FOR A TRANSACTION A PAGE BUILT**, so it is written the
 * way the send screen is: what leaves, read from the transaction itself; where
 * it goes, as the page names it and whole; and a press that is the only way
 * anything is paid - this screen's Pay, or the Approve in the locked wallet's
 * window, which showed what leaves from the same transaction. The network fee
 * is not on this screen because this wallet does not pay it.
 */
export function ApproveBalance({
  request, identity, account, channel, consent, whoIsAsking, whichWallet, onDecline,
  doorsFor = liveBalanceDoors, now = Date.now, onStage, onBusy, readLabel = liveLabelReader, answerAtOnce = false,
  reads = readWhatThePageAsksToBalance,
}: ApproveBalanceProps): ReactNode {
  const doors = useMemo(() => doorsFor(identity, account), [doorsFor, identity, account]);
  /* **NOTHING IS PAID UNTIL THE COMPANY'S ACCOUNT IS READ OFF THE CHAIN AND
   * CARRIES THE LABEL THE PAGE NAMES**, so the fingerprint a person compares is
   * the fingerprint of the company the page names. It says nothing about the
   * vault: this wallet does not read which account a vault belongs to, and
   * says so beside the vault below. */
  const check = useCompanyCheck(request.company, request.account, readLabel);
  const onChain = accountCarriesTheLabel(check, request.company);
  const [stage, setStage] = useState<Stage>({ of: 'reading' });
  /* A person who says no while the wallet is still reading the chain has already been answered for. */
  const declined = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  /* The wallet on screen now. A press belongs to the wallet it was made with, and stops if the person picks another. */
  const onScreen = useRef(doors);
  useEffect(() => { onScreen.current = doors; }, [doors]);
  const channelNow = useRef(channel);
  channelNow.current = channel;
  /*
   * **A PRESS IN FLIGHT OWNS THE ANSWER.** Every wallet with a press still
   * running, and how many of those presses have begun setting coins aside.
   * While one runs, nothing else on this screen may end the request; once one
   * has set coins aside, "no" can no longer be honoured without letting them go
   * first, so it is not offered.
   */
  const pressing = useRef(new Set<BalanceDoors>());
  const booking = useRef(0);
  /*
   * **ONE PRESS AT A TIME, AND THE SCREEN SHOWS IT.** While a press runs, Pay
   * is not offered again and the wallet cannot be changed, so no second press
   * can race the first to the page; once it has set coins aside, "no" and
   * "close" are not offered either, because they could no longer be honoured.
   */
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState(false);
  const tellBusy = useRef(onBusy);
  tellBusy.current = onBusy;
  const tellStage = useRef(onStage);
  tellStage.current = onStage;
  useEffect(() => { tellStage.current?.(stage.of === 'paying' && stage.reading ? 'paying-reading' : stage.of); }, [stage]);
  /*
   * **THE WALLET'S PARTS STOP WHEN THEIR SCREEN GOES**, or when the person picks
   * another wallet - except a wallet whose press is still running, which stops
   * the moment that press is over, so an approved payment is never cut off.
   */
  useEffect(() => () => { if (!pressing.current.has(doors)) void doors.stop?.(); }, [doors]);
  const decline = useCallback((): void => {
    if (booking.current > 0) return;
    declined.current = true;
    onDecline();
  }, [onDecline]);
  /* The request was refused before anybody could approve it; closing says so again, and the channel sends it once. */
  const close = useCallback((): void => {
    if (pressing.current.size > 0) return;
    declined.current = true;
    onDecline('unreadable');
  }, [onDecline]);

  /* Read once per ask and per wallet. Reading pays nothing and books nothing. */
  useEffect(() => {
    let alive = true;
    setStage({ of: 'reading' });
    /*
     * **A REQUEST THIS WALLET WILL NOT PAY FOR IS ANSWERED AS IT IS REFUSED**,
     * so the page is not left waiting for a press that cannot come - unless a
     * press made with another wallet is still running, which owns the answer.
     */
    const refuse = (says: string): void => {
      setStage({ of: 'refused', says });
      if (pressing.current.size === 0) channelNow.current?.refuse('unreadable');
    };
    void doors.ledger().then((ledger) => {
      if (!alive) return;
      try {
        const read = reads(ledger, request.transaction, request.vault);
        setStage({ of: 'ready', tx: read.tx, leaves: read.leaves, pays: read.pays });
      } catch (e) {
        refuse(e instanceof BalanceRefused ? e.message : 'Nothing has been paid.');
      }
    }, () => { if (alive) refuse('This wallet could not load what it reads a transaction with. Nothing has been paid.'); });
    return () => { alive = false; };
  }, [doors, request.transaction, request.vault, reads]);

  const pay = useCallback((): void => {
    if (stage.of !== 'ready' || channel === null || channel.over() || pressing.current.size > 0 || !onChain) return;
    const { tx, leaves, pays } = stage;
    startPaying({
      tx, leaves, pays, channel, doors, request, now, setStage, setBusy, setHeld,
      refs: { pressing, booking, declined, mounted, onScreen },
    });
  }, [stage, channel, doors, request, now, onChain]);
  useAnswerAtOnce(answerAtOnce, consent.ok && stage.of === 'ready' && channel !== null && !busy && !channel.over() && onChain, pay);

  /* The wallet stays as it is while a press runs and once the page has been answered. */
  const locked = busy || stage.of === 'sent' || stage.of === 'failed';
  useEffect(() => { tellBusy.current?.(locked); }, [locked]);

  if (stage.of === 'sent' && stage.pays === 'public') return <PaidPublicly request={request} stage={stage} />;
  if (stage.of === 'sent') return <PaidPrivately request={request} stage={stage} />;

  return (
    <BalanceAsk
      stage={stage} request={request} check={check} consent={consent} channel={channel}
      busy={busy} held={held} onChain={onChain} whoIsAsking={whoIsAsking} whichWallet={whichWallet}
      pay={pay} close={close} decline={decline}
    />
  );
}
