/*
 * WHERE A FINISHED CALL GOES, IN THE WALLET: through our service, through the service the company hosts itself, or
 * straight to the chain from the person's own wallet, as the company's choice of service decides; and what an
 * action has handed over by the time a refusal reaches it.
 */
import { intentShapeOf } from 'midnight-identity/profile/act-shape';
import { FEE_SPONSORED, FEE_SPONSORED_DONE, listsRoute } from 'midnight-identity/profile/act-intents';
import type { RecordWrite } from '../../../../packages/web-shared/src/records-source.js';
import { THROUGH_THE_SERVICE, type ChainCall, type HandOver } from '../../../../packages/web-shared/src/hand-over.js';
import { OUR_SERVICE, serviceAddressRefusal } from '../../../../src/midnight/company-service-record.js';
import { provenOnTheChainAlready, straightFromTheOwnWallet, type FeeAndSubmit } from '../chain/sent-straight-to-the-chain.js';
import { toTheCompanysService } from '../chain/sent-to-the-companys-service.js';
import type { ServiceRead } from './company-service-read.js';
import type { CompanyChain } from './company-reach.js';
import type { StepContext } from './definition.js';
import { fellBackLine, type FellBack } from './fall-back-line.js';

/** `sponsor`, its telling that this wallet is done with a call kept in `owed` for after the send, not made inside it. */
const doneAfterTheSend = (sponsor: NonNullable<FeeAndSubmit['sponsor']>, owed: (() => Promise<void>)[]): NonNullable<FeeAndSubmit['sponsor']> =>
  async (tx, expected) => {
    const back = await sponsor(tx, expected);
    const done = back.done;
    return done === undefined ? back : { tx: back.tx, done: async () => { owed.push(done); } };
  };

/**
 * **WHERE EVERY CALL AN ACTION FINISHES GOES, AND WHO PAYS ITS FEE.** Decided by the company's choice of service
 * (`companyServiceHere`), a setting the company files; never asked of the person, never the act's or the page's.
 *
 * - Our service: it pays the fee and submits, as it always has. When it answers that it took nothing because it
 *   could not (`ourServiceTookNothing`), or cannot be reached with nothing handed over, the call goes straight to
 *   the chain instead. When the call went out and no answer came back, the wallet reads the chain for that very
 *   call first and sends it straight only when it is not there. A call the service answered for is never sent again.
 * - The company's own service: the call is handed to it finished, its fee paid. An address the company's choice
 *   could not have named refuses every hand-over before anything is paid. A service there that gives no answer at
 *   all is gone around the same way: the chain is read for the finished call, and absent, the wallet sends it.
 * - No service, or a choice this wallet could not read: straight to the chain from the person's wallet for this
 *   account. An unread choice is never taken as ours, so our service cannot undo the company's choice by withholding
 *   it.
 *
 * Off our service's way the fee is our sponsorship's (`sponsor`), which only adds it, or the person's own DUST when
 * sponsorship cannot pay or cannot be reached (`sentFromTheOwnWallet`). A wallet this device cannot reach leaves no
 * way but our service. A fallback used is told once, as one plain line at the end of the window (`ctx.show`). Every
 * call this wallet hands over itself goes through the runner's door (`ctx.sendStraight`), which checks the company
 * first and counts the call as handed over, since the page never sees it, and
 * a call the chain shows after our service gave no answer is told too (`ctx.seenOnTheChain`).
 */
export function handOverFor(
  ctx: Pick<StepContext, 'held' | 'signal'> & Pick<StepContext, 'sendStraight'> & Partial<Pick<StepContext, 'show' | 'seenOnTheChain'>>, chain: Pick<CompanyChain, 'ownWallet' | 'ownServiceSend'>,
  service: ServiceRead = { choice: OUR_SERVICE }, now: () => number = Date.now,
  sponsor?: FeeAndSubmit['sponsor'],
): HandOver {
  const account = ctx.held.account;
  const own = chain.ownWallet;
  const fell = new Set<FellBack>();
  const note = (why: FellBack): void => {
    fell.add(why);
    const key = fellBackLine(fell);
    if (key !== undefined) ctx.show?.({ key });
  };
  /*
   * Each call has its own mark of whether it was handed over, so a call refused before its hand-over undoes its own fee.
   * The sponsorship is told this wallet is done with the call only once the runner's door has closed on the send, so
   * the step's view has taken the send's own moves and the telling is checked against the company as the send left it.
   */
  const sent = (submit?: FeeAndSubmit['submit']) => (account === undefined || own === undefined ? undefined
    : async (tx: string, call: ChainCall): Promise<void> => {
      const owed: (() => Promise<void>)[] = [];
      try {
        /* Through the runner's door: the step's read of the company is checked before the call leaves this wallet. */
        await ctx.sendStraight((door) => straightFromTheOwnWallet(() => own(ctx.held.identity, account), now, () => !ctx.signal.aborted, { over: false }, {
          ...(sponsor === undefined ? {} : { sponsor: doneAfterTheSend(sponsor, owed) }), ...(submit === undefined ? {} : { submit }),
          ownDustPaid: () => note('own-dust'), unreached: () => note('unreached'), handedOver: door.handedOver,
        })(tx, call), undefined, { circuit: call.circuit, contract: call.contract });
      } finally {
        /* Telling the sponsorship is its bookkeeping, not the send's: each is settled, so one that fails leaves the send as it went. */
        await Promise.allSettled(owed.map((done) => done()));
      }
    });
  const choice = 'unread' in service ? null : service.choice;
  if (choice !== null && choice.service === 'ours') {
    const toChain = sent();
    if (toChain === undefined || account === undefined || own === undefined) return THROUGH_THE_SERVICE;
    let taken = false;
    /* The wallet's own read of the chain for the very call it handed our service, its doors stopped after. */
    const landed = async (tx: string): Promise<boolean> => {
      const o = own(ctx.held.identity, account);
      try {
        const there = await provenOnTheChainAlready(o, tx);
        if (there) ctx.seenOnTheChain?.();
        return there;
      } finally {
        await o.stop?.().catch(() => { /* The wallet only read the chain here: a failure to stop it changes nothing sent or read. */ });
      }
    };
    return Object.freeze({
      path: 'service' as const,
      fallback: Object.freeze({
        toChain, fellBack: (why?: 'unreached') => { taken = true; note(why ?? 'chain'); }, taken: () => taken, landed,
      }),
    });
  }
  if (choice !== null && choice.service === 'own') {
    const bad = serviceAddressRefusal(choice.at);
    if (bad !== null) return Object.freeze({ path: 'company-service' as const, at: choice.at, refused: `${bad}. Nothing was sent.` });
    const toChain = sent(toTheCompanysService(choice.at, chain.ownServiceSend));
    return Object.freeze({ path: 'company-service' as const, at: choice.at, ...(toChain === undefined ? {} : { toChain }) });
  }
  const straight = sent();
  const toChain = straight === undefined || choice !== null ? straight
    : async (tx: string, call: ChainCall) => { note('unread'); await straight(tx, call); };
  return Object.freeze({ path: 'chain' as const, ...(toChain === undefined ? {} : { toChain }) });
}

/*
 * Our fee sponsorship for this act: the call handed to our service's fee route, which adds only the fee and hands
 * it back finished, with the way to tell it this wallet is done with that call. Absent when the act's own route
 * list does not carry that route, so asking it never stops the window.
 */
export const sponsorFor = (
  intent: Pick<StepContext['intent'], 'name'>, write: (w: RecordWrite) => Promise<unknown>,
): FeeAndSubmit['sponsor'] => {
  const shape = intentShapeOf(intent.name);
  if (shape === undefined || !listsRoute(shape, FEE_SPONSORED)) return undefined;
  const told = listsRoute(shape, FEE_SPONSORED_DONE);
  return async (tx, call) => {
    const back = await write({ to: 'fee', body: { tx, kind: call.kind, contract: call.contract, circuit: call.circuit } }) as { tx?: unknown; booking?: unknown } | null;
    if (typeof back?.tx !== 'string' || back.tx.length === 0) throw new Error('the fee sponsorship handed back no call. Nothing was paid or sent; try again');
    const booking = back.booking;
    return {
      tx: back.tx,
      ...(told && typeof booking === 'string'
        ? { done: async () => { await write({ to: 'fee-done', body: { booking } }); } } : {}),
    };
  };
};

/**
 * The hand-over with `handed.over` set the moment a call may have reached the network: once the wallet sends it,
 * or once it fails anywhere but before the network was handed it.
 */
export const handOverMarked = (given: HandOver | undefined, handed: Handed): HandOver => {
  const over = given ?? THROUGH_THE_SERVICE;
  const mark = (): void => { handed.over = true; };
  const marked = (toChain: NonNullable<HandOver['toChain']>): NonNullable<HandOver['toChain']> => async (tx, call) => {
    try {
      await toChain(tx, call);
    } catch (e) {
      const marked = e as { nothingWasSent?: unknown; thisSendNotSent?: unknown } | null;
      if (marked?.nothingWasSent !== true && marked?.thisSendNotSent !== true) mark();
      throw e;
    }
    mark();
  };
  if (over.toChain === undefined && over.fallback === undefined) return over;
  return Object.freeze({
    ...over,
    ...(over.toChain === undefined ? {} : { toChain: marked(over.toChain) }),
    ...(over.fallback === undefined ? {} : { fallback: Object.freeze({ ...over.fallback, toChain: marked(over.fallback.toChain) }) }),
  });
};


/**
 * Whether an action's own call has been handed over to be sent (`over`), so a refusal after it is never said as nothing
 * sent.
 */
export interface Handed { over: boolean }
