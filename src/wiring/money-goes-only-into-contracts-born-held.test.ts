import { describe, it, expect } from 'vitest';
import { refusalToPutMoneyIn, vaultIsTheCompanys, type ContractAnswer, type FundingFacts } from './vault-submission.js';

/*
 * **THE MONEY GATE FOR CONTRACTS BORN HELD, ONE RULE FOR A VAULT AND FOR THE
 * ACCOUNT.** A contract is funded when this service's record holds it as born
 * held: its deploy read, before it was paid for, holding the company's
 * committee from its first transaction. Who holds it now, and how many times it
 * has been changed since, says nothing, because every change needed the
 * committee's own signatures; and the gate is handed no committee and no
 * counter at all, only whether the chain answered for each contract, so no
 * change of who holds a contract stops money.
 */
const ANSWERED: ContractAnswer = { state: 'answered' };
const facts = (over: Partial<FundingFacts> = {}): FundingFacts => ({
  label: 'v', what: 'no money goes in', vault: ANSWERED, vaultCircuits: null, pinnedAccount: 'a',
  started: true, companyAccount: 'a', account: ANSWERED, accountCircuits: null,
  bornHeld: { vault: true, account: true }, ...over,
});
const why = (f: FundingFacts): string | null => refusalToPutMoneyIn(f)?.why ?? null;

describe('MONEY GOES ONLY INTO CONTRACTS BORN HELD', () => {
  it('A VAULT AND AN ACCOUNT BORN HELD, ANSWERED FOR ON THE CHAIN, ARE FUNDED', () => {
    /* RED WHEN: a born-held contract the chain answered for is refused. */
    expect(why(facts())).toBeNull();
    expect(vaultIsTheCompanys(facts())).toBeNull();
  });

  it('A CONTRACT THE RECORD DOES NOT HOLD AS BORN HELD IS REFUSED, WHOEVER HOLDS IT NOW', () => {
    /* RED WHEN: a contract with no record of a born-held deploy passes, which is a contract another key held first. */
    expect(why(facts({ bornHeld: { vault: false, account: true } })))
      .toMatch(/^no money goes in: the rules of vault 'v' were not read by this service at their creation/);
    expect(why(facts({ bornHeld: { vault: true, account: false } })))
      .toMatch(/the rules of this company's account, which every vault pays out on, were not read/);
  });

  it('A DOOR WITH NO RECORD FUNDS NOTHING, WHOEVER HOLDS THE CONTRACT', () => {
    /* RED WHEN: a door that cannot tell a born-held vault from a stranger's pinned to the company's account funds it. */
    expect(why(facts({ bornHeld: null }))).toMatch(/this tool keeps no record of how the rules of vault 'v' were created/);
  });

  it('A CONTRACT THE CHAIN DID NOT ANSWER FOR IS NOT FUNDED, AND NOTHING ELSE ABOUT IT IS ASKED', () => {
    /* RED WHEN: a read that went unanswered is taken for an answer. */
    expect(why(facts({ vault: { state: 'unreachable', why: 'down' } }))).toMatch(/could not be asked about the rules of vault 'v'/);
    expect(why(facts({ account: { state: 'absent', why: 'none' } }))).toMatch(/could not be asked about the rules of this company's account/);
  });

  it('A CHANGE OF THE SUPER ADMINS LANDED ON SOME CONTRACTS AND NOT OTHERS STOPS NO MONEY: THE GATE READS NOBODY WHO HOLDS ONE', () => {
    /* Each contract's answer is watched: whatever the gate reaches for on it is recorded. */
    const seen: string[] = [];
    const watched = (): ContractAnswer => new Proxy({ state: 'answered' } as ContractAnswer, {
      get(t, p, r) { if (typeof p === 'string') seen.push(p); return Reflect.get(t, p, r); },
    });
    /* RED WHEN: the gate reaches for a committee, a threshold, a counter or an authority on either contract. */
    expect(why(facts({ vault: watched(), account: watched() }))).toBeNull();
    expect(seen.filter((p) => p !== 'state' && p !== 'why')).toEqual([]);
  });
});
