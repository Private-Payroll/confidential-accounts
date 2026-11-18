import type { BalanceRequest } from 'midnight-identity/profile/request';
import type { Channel, ProgressStage } from 'midnight-identity/profile/channel';
import { balancedAnswerFor } from 'midnight-identity/profile/balance';
import type { LeavesTheWallet } from 'midnight-identity/profile/balance';
import { NotHandedOver, payForThePage, whyThePaymentFailed } from '../chain/balance-for-page.js';
import type { BalanceDoors, PageAskPays, UnboundTransactionLike } from '../chain/balance-for-page.js';
import type { Stage } from './approve-balance-views.js';
import type { Dispatch, SetStateAction, MutableRefObject } from 'react';

/** The screen's refs a press reads and writes. */
export interface PressRefs {
  readonly pressing: MutableRefObject<Set<BalanceDoors>>;
  readonly booking: MutableRefObject<number>;
  readonly declined: MutableRefObject<boolean>;
  readonly mounted: MutableRefObject<boolean>;
  readonly onScreen: MutableRefObject<BalanceDoors>;
}

/**
 * The press: adds this wallet's coins to the page's transaction and hands it back, keeping the screen's refs
 * and stage true while it runs and when it ends.
 */
export function startPaying({ tx, leaves, pays, channel, doors, request, now, refs, setStage, setBusy, setHeld }: {
  readonly tx: UnboundTransactionLike;
  readonly leaves: LeavesTheWallet[];
  readonly pays: PageAskPays;
  readonly channel: Channel;
  readonly doors: BalanceDoors;
  readonly request: BalanceRequest;
  readonly now: () => number;
  readonly refs: PressRefs;
  readonly setStage: Dispatch<SetStateAction<Stage>>;
  readonly setBusy: (busy: boolean) => void;
  readonly setHeld: (held: boolean) => void;
}): void {
  const { pressing, booking, declined, mounted, onScreen } = refs;
  const pressedWith = doors;
  const stillThisWallet = (): boolean => onScreen.current === pressedWith;
  let booked = false;
  let sentAt = 0;
  /*
   * **WHAT THE WALLET IS DOING, SAID TO THE PAGE AS IT HAPPENS**: each report
   * of the read that moved and the moment before coins are added are said as
   * "reading" (the only stage the page has for work before a proof); "proving"
   * is said only on a private deposit's proof starting or ending, never for a
   * public deposit, which makes none. Never from a clock. A stage already said
   * is said again at most once a second, which is still only ever on an event.
   */
  let said: { stage: ProgressStage; at: number } | null = null;
  const say = (next: ProgressStage): void => {
    const at = now();
    if (said !== null && said.stage === next && at - said.at < 1_000) return;
    said = { stage: next, at };
    channel.progress(next);
  };
  const unwatch = pressedWith.watchProofs?.((event) => {
    if (pays === 'public' || event.op !== 'prove') { say('reading'); return; }
    say('proving');
    if (stillThisWallet()) setStage((was) => (was.of === 'paying' ? { ...was, reading: false, proving: true } : was));
  });
  pressing.current.add(pressedWith);
  setBusy(true);
  const over = (): void => {
    unwatch?.();
    pressing.current.delete(pressedWith);
    if (booked) booking.current -= 1;
    if (mounted.current) { setBusy(pressing.current.size > 0); setHeld(booking.current > 0); }
    if (!mounted.current || !stillThisWallet()) void pressedWith.stop?.();
  };
  setStage({ of: 'paying', reading: false, proving: false, leaves, pays });
  void payForThePage(pressedWith, tx, { pays, leaves }, {
    onReading: () => { if (!declined.current && stillThisWallet()) setStage({ of: 'paying', reading: true, proving: false, leaves, pays }); },
    onRead: () => say('reading'),
    onBalancing: () => {
      booked = true;
      booking.current += 1;
      if (mounted.current) setHeld(true);
      say('reading');
      if (stillThisWallet()) setStage((was) => (was.of === 'paying' ? { ...was, reading: false } : was));
    },
    /* **ASKED LAST BEFORE ANY COIN IS SET ASIDE**: not if the person said no, left, or picked another wallet. */
    stillWanted: () => !declined.current && mounted.current && stillThisWallet(),
    /*
     * **HANDED OVER ONLY IF THE PAGE HAS NOT ALREADY BEEN ANSWERED.** A "no"
     * that landed in the moment before the button went down was sent then; a
     * press made with another wallet may have answered first. Either way this
     * one is not handed over, and what it set aside is let go.
     */
    handOver: (finished) => {
      sentAt = now();
      return !declined.current && channel.answer(balancedAnswerFor(request, finished, leaves, sentAt));
    },
  }).then(() => {
    over();
    setStage({ of: 'sent', at: sentAt, leaves, pays });
  }, (e: unknown) => {
    over();
    /* The person said no, and the page was told so then. */
    if (declined.current) return;
    /* Stopped before anything was set aside because another wallet was picked: that wallet's screen stands. */
    if (!booked && !stillThisWallet()) return;
    /*
     * **THE PERSON APPROVED, SO THE PAGE IS TOLD IT FAILED, NEVER THAT THEY
     * DECLINED** - and only now, after what was set aside has been let go.
     * If the page was already answered, nothing more crosses, and a press
     * made with a wallet no longer on screen leaves that screen as it is.
     */
    const told = channel.refuse('failed', whyThePaymentFailed(e));
    if (!told && !stillThisWallet()) return;
    setStage({
      of: 'failed', leaves, pays,
      says: e instanceof NotHandedOver
        ? e.message
        : pays === 'public'
          ? `${e instanceof Error ? e.message : String(e)} The page was given nothing and has been told this payment failed.`
          : `${e instanceof Error ? e.message : String(e)} Anything this wallet set aside for it has been let go. The page was given nothing and has been told this payment failed.`,
    });
  });
}
