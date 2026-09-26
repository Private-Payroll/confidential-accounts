/**
 * **A COIN MADE FOR A VAULT THAT NO CALL OF THE VAULT CLAIMS IS REFUSED BY THE
 * LEDGER'S WELL-FORMEDNESS CHECK.**
 *
 * A deposit is a call into the vault that claims the one coin it makes. The
 * question this pins is what the ledger does with a transaction that makes a
 * coin owned by the vault and has no call of the vault claiming it. If it took
 * it, the coin would be the vault's with no note naming it, and nobody could
 * ever pay it out.
 *
 * It does not take it. The well-formedness check requires the coins a
 * transaction makes for each contract to equal, as a set, the coins that
 * contract's calls claim in the same segment. What is run here is the case of
 * no call at all, in the ledger library this product builds with, against a
 * blank ledger state; a call that claims one coin while another is made for the
 * vault meets the same comparison, and is not run here because it needs a
 * proved call.
 */
import { describe, it, expect } from 'vitest';

const NETWORK = 'undeployed';
const VAULT = 'ab'.repeat(32);
const COIN = { type: 'cd'.repeat(32), nonce: 'ef'.repeat(32), value: 5n };

describe('a coin made for a vault that no call claims', () => {
  it('IS REFUSED BY THE LEDGER\'S WELL-FORMEDNESS CHECK, WHILE THE SAME COIN MADE FOR A PERSON IS NOT', async () => {
    const L = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
    /* Only the ownership rule is under test: proofs, signatures and balance are not asked of either transaction. */
    const strictness = new L.WellFormedStrictness();
    strictness.enforceBalancing = false;
    strictness.verifyNativeProofs = false;
    strictness.verifyContractProofs = false;
    strictness.verifySignatures = false;
    const check = (output: ReturnType<typeof L.ZswapOutput.new>) => () =>
      L.Transaction.fromParts(NETWORK, L.ZswapOffer.fromOutput(output, COIN.type, COIN.value))
        .wellFormed(L.LedgerState.blank(NETWORK), strictness, new Date());

    /* RED WHEN: the ledger stops requiring a contract's coins to be claimed by the contract's own call. */
    expect(check(L.ZswapOutput.newContractOwned(COIN, 0, VAULT)), 'a coin owned by the vault with no call claiming it was taken')
      .toThrow(/contract-associated commitments must be claimed/);

    /* The control: the same coin for a person is well formed, so the refusal above is the ownership rule and not the setup. */
    const person = L.ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(7));
    expect(check(L.ZswapOutput.new(COIN, 0, person.coinPublicKey, person.encryptionPublicKey)), 'the control transaction is not well formed')
      .not.toThrow();
  });
});
