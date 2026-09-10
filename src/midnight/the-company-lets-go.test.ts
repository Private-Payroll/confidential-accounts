/**
 * **THE COMPANY'S OWN COINS, AND THE THREE AWAITS THAT COULD STRAND THEM.**
 *
 * The half of the fee-sponsorship split that belongs to the company is one
 * method with three calls in it. The first books coins in the company's wallet;
 * the second signs; the third proves and binds. Either of the last two can
 * throw, and until this file existed the booking simply stood afterwards -
 * nothing releases it by time, and the vendor's own cleanup only ever acts on
 * transactions the chain answered for, which one that was never submitted never
 * gets.
 *
 * -- WHY IT IS ITS OWN FILE AND NOT A SECTION IN THE FEE PAYER'S ------------
 *
 * **BECAUSE THE MONEY IS SOMEBODY ELSE'S.** The fee payer's coins are ours: a
 * stranded booking there takes a little of the fee budget out of circulation
 * and an operator can see it. These are the company's, on a device we do not
 * operate, where the only repair is a resync somebody has to be asked to
 * perform - and a company whose coins are stranded part way through a payroll
 * run cannot pay anybody.
 *
 * -- WHAT THESE CASES ESTABLISH AND WHAT THEY CANNOT -------------------------
 *
 * They are about the bookkeeping and about nothing else. `BalancingWallet` is
 * an interface and the wallet here is a hand-written one, which is that seam
 * used as designed. **No coin is booked and no coin is released**: what is
 * measured is that the calls are made, on the paths where they must be, with
 * the object the vendor would need to find the booking by.
 */
import { describe, it, expect } from 'vitest';
import { SponsoredCustomerWallet, CUSTOMER_TOKEN_KINDS, type BalancingWallet } from './wallet.js';

const wallet = (over: Partial<BalancingWallet> = {}) => {
  const reverted: unknown[] = [];
  const calls: string[] = [];
  const it: BalancingWallet = {
    async balanceUnboundTransaction(tx, _keys, options) {
      calls.push('balanceUnboundTransaction');
      return { booking: tx, options };
    },
    async balanceFinalizedTransaction(tx) { calls.push('balanceFinalizedTransaction'); return tx; },
    async signRecipe(recipe) { calls.push('signRecipe'); return { signed: recipe }; },
    async finalizeRecipe(recipe) { calls.push('finalizeRecipe'); return { finalised: recipe }; },
    async submitTransaction() { calls.push('submitTransaction'); return 'tx_1'; },
    async revert(booking) { calls.push('revert'); reverted.push(booking); },
    ...over,
  };
  return { it, reverted, calls };
};

const company = (w: BalancingWallet) => new SponsoredCustomerWallet(
  w,
  { shieldedSecretKeys: 'company-shielded', dustSecretKey: 'company-dust' },
  () => 'a signature',
  { coinPublicKey: 'not-a-secret: a test literal', encryptionPublicKey: 'not-a-secret: a test literal' },
);

describe('the company balances only what it owns', () => {
  it('balances shielded and unshielded, and never dust', async () => {
    /*
     * **THE ONE RULE THE WHOLE DESIGN RESTS ON.** The fee payer balances dust;
     * re-balancing a kind the other party already balanced is a double spend
     * and the node rejects the whole transaction. And the argument is OPTIONAL
     * with a default of everything, so omitting it does not fail - it quietly
     * makes the company pay its own fee out of coins it may not have.
     *
     * RED WHEN: `tokenKindsToBalance` is removed from the call, or widened to
     * include `'dust'`, or replaced by the string `'all'`.
     */
    const w = wallet();
    const out: any = await company(w.it).balanceOwnLegs({ tx: 1 }, new Date());
    const kinds = out.finalised.signed.booking === undefined
      ? out.finalised.signed.options.tokenKindsToBalance
      : out.finalised.signed.options.tokenKindsToBalance;
    expect(kinds).toEqual(['shielded', 'unshielded']);
    expect(kinds).not.toContain('dust');
  });

  it('and the two constants it shares with the fee payer do not overlap', () => {
    // RED WHEN: either constant is widened. Stated here as well as on the fee
    // payer's side because the two files can be edited apart.
    expect([...CUSTOMER_TOKEN_KINDS]).not.toContain('dust');
  });

  it('passes the caller\'s deadline through untouched', async () => {
    // A company quietly extending its own TTL keeps a transaction submittable
    // after the fee payer intended it to expire.
    // RED WHEN: `ttl` is replaced by a deadline computed here.
    const ttl = new Date('2026-01-01T00:00:00Z');
    const w = wallet();
    const out: any = await company(w.it).balanceOwnLegs({ tx: 1 }, ttl);
    expect(out.finalised.signed.options.ttl).toBe(ttl);
  });
});

describe('a booking the company made and did not spend is let go', () => {
  it('releases when SIGNING throws', async () => {
    /*
     * RED WHEN: the `try` around the sign and the finalise is removed. The
     * coins are booked by the line above it, so without the guard a keystore
     * that refuses leaves the company's coins in flight for ever.
     */
    const w = wallet({ signRecipe: async () => { throw new Error('the keystore refused'); } });
    await expect(company(w.it).balanceOwnLegs({ tx: 1 }, new Date()))
      .rejects.toThrow(/keystore refused/);
    expect(w.reverted, 'signing threw and the booking was left standing').toHaveLength(1);
  });

  it('releases when FINALISING throws', async () => {
    // RED WHEN: the `try` starts after `signRecipe` rather than before it.
    const w = wallet({ finalizeRecipe: async () => { throw new Error('the proof would not build'); } });
    await expect(company(w.it).balanceOwnLegs({ tx: 1 }, new Date()))
      .rejects.toThrow(/would not build/);
    expect(w.reverted).toHaveLength(1);
  });

  it('releases the object the BALANCE produced, not the one it was handed', async () => {
    /*
     * **THE VENDOR'S RELEASE LOOKS A BOOKING UP.** Handed the wrong object it
     * finds nothing, frees nothing, and throws nothing either - so a release
     * against the input transaction is the whole failure wearing a fix, and no
     * count anywhere can tell it from one that worked.
     *
     * RED WHEN: `this.release(recipe)` becomes `this.release(tx)`.
     */
    const w = wallet({ signRecipe: async () => { throw new Error('no'); } });
    await expect(company(w.it).balanceOwnLegs({ the: 'transaction' }, new Date()))
      .rejects.toThrow();
    expect(w.reverted[0]).toEqual(expect.objectContaining({ booking: { the: 'transaction' } }));
  });

  it('releases NOTHING when the balance succeeded', async () => {
    /*
     * The negative control. A release against a booking that is on its way to
     * a submission marks coins available that are about to be spent, and the
     * wallet's local state then runs ahead of the chain.
     *
     * RED WHEN: the release is moved out of the `catch` and into a `finally`.
     */
    const w = wallet();
    await company(w.it).balanceOwnLegs({ tx: 1 }, new Date());
    expect(w.reverted).toEqual([]);
    expect(w.calls).not.toContain('revert');
  });

  it('a release that fails does not replace the failure that caused it', async () => {
    /*
     * RED WHEN: the `try` inside `release` is removed. The caller is then
     * handed a complaint about tidying up in place of the error naming what
     * actually went wrong, which sends whoever reads it to the wrong layer.
     */
    const w = wallet({
      signRecipe: async () => { throw new Error('the real problem'); },
      revert: async () => { throw new Error('the cleanup also failed'); },
    });
    await expect(company(w.it).balanceOwnLegs({ tx: 1 }, new Date()))
      .rejects.toThrow(/the real problem/);
  });

  it('and the owner of both phases can release one this method already returned', async () => {
    /*
     * **THE WINDOW THIS COVERS IS OUTSIDE THIS CLASS ENTIRELY.** The balance
     * succeeds and the operation is then abandoned - the fee payer refuses, a
     * deadline passes, a caller gives up. The method has returned by then, so
     * its own guard cannot fire, and the interface had no member anybody could
     * call.
     *
     * RED WHEN: `release` stops being public, or stops reaching `revert`.
     */
    const w = wallet();
    const c = company(w.it);
    const booked = await c.balanceOwnLegs({ tx: 1 }, new Date());
    await c.release(booked);
    expect(w.reverted).toEqual([booked]);
  });
});
