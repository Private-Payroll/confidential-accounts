/**
 * **THE PAGE AND THE WALLET READ ONE LIST OF THE KINDS OF PROPOSAL, AND OF WHICH ARE EVER WITHDRAWN.** The page names
 * the kind it asks the wallet about, and offers a withdrawal, from the same entries the wallet refuses or sends one by
 * (`KINDS_IN_THE_WALLET`), so the two cannot disagree about a kind.
 */
import { describe, expect, it } from 'vitest';
import { KINDS_IN_THE_WALLET, kindInTheWallet, NEVER_WITHDRAWN as LISTED_NEVER, neverWithdrawn, WALLET_KIND as LISTED_KIND } from './proposal-kinds-in-the-wallet.js';
import { NEVER_WITHDRAWN, WALLET_KIND } from './proposal-in-the-wallet.js';

describe('ONE LIST OF THE KINDS OF PROPOSAL THE WALLET ACTS ON', () => {
  it('the page names each kind, and holds back each withdrawal, from the very list the wallet reads', () => {
    /* RED WHEN: the page keeps its own list of the wallet's names or of what is never withdrawn, beside the wallet's. */
    expect(WALLET_KIND).toBe(LISTED_KIND);
    expect(NEVER_WITHDRAWN).toBe(LISTED_NEVER);
  });

  it('a change of a spending policy or of the approvals a policy change needs is named by its own kind and may be withdrawn', () => {
    /* RED WHEN: a policy proposal is listed under a kind the wallet does not act on, or the page never offers its withdrawal though the wallet sends one. */
    expect(WALLET_KIND['set-spending-policy']).toBe('spending-policy');
    expect(WALLET_KIND['set-policy-bar']).toBe('policy-bar');
    expect(NEVER_WITHDRAWN.has('set-spending-policy')).toBe(false);
    expect(NEVER_WITHDRAWN.has('set-policy-bar')).toBe(false);
  });

  it('the pay-record key is withdrawn only once the chain holds it outrun, which the page cannot see, so the page never offers it', () => {
    const payKey = kindInTheWallet('pay-key')!;
    /* RED WHEN: the wallet refuses the key's withdrawal even when the chain holds it outrun, or the page offers one the wallet would refuse. */
    expect(neverWithdrawn(payKey)).toBe(false);
    expect(NEVER_WITHDRAWN.has('pay-key')).toBe(true);
    /* RED WHEN: adding a vault or its first secret could be withdrawn, though raised again they could never be carried out. */
    expect(NEVER_WITHDRAWN.has('adopt-vault') && NEVER_WITHDRAWN.has('vault-secret')).toBe(true);
    expect(neverWithdrawn(kindInTheWallet('adopt-vault')!)).toBe(true);
  });

  it('every kind the page can name maps back to the one entry it came from', () => {
    for (const [sealed, named] of Object.entries(WALLET_KIND)) {
      /* RED WHEN: two kinds of the wallet claim one sealed kind, so the page could ask about the wrong one. */
      expect(KINDS_IN_THE_WALLET[named]!.sealedAs).toBe(sealed);
    }
    expect(kindInTheWallet('toString')).toBeNull();
  });
});
