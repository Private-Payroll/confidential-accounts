import { describe, it, expect } from 'vitest';
import type { AuthorityRead } from '../midnight/ledger.js';
import type { Committee } from '../midnight/vault-committee.js';
import { refusalToPutMoneyIn, committeeHoldsTheVault, type FundingFacts } from './vault-submission.js';

/*
 * **THE MONEY GATE FOR CONTRACTS BORN HELD, ONE RULE FOR A VAULT AND FOR THE
 * ACCOUNT.** A contract is funded when the chain shows the company's committee
 * holding it now and this service's record holds it as born held: its deploy
 * read, before it was paid for, holding that committee from its first
 * transaction. How many times it has been changed since says nothing, because
 * every change needed the committee's own signatures.
 */
const k = (n: number) => ({ tag: 'schnorr', value: n.toString(16).padStart(64, '0') });
const read = (committee: Committee, counter: bigint, address = 'v'): AuthorityRead => ({
  state: 'read', address,
  authority: {
    committee: committee.committee.map((x) => ({ ...x })), threshold: committee.threshold, counter,
    shape: committee.committee.length === 1 && committee.threshold === 1 ? 'one-key' : 'committee', hasDuplicateMembers: false,
  },
});
const ONE: Committee = { committee: [k(1)], threshold: 1 };
const THREE: Committee = { committee: [k(1), k(2), k(3)], threshold: 2 };
const facts = (company: Committee, vaultCounter: bigint, accountCounter: bigint, over: Partial<FundingFacts> = {}): FundingFacts => ({
  label: 'v', what: 'no money goes in', vault: read(company, vaultCounter), vaultCircuits: null, pinnedAccount: 'a',
  started: true, companyAccount: 'a', account: read(company, accountCounter, 'a'), accountCircuits: null,
  committee: company, heldHere: [], bornHeld: { vault: true, account: true }, ...over,
});
const why = (f: FundingFacts): string | null => refusalToPutMoneyIn(f)?.why ?? null;

describe('MONEY GOES ONLY INTO CONTRACTS BORN HELD', () => {
  it('A ONE-SIGNER COMPANY BORN HELD IS FUNDED AT COUNTER 0, ITS ACCOUNT AND ITS VAULT', () => {
    /* RED WHEN: counter 0 is read as never handed over. */
    expect(why(facts(ONE, 0n, 0n))).toBeNull();
    expect(committeeHoldsTheVault(facts(ONE, 0n, 0n))).toBeNull();
  });

  it('A VAULT BORN TO A WHOLE COMMITTEE IS FUNDED AT COUNTER 0, AND AT ANY COUNTER AFTER', () => {
    for (const [v, a] of [[0n, 0n], [0n, 1n], [1n, 1n], [2n, 3n], [9n, 1n]] as const) {
      /* RED WHEN: a born-held contract is refused for how many times its committee changed it. */
      expect(why(facts(THREE, v, a)), `${v}/${a}`).toBeNull();
    }
  });

  it('A CONTRACT THE RECORD DOES NOT HOLD AS BORN HELD IS REFUSED AT EVERY COUNTER, WHOEVER HOLDS IT NOW', () => {
    for (const counter of [0n, 1n, 2n]) {
      /* RED WHEN: counter 1 passes with no record, which is a contract another key held first. */
      expect(why(facts(THREE, counter, 1n, { bornHeld: { vault: false, account: true } })), `vault ${counter}`)
        .toMatch(/^no money goes in: the rules of vault 'v' were not read by this service at their creation/);
      expect(why(facts(THREE, 1n, counter, { bornHeld: { vault: true, account: false } })), `account ${counter}`)
        .toMatch(/the rules of this company's account, which every vault pays out on, were not read/);
    }
  });

  it('A DOOR WITH NO RECORD FUNDS NOTHING, EVEN A COMMITTEE THE STRUCTURAL QUESTION PASSES', () => {
    /* A stranger's vault pinned to the company's account and held by three keys of their own, none of them here. */
    const strangers = facts(THREE, 0n, 1n, { committee: null, bornHeld: null });
    /* RED WHEN: counter 0 is relaxed for a door that cannot tell a born-held vault from a stranger's. */
    expect(why(strangers)).toMatch(/this tool keeps no record of how the rules of vault 'v' were created/);
    expect(why({ ...strangers, vault: read(THREE, 1n) })).toMatch(/this tool keeps no record/);
  });

  it('NEVER A COMMITTEE ANY ONE OF SEVERAL KEYS COULD CHANGE ALONE, AT THE PRODUCT\'S DOOR AS AT THE OPERATOR\'S', () => {
    const loose: Committee = { committee: [k(1), k(2)], threshold: 1 };
    /* RED WHEN: the product's door funds what the operator's door refuses. */
    expect(why(facts(loose, 1n, 1n))).toMatch(/could change them alone/);
    expect(why(facts(loose, 1n, 1n, { committee: null, bornHeld: null }))).toMatch(/any one member of its committee/);
    /* One signer alone is a company, not this. */
    expect(why(facts(ONE, 1n, 1n))).toBeNull();
  });

  it('THE CHAIN STILL DECIDES WHO HOLDS IT: A BORN-HELD CONTRACT THE COMMITTEE NO LONGER HOLDS IS REFUSED', () => {
    /* Born held by the founding signer alone; a second signer seated; the change not yet signed. */
    const two: Committee = { committee: [k(1), k(2)], threshold: 2 };
    const f = { ...facts(two, 0n, 0n), vault: read(ONE, 0n), account: read(ONE, 0n, 'a') };
    expect(why(f)).toMatch(/not held by the company's committee on the chain/);
    expect(why(f)).toMatch(/its committee is changed to match in Settings/);
  });
});
