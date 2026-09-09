/**
 * **WHICH CONTRACT A COMPANY'S READS GO TO, AND THE ONE ANSWER THAT MUST NEVER
 * BE GIVEN.**
 *
 * The property under test is not "an address is returned". It is that the rule
 * has **no way to answer with an address it was not handed for that account** -
 * so the case that matters most below is the one where a real, resolved,
 * perfectly good contract address is sitting in the deployment beside the rule
 * and the answer is still nothing.
 *
 * Why that is the shape: each company is its own deployed contract, and the
 * deployment holds exactly one address. A rule that reached for it when an
 * account had none would give every company the same balances, the same open
 * rounds and the same signer set. **Nothing would look broken.** Each screen
 * would be full, internally consistent, and about somebody else's company.
 *
 * The second half is the handover. An address does not exist anywhere until a
 * deploy returns it, and the product reads it back through this same lookup
 * moments later. A book that could only read the durable record would answer
 * nothing there, and the company that had just been created would be filed with
 * no address and unreadable ever after.
 */
import { describe, it, expect } from 'vitest';
import { ContractBook, contractForAccount, type RecordedContract } from './account-contract.js';

/*
 * **BOTH ADDRESSES ARE FABRICATED, AND THAT IS DELIBERATE.** The first draft of
 * this file used the address of a live deployment, read out of a declared
 * secrets root, and the secret scan refused the commit. It was right to: a
 * contract address is public on chain, but a value that reaches a shipping file
 * from that folder is a class of defect this repository has already paid for,
 * and a scanner that told an address from a key would be guessing.
 *
 * Nothing here depends on either value being real. They need to be well formed
 * and different from each other, and they are.
 */
const REAL = '11111111222222223333333344444444555555556666666677777777aaaabbbb';
const ANOTHER = '99999999222222223333333344444444555555556666666677777777aaaabbbb';

const onChain = (address: string | null): RecordedContract =>
  ({ address, source: 'chain', wiring: 'chain' });

describe('an account resolves to its own contract and to nothing else', () => {
  /*
   * RED WHEN: the rule returns anything other than what it was handed for this
   * account - a deployment address, a constant, a first-account fallback.
   */
  it('answers with the address on the account\'s own record', () => {
    expect(contractForAccount('acc_1', onChain(REAL), 'chain')).toBe(REAL);
  });

  /*
   * **THE CASE THE WHOLE FILE EXISTS FOR.**
   *
   * RED WHEN: an account with no recorded address is given a fallback. The
   * assertion is deliberately `toBeNull` and not `not.toBe(SOMETHING)`, because
   * a fallback could be any of several plausible values and this refuses all of
   * them at once.
   */
  it('answers with nothing for an account nobody has opened, and invents no address', () => {
    expect(contractForAccount('acc_never_opened', null, 'chain')).toBeNull();
    expect(contractForAccount('acc_no_address', onChain(null), 'chain')).toBeNull();
    expect(contractForAccount('acc_blank', onChain('   '), 'chain')).toBeNull();
  });

  /*
   * **TWO COMPANIES, TWO CONTRACTS, AND NEITHER LEAKS INTO THE OTHER.**
   *
   * RED WHEN: the rule caches, or resolves from anything shared between
   * accounts. A single-account rule passes every case above and fails this one.
   */
  it('two accounts resolve to two different contracts', () => {
    expect(contractForAccount('acc_1', onChain(REAL), 'chain')).toBe(REAL);
    expect(contractForAccount('acc_2', onChain(ANOTHER), 'chain')).toBe(ANOTHER);
    expect(contractForAccount('acc_1', onChain(REAL), 'chain')).toBe(REAL);
  });

  /*
   * **AN INVENTED ADDRESS HAS THE SHAPE OF A REAL ONE, WHICH IS WHY THE SOURCE
   * IS CHECKED AND NOT THE STRING.**
   *
   * RED WHEN: the source check is dropped, or absence is read as a chain's. The
   * cost of letting one through is not an error: the indexer answers that it has
   * no state for a contract that was never deployed, and the company reads as
   * empty rather than as unreadable.
   */
  it('refuses an address no chain assigned', () => {
    expect(() => contractForAccount('acc_1', { address: REAL, source: 'simulated', wiring: 'chain' }, 'chain'))
      .toThrow(/no chain assigned/);
  });

  it('refuses an address whose provenance nothing noted, rather than assuming a chain', () => {
    expect(() => contractForAccount('acc_1', { address: REAL, source: null, wiring: 'chain' }, 'chain'))
      .toThrow(/no chain assigned/);
  });

  /*
   * RED WHEN: the running ledger is not compared, or absence is read as a
   * match. A record nothing marked cannot be vouched for by the thing reading
   * it.
   */
  it('refuses a record written by a different ledger', () => {
    expect(() => contractForAccount('acc_1', { address: REAL, source: 'chain', wiring: 'simulated' }, 'chain'))
      .toThrow(/recorded by a simulated/);
  });

  it('refuses a record no ledger marked', () => {
    expect(() => contractForAccount('acc_1', { address: REAL, source: 'chain', wiring: null }, 'chain'))
      .toThrow(/ledger nothing noted/);
  });

  /*
   * RED WHEN: a refusal is reworded to name a thing to run or a variable to
   * set. Whoever reads these is looking at a log or a browser console, and the
   * same fact is missing in both.
   */
  it('every refusal names a state and not a thing to type', () => {
    for (const bad of [
      { address: REAL, source: 'simulated', wiring: 'chain' } as RecordedContract,
      { address: REAL, source: 'chain', wiring: 'simulated' } as RecordedContract,
    ]) {
      const said = (() => {
        try { contractForAccount('acc_1', bad, 'chain'); return 'it did not refuse'; }
        catch (e) { return (e as Error).message; }
      })();
      expect(said).not.toMatch(/\.command|npm run|[A-Z]{3,}_[A-Z_]+=|set the /);
      expect(said).toContain('acc_1');
    }
  });
});

describe('the book holds an address between a deploy returning and the account being filed', () => {
  /*
   * **THE HANDOVER, AND WITHOUT IT A SUCCESSFUL DEPLOY PRODUCES AN UNREADABLE
   * COMPANY.**
   *
   * RED WHEN: `record` stops holding, or `lookUp` reads only the durable
   * record. This is the exact sequence opening an account performs: the ledger
   * hands the address over, and the product asks for it back before anything
   * has been written down.
   */
  it('answers with an address handed over moments ago, before any record exists', async () => {
    const book = new ContractBook(() => null, 'chain');
    expect(await book.lookUp('acc_1')).toBeNull();
    await book.record('acc_1', REAL);
    expect(await book.lookUp('acc_1')).toBe(REAL);
  });

  /*
   * **AND IT IS INSTEAD OF A RECORD, NEVER AS WELL AS ONE.**
   *
   * RED WHEN: the handover entry is consulted first, or is not dropped once the
   * record answers. Either leaves two places that can answer differently, which
   * is the drift this book exists to have none of.
   */
  it('the durable record wins the moment there is one, and the handover is dropped', async () => {
    let filed: RecordedContract | null = null;
    const book = new ContractBook(() => filed, 'chain');

    await book.record('acc_1', ANOTHER);
    expect(await book.lookUp('acc_1')).toBe(ANOTHER);

    filed = onChain(REAL);
    expect(await book.lookUp('acc_1')).toBe(REAL);

    /* And the handover is gone rather than shadowed: with the record removed
     * again there is nothing left to fall back to. */
    filed = null;
    expect(await book.lookUp('acc_1')).toBeNull();
  });

  /*
   * RED WHEN: a handover for one account can answer for another.
   */
  it('a handover answers for one account only', async () => {
    const book = new ContractBook(() => null, 'chain');
    await book.record('acc_1', REAL);
    expect(await book.lookUp('acc_2')).toBeNull();
  });

  /*
   * RED WHEN: the book swallows the rule's refusals - by catching, or by
   * answering the handover entry when the record is bad. A record that cannot
   * be vouched for must reach the caller as a refusal, not as an older address.
   */
  it('a record that cannot be vouched for refuses, and no handover rescues it', async () => {
    let filed: RecordedContract | null = { address: REAL, source: 'simulated', wiring: 'chain' };
    const book = new ContractBook(() => filed, 'chain');
    await book.record('acc_1', ANOTHER);
    await expect(book.lookUp('acc_1')).rejects.toThrow(/no chain assigned/);

    /*
     * **AND THE HANDOVER IS GONE RATHER THAN WAITING.** A record that refuses
     * refuses every time, so an entry left beside it would live for the whole
     * process - holding the one kind of address this rule says a read can never
     * vouch for, ready to answer the moment the record went away.
     *
     * RED WHEN: the refusal propagates without dropping the entry.
     */
    filed = null;
    expect(await book.lookUp('acc_1'),
      'the handover survived a refusal').toBeNull();
  });
});
