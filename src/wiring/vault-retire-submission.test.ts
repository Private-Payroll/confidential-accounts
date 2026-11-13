/**
 * **WHAT THE COMPANY'S FEE PAYER PAYS FOR WHEN A VAULT IS RETIRED**: the vault's own `retire`, which refuses while the
 * vault holds money, and the company's account's `retireVault` it asks, both in one transaction that moves no coin.
 * The transactions are the shapes the service reads, made by hand.
 */
import { describe, it, expect } from 'vitest';
import { refusalForForgetUnshielded, refusalForRetire } from './vault-retire-submission.js';

const ACCOUNT = 'c0'.repeat(32);
const VAULT = 'ab'.repeat(32);
const OTHER = 'ee'.repeat(32);
const tx = (actions: unknown[], over: Record<string, unknown> = {}) => ({ intents: new Map([[1, { actions }]]), ...over });
const call = (address: string, entryPoint: string) => ({ address, entryPoint: new TextEncoder().encode(entryPoint) });
const both = [call(VAULT, 'retire'), call(ACCOUNT, 'retireVault')];
const refuse = /Nothing was sent\./u;

describe('A VAULT\'S RETIRE, AS THE FEE PAYER READS IT', () => {
  it('pays for this vault\'s retire asking this company\'s account to retire it, and nothing else', () => {
    expect(refusalForRetire(tx(both), { vault: VAULT, account: ACCOUNT })).toBeNull();
    /* RED WHEN: a retire of another vault, or one asking another account, is paid for under this vault's route. */
    expect(refusalForRetire(tx(both), { vault: OTHER, account: ACCOUNT })).toMatch(refuse);
    expect(refusalForRetire(tx(both), { vault: VAULT, account: OTHER })).toMatch(refuse);
    /* RED WHEN: the account's retire is paid for without the vault's own, which is what refuses a vault still holding money. */
    expect(refusalForRetire(tx([call(ACCOUNT, 'retireVault')]), { vault: VAULT, account: ACCOUNT })).toMatch(refuse);
    /* RED WHEN: another call rides beside the retire. */
    expect(refusalForRetire(tx([...both, call(VAULT, 'payout')]), { vault: VAULT, account: ACCOUNT })).toMatch(refuse);
    /* RED WHEN: a retire that moves coins is paid for. */
    expect(refusalForRetire(tx(both, { guaranteedOffer: { inputs: [{}], outputs: [], transients: [] } }), { vault: VAULT, account: ACCOUNT }))
      .toMatch(/moves coins/u);
    /* RED WHEN: a retire that moves coins is refused in words about another call, so the sentence is not true of what it refused. */
    expect(refusalForRetire(tx(both, { guaranteedOffer: { inputs: [{}], outputs: [], transients: [] } }), { vault: VAULT, account: ACCOUNT }))
      .toMatch(/this vault being retired moves none/u);
  });
});

describe('A PUBLIC TOKEN TAKEN OFF A VAULT\'S LIST BEFORE ITS RETIRE, AS THE FEE PAYER READS IT', () => {
  const forget = [call(VAULT, 'forgetUnshielded')];
  it('pays for exactly one forgetUnshielded call to this vault that moves no coin, and nothing else', () => {
    expect(refusalForForgetUnshielded(tx(forget), { vault: VAULT })).toBeNull();
    /* RED WHEN: a token is taken off another vault's list under this vault's route. */
    expect(refusalForForgetUnshielded(tx(forget), { vault: OTHER })).toMatch(refuse);
    /* RED WHEN: another call of the vault, or a second call beside it, is paid for as a token taken off the list. */
    expect(refusalForForgetUnshielded(tx([call(VAULT, 'payoutUnshielded')]), { vault: VAULT })).toMatch(refuse);
    expect(refusalForForgetUnshielded(tx([...forget, call(VAULT, 'retire')]), { vault: VAULT })).toMatch(refuse);
    expect(refusalForForgetUnshielded(tx([...forget, call(ACCOUNT, 'retireVault')]), { vault: VAULT })).toMatch(refuse);
    /* RED WHEN: a call that moves coins is paid for as one that takes a token off the list, or is refused in words about another call. */
    expect(refusalForForgetUnshielded(tx(forget, { guaranteedOffer: { inputs: [{}], outputs: [], transients: [] } }), { vault: VAULT }))
      .toMatch(/a public token being taken off this vault's list moves none/u);
    expect(refusalForForgetUnshielded(tx([...forget, call(VAULT, 'retire')]), { vault: VAULT }))
      .toMatch(/exactly one 'forgetUnshielded' call to this vault/u);
  });
});
