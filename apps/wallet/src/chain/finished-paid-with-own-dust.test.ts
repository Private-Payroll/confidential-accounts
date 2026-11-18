import { describe, expect, it } from 'vitest';
import { of } from 'rxjs';
import { DefaultForkSchedule } from '@midnightntwrk/wallet-sdk';
import { finishedSentWithOwnDust, moreThanTheShownFeeRefusal, OwnFeeNotPaid } from './finished-paid-with-own-dust.js';
import { FeeRefused } from './sent-straight-to-the-chain.js';

/*
 * **A FINISHED DEPOSIT WHOSE NETWORK FEE THE COMPANY'S FEE PAYER COULD NOT PAY IS PAID FROM THE PERSON'S OWN DUST ONLY
 * AFTER THEY CONFIRM THE FEE SHOWN, AND ONLY WITH DUST, NO MORE THAN THAT FEE.** The SDK's facade is stood in; each
 * test reads what it was asked to do.
 */

const NOW = 1_000_000;
const MINUTE = 60_000;
const FEE = 300n;

const intentOf = (spends: readonly unknown[], over: Record<string, unknown> = {}) => ({
  actions: [], guaranteedUnshieldedOffer: null, fallibleUnshieldedOffer: null, dustActions: { spends, registrations: [] }, ...over,
});
const balancingOf = (spends: readonly unknown[] = [{ vFee: FEE }], over: Record<string, unknown> = {}, offer: unknown = null) => ({
  guaranteedOffer: offer, fallibleOffer: null, intents: new Map([[2, intentOf(spends, over)]]),
});

const facadeWith = (opts: {
  deadline?: Date | null; balancing?: unknown; balanceFails?: unknown; estimateFails?: unknown; submitFails?: unknown;
} = {}) => {
  const did: string[] = [];
  const intents = opts.deadline === null ? new Map([[1, {}]]) : new Map([[1, { ttl: opts.deadline ?? new Date(NOW + 80 * MINUTE) }]]);
  const original = { intents };
  const ready = { subscribe: (w: { next: (s: unknown) => void }) => { w.next({ progress: { isConnected: true, isStrictlyComplete: () => true } }); return { unsubscribe: () => {} }; } };
  const asked: { ttl?: Date; kinds?: unknown } = {};
  const facade = {
    dust: { state: ready },
    state: () => of({ activeProtocolVersion: DefaultForkSchedule.v9 }),
    adoptTransaction: (_bytes: Uint8Array, stage: string) => { did.push(`adopted ${stage}`); return original; },
    estimateTransactionFee: async (_tx: unknown, o: { ttl?: Date }) => { did.push('estimated'); asked.ttl = o.ttl; if (opts.estimateFails !== undefined) throw opts.estimateFails; return FEE; },
    balanceFinalizedTransaction: async (tx: unknown, o: { ttl: Date; tokenKindsToBalance?: unknown }) => {
      did.push('balanced');
      asked.kinds = o.tokenKindsToBalance;
      if (o.ttl.getTime() !== asked.ttl?.getTime()) did.push('another deadline');
      if (opts.balanceFails !== undefined) throw opts.balanceFails;
      return { type: 'FINALIZED_TRANSACTION', originalTransaction: tx, balancingTransaction: opts.balancing ?? balancingOf() };
    },
    signRecipe: async (r: unknown) => { did.push('signed'); return r; },
    finalizeRecipe: async () => { did.push('finalized'); return { finished: true }; },
    submitTransaction: async () => { did.push('submitted'); if (opts.submitFails !== undefined) throw opts.submitFails; return 'sub-1'; },
    revert: async () => { did.push('reverted'); },
  };
  return { did, asked, original, doors: { facade: async () => facade as never, signSegment: () => (() => {}) as never } };
};

const wayWith = (yes: boolean, did: string[], shown: bigint[] = []) => ({
  now: () => NOW, stillWanted: () => true,
  confirm: async (fee: bigint) => { shown.push(fee); did.push('asked'); return yes; },
  handedOver: () => { did.push('handed over'); },
});

describe('the fee is paid from the person\'s own DUST only after they confirm it', () => {
  it('confirmed: the fee shown is what is balanced, with DUST only, and the transaction is handed over then sent', async () => {
    const { did, asked, doors } = facadeWith();
    const shown: bigint[] = [];
    expect(await finishedSentWithOwnDust(doors, 'AQID', wayWith(true, did, shown))).toBe('sub-1');
    /* RED WHEN: the fee is balanced before the person confirms it, or the transaction is sent before it counts as handed over. */
    expect(did).toEqual(['adopted Finalized', 'estimated', 'asked', 'balanced', 'signed', 'finalized', 'handed over', 'submitted']);
    expect(shown).toEqual([FEE]);
    /* RED WHEN: the wallet balances anything but DUST, or with another deadline than the fee it showed. */
    expect(asked.kinds).toEqual(['dust']);
    expect(asked.ttl?.getTime()).toBe(NOW + 20 * MINUTE);
  });

  it('declined: nothing is balanced, booked or sent', async () => {
    const { did, doors } = facadeWith();
    const failed = await finishedSentWithOwnDust(doors, 'AQID', wayWith(false, did)).catch((e: unknown) => e);
    /* RED WHEN: a "no" still balances or sends the transaction. */
    expect(failed).toBeInstanceOf(OwnFeeNotPaid);
    expect((failed as OwnFeeNotPaid).why).toBe('declined');
    expect(did).toEqual(['adopted Finalized', 'estimated', 'asked']);
  });

  it('the fee lives no longer than the transaction it pays for', async () => {
    const { did, asked, doors } = facadeWith({ deadline: new Date(NOW + 5 * MINUTE) });
    await finishedSentWithOwnDust(doors, 'AQID', wayWith(true, did));
    /* RED WHEN: the fee's deadline is later than the deposit's own. */
    expect(asked.ttl?.getTime()).toBe(NOW + 5 * MINUTE);
    expect(did).not.toContain('another deadline');
  });

  it('a transaction whose deadline cannot be read is not paid for, and the person is not asked', async () => {
    const { did, doors } = facadeWith({ deadline: null });
    const failed = await finishedSentWithOwnDust(doors, 'AQID', wayWith(true, did)).catch((e: unknown) => e);
    /* RED WHEN: a fee is paid with no deadline bound to the deposit's. */
    expect((failed as OwnFeeNotPaid).why).toBe('not-paid');
    expect(did).not.toContain('asked');
  });
});

describe('what is added is the fee shown and nothing else', () => {
  for (const [name, balancing] of [
    ['more DUST than the fee shown', balancingOf([{ vFee: FEE }, { vFee: 1n }])],
    ['a spend whose fee cannot be read', balancingOf([{}])],
    ['a coin as well as the fee', balancingOf([{ vFee: FEE }], {}, { inputs: [], outputs: [{}], transients: [] })],
    ['a call as well as the fee', balancingOf([{ vFee: FEE }], { actions: [{}] })],
  ] as const) {
    it(`refuses ${name} and signs and sends nothing`, async () => {
      const { did, doors } = facadeWith({ balancing });
      const failed = await finishedSentWithOwnDust(doors, 'AQID', wayWith(true, did)).catch((e: unknown) => e);
      /* RED WHEN: the wallet signs or sends what adds more than the fee the person confirmed. */
      expect(failed).toBeInstanceOf(FeeRefused);
      /* RED WHEN: the refusal gives back a booking that would free the deposit's own coins while it may be on its way. */
      expect(did).not.toContain('reverted');
      expect(did).not.toContain('signed');
      expect(did).not.toContain('submitted');
    });
  }

  it('a recipe that changes the transaction itself is refused', () => {
    /* RED WHEN: a recipe whose original is another transaction passes as only the fee. */
    expect(moreThanTheShownFeeRefusal({ originalTransaction: {}, balancingTransaction: balancingOf() }, {}, FEE)).toMatch(/change the deposit itself/);
  });
});

describe('every way it does not send says so, and a send that started may have been sent', () => {
  it('too little DUST is said as that, and nothing is sent', async () => {
    const { did, doors } = facadeWith({ balanceFails: { _tag: 'Wallet.InsufficientFunds' } });
    const failed = await finishedSentWithOwnDust(doors, 'AQID', wayWith(true, did)).catch((e: unknown) => e);
    /* RED WHEN: a wallet short of DUST reads as any other failure. */
    expect((failed as OwnFeeNotPaid).why).toBe('too-little-dust');
    expect(did).not.toContain('submitted');
  });

  it('the deadline is read again once the person confirms, so a late answer neither outlives the deposit nor is built expired', async () => {
    let now = NOW;
    const late = (to: number, did: string[]) => ({ ...wayWith(true, did), now: () => now, confirm: async () => { did.push('asked'); now = to; return true; } });
    const slow = facadeWith();
    await finishedSentWithOwnDust(slow.doors, 'AQID', late(NOW + 25 * MINUTE, slow.did));
    /* RED WHEN: the fee is built with the deadline read before a confirm that came 25 minutes later. */
    expect(slow.did).toContain('another deadline');
    const expired = facadeWith();
    now = NOW;
    const failed = await finishedSentWithOwnDust(expired.doors, 'AQID', late(NOW + 81 * MINUTE, expired.did)).catch((e: unknown) => e);
    /* RED WHEN: a deposit that expired while the person read is still balanced and sent. */
    expect((failed as OwnFeeNotPaid).why).toBe('not-paid');
    expect(expired.did).not.toContain('balanced');
  });

  it('an expired transaction is not paid for, and the person is not asked', async () => {
    const { did, doors } = facadeWith({ deadline: new Date(NOW - 1) });
    const failed = await finishedSentWithOwnDust(doors, 'AQID', wayWith(true, did)).catch((e: unknown) => e);
    /* RED WHEN: the person is asked to pay for a deposit the network will refuse as expired. */
    expect((failed as OwnFeeNotPaid).why).toBe('not-paid');
    expect(did).not.toContain('asked');
  });

  it('too little DUST found while the fee is worked out is said as that', async () => {
    const { did, doors } = facadeWith({ estimateFails: { _tag: 'Wallet.InsufficientFunds' } });
    const failed = await finishedSentWithOwnDust(doors, 'AQID', wayWith(true, did)).catch((e: unknown) => e);
    /* RED WHEN: a wallet short of DUST at the estimate is told only that the fee could not be worked out. */
    expect((failed as OwnFeeNotPaid).why).toBe('too-little-dust');
    expect(did).not.toContain('asked');
  });

  it('a send that fails after it was handed over is not said as nothing sent', async () => {
    const { did, doors } = facadeWith({ submitFails: new Error('the node did not answer') });
    const failed = await finishedSentWithOwnDust(doors, 'AQID', wayWith(true, did)).catch((e: unknown) => e);
    /* RED WHEN: a send that may have reached the network is reported as paid nothing and sent nothing. */
    expect(failed).not.toBeInstanceOf(FeeRefused);
    expect(did).not.toContain('reverted');
  });
});
