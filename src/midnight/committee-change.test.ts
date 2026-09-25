import { describe, it, expect } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import type { AuthorityRead, OnChainAuthority } from './ledger.js';
import { committeeDifference, contractsOwingAChange, seatsOf } from './committee-change.js';
import { buildCommitteeChange, type CommitteeChangeLedger } from './company-authority.js';
import {
  refusalForCommitteeChange, refusalToPutMoneyIn, whyTheHistoryDoesNotVouch, type ContractHistoryStep, type FundingFacts,
} from '../wiring/vault-submission.js';

/*
 * A company's committee changed after its contracts were handed over: which
 * contracts owe the change, how it is put together from signatures made one at
 * a time, what the fee payer pays for, and when a contract changed more than
 * once is still vouched for. Every change here is applied by the ledger's own
 * state machine with signatures checked.
 */
const NET = 'undeployed';
const sk = (n: number) => L.signingKeyFromBip340(new Uint8Array(32).fill(n));
const vk = (n: number) => L.signatureVerifyingKey(sk(n));
const sorted = (...ns: number[]) => ns.map(vk).map((k) => ({ tag: k.tag, value: k.value })).sort((a, b) => (a.value < b.value ? -1 : 1));
const read = (address: string, committee: { tag: string; value: string }[], threshold: number, counter: bigint): AuthorityRead => ({
  state: 'read', address,
  authority: {
    committee, threshold, counter, hasDuplicateMembers: new Set(committee.map((k) => k.value)).size !== committee.length,
    shape: threshold < 1 ? 'anyone' : committee.length === 0 || threshold > committee.length ? 'no-one' : committee.length === 1 ? 'one-key' : 'committee',
  } as OnChainAuthority,
});
const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);

/** The ledger's own state machine, one transaction per block, signatures checked. */
class Chain {
  state: any = L.LedgerState.blank(NET);
  apply(tx: any): { ok: boolean; error: string } {
    const s = new L.WellFormedStrictness();
    s.enforceBalancing = false; s.verifyNativeProofs = false; s.verifyContractProofs = false; s.enforceLimits = false; s.verifySignatures = true;
    const now = new Date(); const t = BigInt(Math.floor(now.getTime() / 1000));
    let verified: any;
    try { verified = tx.wellFormed(this.state, s, now); } catch (e) { return { ok: false, error: String((e as Error).message ?? e) }; }
    const [next, r] = this.state.apply(verified, new L.TransactionContext(this.state, {
      secondsSinceEpoch: t, secondsSinceEpochErr: 30, parentBlockHash: '00'.repeat(32), lastBlockTime: t - 6n }));
    if (r.type === 'success') this.state = next;
    return { ok: r.type === 'success', error: String(r.error ?? '') };
  }
  deploy(committee: number[], threshold: number): string {
    const cs = new L.ContractState();
    cs.maintenanceAuthority = new L.ContractMaintenanceAuthority(committee.map(vk), threshold, 0n);
    const d = new L.ContractDeploy(cs);
    const r = this.apply(L.Transaction.fromParts(NET, undefined, undefined, L.Intent.new(new Date(Date.now() + 600_000)).addDeploy(d)));
    if (!r.ok) throw new Error(r.error);
    return String(d.address);
  }
  authority(address: string): AuthorityRead {
    const a = this.state.index(address).maintenanceAuthority;
    return read(address, [...a.committee].map((k: any) => ({ tag: k.tag, value: k.value })), a.threshold, a.counter);
  }
}
const withTemporaryKeyOff = (chain: Chain, address: string, to: { committee: { tag: string; value: string }[]; threshold: number }, signer: number) => {
  let u = new L.MaintenanceUpdate(address, [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority(to.committee as never, to.threshold, 1n))], 0n);
  u = u.addSignature(0n, L.signData(sk(signer), u.dataToSign));
  const r = chain.apply(L.Transaction.fromParts(NET, undefined, undefined, L.Intent.new(new Date(Date.now() + 600_000)).addMaintenanceUpdate(u)));
  if (!r.ok) throw new Error(r.error);
};

describe('WHO JOINS, WHO LEAVES, AND WHICH CONTRACTS OWE THE CHANGE', () => {
  it('reads the difference between the committee now and the one to install', () => {
    const d = committeeDifference({ committee: sorted(1, 2), threshold: 1 }, { committee: sorted(2, 3), threshold: 2 });
    expect(d.joins.map((k) => k.value)).toEqual([vk(3).value]);
    expect(d.leaves.map((k) => k.value)).toEqual([vk(1).value]);
    expect(d.stays.map((k) => k.value)).toEqual([vk(2).value]);
    expect([d.thresholdNow, d.thresholdAfter]).toEqual([1, 2]);
  });

  it('OWES A CHANGE ONLY WHERE A HANDED-OVER CONTRACT HOLDS A COMMITTEE OTHER THAN THE COMPANY\'S, AND SAYS WHY FOR THE REST', () => {
    const company = { committee: sorted(1, 2), threshold: 2 };
    const { owed, notChangeable } = contractsOwingAChange([
      { contract: 'account', read: read(A, sorted(1, 2), 2, 1n) },
      { contract: 'vault', read: read(B, sorted(1), 1, 1n) },
      { contract: 'vault', read: read('c3'.repeat(32), sorted(9), 1, 0n) },
      { contract: 'vault', read: read('d4'.repeat(32), sorted(1, 2), 0, 3n) },
      { contract: 'vault', read: read('d5'.repeat(32), sorted(1, 2), 3, 3n) },
      { contract: 'vault', read: { state: 'unreachable', address: 'e5'.repeat(32), why: 'down' } },
      /* Same keys, other order: not the company's value, so it owes the change. */
      { contract: 'vault', read: read('f6'.repeat(32), [...sorted(1, 2)].reverse(), 2, 1n) },
    ], company);
    /* RED WHEN: a contract already holding the company's committee is offered a change, or one that does not hold it is not. */
    expect(owed.map((o) => [o.address, o.counter])).toEqual([[B, 1n], ['f6'.repeat(32), 1n]]);
    expect(owed[0]!.now).toEqual({ committee: sorted(1), threshold: 1 });
    expect(notChangeable.map((n) => n.address)).toEqual(['c3'.repeat(32), 'd4'.repeat(32), 'd5'.repeat(32), 'e5'.repeat(32)]);
    expect(notChangeable[0]!.why).toMatch(/handed to the committee first/);
    expect(notChangeable[1]!.why).toMatch(/anybody can change/);
    expect(notChangeable[2]!.why).toMatch(/nobody can ever sign a change/);
    expect(notChangeable[3]!.why).toMatch(/could not be asked/);
  });

  it('a key signs at every seat it holds', () => {
    expect(seatsOf(vk(1), { committee: [vk(1), vk(2), vk(1)], threshold: 2 })).toEqual([0, 2]);
    expect(seatsOf(vk(3), { committee: [vk(1)], threshold: 1 })).toEqual([]);
  });
});

describe('THE CHANGE PUT TOGETHER FROM SIGNATURES MADE ONE AT A TIME, AND APPLIED BY THE LEDGER', () => {
  it('WAITS UNTIL THE COMMITTEE HOLDING IT NOW HAS SIGNED ENOUGH, THEN THE LEDGER ACCEPTS IT AND A LEAVER HOLDS NOTHING', () => {
    const chain = new Chain();
    const address = chain.deploy([9], 1);
    withTemporaryKeyOff(chain, address, { committee: sorted(1, 2, 3), threshold: 2 }, 9);
    const to = { committee: sorted(1, 2), threshold: 2 };
    const now = chain.authority(address);
    const seatOf = (n: number) => (now.state === 'read' ? now.authority.committee.findIndex((k) => k.value === vk(n).value) : -1);
    const unsigned = buildCommitteeChange(L as unknown as CommitteeChangeLedger, { read: now, to, signatures: [], network: NET, ttl: new Date(Date.now() + 600_000), label: 'x' });
    /* Each signer signs on their own, over bytes they could make themselves. */
    const bytes = new L.MaintenanceUpdate(address, [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority(to.committee as never, 2, 2n))], 1n).dataToSign;
    const one = { seat: seatOf(1), signature: L.signData(sk(1), bytes) };
    const two = { seat: seatOf(2), signature: L.signData(sk(2), bytes) };
    const half = buildCommitteeChange(L as unknown as CommitteeChangeLedger, { read: now, to, signatures: [one], network: NET, ttl: new Date(Date.now() + 600_000), label: 'x' });
    expect([unsigned.have, half.have, half.required, half.unproven]).toEqual([0, 1, 2, null]);
    /* RED WHEN: a signature is taken for a seat whose key did not make it. */
    expect(() => buildCommitteeChange(L as unknown as CommitteeChangeLedger, {
      read: now, to, signatures: [{ seat: seatOf(2), signature: one.signature }], network: NET, ttl: new Date(Date.now() + 600_000), label: 'x',
    })).toThrow(/does not verify against the key in seat/);
    const full = buildCommitteeChange(L as unknown as CommitteeChangeLedger, { read: now, to, signatures: [two, one], network: NET, ttl: new Date(Date.now() + 600_000), label: 'x' });
    expect(full.seatsSigned).toEqual([seatOf(1), seatOf(2)].sort());
    expect(refusalForCommitteeChange(full.unproven, {
      address, to, onChain: (now as Extract<AuthorityRead, { state: 'read' }>).authority, contract: 'vault',
    })).toBeNull();
    expect(chain.apply(full.unproven)).toEqual({ ok: true, error: '' });
    expect(chain.authority(address)).toEqual(read(address, to.committee, 2, 2n));
    /* RED WHEN: the one who left can still sign a change. */
    let alone = new L.MaintenanceUpdate(address, [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority([vk(3)], 1, 3n))], 2n);
    alone = alone.addSignature(0n, L.signData(sk(3), alone.dataToSign)).addSignature(1n, L.signData(sk(3), alone.dataToSign));
    expect(chain.apply(L.Transaction.fromParts(NET, undefined, undefined, L.Intent.new(new Date(Date.now() + 600_000)).addMaintenanceUpdate(alone))).ok).toBe(false);
  });

  it('IS NOT BUILT FOR A CONTRACT STILL HELD BY ITS CREATOR\'S KEY, ONE ANYBODY CAN CHANGE, OR ONE ALREADY THE COMPANY\'S', () => {
    const P = L as unknown as CommitteeChangeLedger;
    const to = { committee: sorted(1, 2), threshold: 2 };
    const base = { to, signatures: [], network: NET, ttl: new Date(Date.now() + 600_000), label: 'the vault' };
    expect(() => buildCommitteeChange(P, { ...base, read: read(A, sorted(9), 1, 0n) })).toThrow(/handed to the committee first/);
    expect(() => buildCommitteeChange(P, { ...base, read: read(A, sorted(9), 0, 2n) })).toThrow(/need no signature at all/);
    expect(() => buildCommitteeChange(P, { ...base, read: read(A, sorted(8, 9), 3, 2n) })).toThrow(/can never be changed/);
    expect(() => buildCommitteeChange(P, { ...base, read: read(A, to.committee, 2, 2n) })).toThrow(/already held by the company's committee/);
    expect(() => buildCommitteeChange(P, { ...base, read: read(A, sorted(1), 1, 2n), to: { committee: [...sorted(1), ...sorted(1)], threshold: 2 } }))
      .toThrow(/will not be changed/);
  });
});

describe('WHAT THE FEE PAYER PAYS FOR', () => {
  const to = { committee: sorted(1, 2), threshold: 2 };
  const onChain = (read(A, sorted(1, 3), 1, 4n) as Extract<AuthorityRead, { state: 'read' }>).authority;
  const tx = (address: string, committee: { tag: string; value: string }[], threshold: number, counter: bigint, sign = true, extra = false) => {
    const updates: object[] = [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority(committee as never, threshold, counter + 1n))];
    if (extra) updates.push(new L.ReplaceAuthority(new L.ContractMaintenanceAuthority(committee as never, threshold, counter + 1n)));
    let u = new L.MaintenanceUpdate(address, updates as never, counter);
    if (sign) u = u.addSignature(0n, L.signData(sk(1), u.dataToSign));
    return L.Transaction.fromParts(NET, undefined, undefined, L.Intent.new(new Date(Date.now() + 600_000)).addMaintenanceUpdate(u));
  };
  const expect_ = { address: A, to, onChain, contract: 'vault' as const };

  it('pays for exactly the company\'s committee installed against the counter on the chain, signed enough', () => {
    expect(refusalForCommitteeChange(tx(A, to.committee, 2, 4n), expect_)).toBeNull();
  });

  it('REFUSES ANOTHER CONTRACT, ANOTHER COMMITTEE OR THRESHOLD, A STALE COUNTER, TWO CHANGES, TOO FEW SIGNATURES, OR A CONTRACT STILL AT ITS HANDOVER', () => {
    /* Each RED WHEN its own check is removed. */
    expect(refusalForCommitteeChange(tx(B, to.committee, 2, 4n), expect_)).toMatch(/changes a different contract/);
    expect(refusalForCommitteeChange(tx(A, sorted(1, 3), 2, 4n), expect_)).toMatch(/not this company's committee/);
    expect(refusalForCommitteeChange(tx(A, to.committee, 1, 4n), expect_)).toMatch(/not this company's committee/);
    expect(refusalForCommitteeChange(tx(A, to.committee, 2, 3n), expect_)).toMatch(/built against counter 3/);
    expect(refusalForCommitteeChange(tx(A, to.committee, 2, 4n, true, true), expect_)).toMatch(/more than one change/);
    expect(refusalForCommitteeChange(tx(A, to.committee, 2, 4n, false), expect_)).toMatch(/fewer signatures than the 1/);
    const twoNeeded = (read(A, sorted(1, 3), 2, 4n) as Extract<AuthorityRead, { state: 'read' }>).authority;
    expect(refusalForCommitteeChange(tx(A, to.committee, 2, 4n), { ...expect_, onChain: twoNeeded })).toMatch(/fewer signatures than the 2/);
    const atHandover = (read(A, sorted(9), 1, 0n) as Extract<AuthorityRead, { state: 'read' }>).authority;
    expect(refusalForCommitteeChange(tx(A, to.committee, 2, 0n), { ...expect_, onChain: atHandover })).toMatch(/handed to the committee first/);
  });
});

describe('A CONTRACT CHANGED MORE THAN ONCE IS VOUCHED FOR ONLY BY ITS WHOLE HISTORY', () => {
  const r = (committee: number[], threshold: number, counter: bigint) => read(A, sorted(...committee), threshold, counter);
  const history = (): ContractHistoryStep[] => [
    { kind: 'deploy', transaction: 't0', authority: r([9], 1, 0n), circuits: null },
    { kind: 'update', transaction: 't1', authority: r([1], 1, 1n), circuits: null },
    { kind: 'call', transaction: 't2', authority: r([1], 1, 1n), circuits: null },
    { kind: 'update', transaction: 't3', authority: r([1, 2], 1, 2n), circuits: null },
  ];
  const now = r([1, 2], 1, 2n);

  it('vouches for a contract created by one key that made one change and let go, every change in order, every state this build\'s', () => {
    expect(whyTheHistoryDoesNotVouch(history(), now)).toBeNull();
  });

  it('A CHANGE THE CHAIN DID NOT APPLY IS PASSED OVER, AS THE INDEXER LISTS EVERY CHANGE ASKED FOR WITH ITS BLOCK\'S STATE', () => {
    /* A second copy of change 2 sent after it landed: listed, with the counter it found. RED WHEN such a step
     * strands the contract for good. */
    const refusedCopy: ContractHistoryStep = { kind: 'update', transaction: 't4', authority: r([1, 2], 1, 2n), circuits: null };
    expect(whyTheHistoryDoesNotVouch([...history(), refusedCopy], now)).toBeNull();
    /* And one before any change landed. */
    const early: ContractHistoryStep = { kind: 'update', transaction: 't0b', authority: r([9], 1, 0n), circuits: null };
    expect(whyTheHistoryDoesNotVouch([history()[0]!, early, ...history().slice(1)], now)).toBeNull();
    /* Two changes in one block show as one step whose counter moved by two: what it held between is unread. */
    const both: ContractHistoryStep[] = [history()[0]!, { ...history()[1]!, authority: r([1, 2], 1, 2n) }];
    expect(whyTheHistoryDoesNotVouch(both, now)).toMatch(/goes from 0 change\(s\) to 2 in one step/);
  });

  it('DOES NOT VOUCH WHEN ANY LINK IS MISSING OR WRONG', () => {
    const h = history;
    const cases: Array<[ContractHistoryStep[], RegExp]> = [
      [[], /does not begin with it being created/],
      [h().slice(1), /does not begin with it being created/],
      [[h()[0]!, ...h()], /created more than once/],
      [[{ ...h()[0]!, authority: r([9, 8], 2, 0n) }, ...h().slice(1)], /not created held by one key/],
      [[{ ...h()[0]!, circuits: 'x' }, ...h().slice(1)], /created with circuits other than this build's/],
      /* The key it was created with is still on its rules after the first change. RED WHEN that check goes. */
      [[h()[0]!, { ...h()[1]!, authority: r([9, 1], 1, 1n) }, ...h().slice(2)], /left the key it was created with/],
      /* A change missing from the history. */
      [[h()[0]!, h()[1]!, h()[2]!, { ...h()[3]!, authority: r([1, 2], 1, 3n) }], /missing from the history or two were made at once/],
      /* A change that left another build's circuit in force. RED WHEN only the state now is checked. */
      [[h()[0]!, h()[1]!, h()[2]!, { ...h()[3]!, circuits: 'swapped' }], /circuits other than this build's: swapped/],
      /* A change and a call in one transaction. */
      [[h()[0]!, h()[1]!, { ...h()[2]!, transaction: 't1' }, h()[3]!], /also did something else to it/],
      [h().slice(0, 3), /history shows 1 change\(s\) and the chain says it has been changed 2 times/],
      [[h()[0]!, h()[1]!, h()[2]!, { ...h()[3]!, authority: { state: 'unreadable', address: A, why: 'odd' } }], /cannot be read \(odd\)/],
    ];
    for (const [steps, why] of cases) expect(whyTheHistoryDoesNotVouch(steps, now)).toMatch(why);
  });

  const facts = (over: Partial<FundingFacts> = {}): FundingFacts => ({
    label: 'v', what: 'no money goes into this vault', vault: now, vaultCircuits: null, pinnedAccount: B, companyAccount: B,
    committee: { committee: sorted(1, 2), threshold: 1 }, heldHere: [], account: r([1, 2], 1, 1n), accountCircuits: null, ...over,
  });

  it('THE GATE EVERY DOOR ASKS: A VAULT CHANGED TWICE PASSES ONLY WITH A HISTORY THAT VOUCHES', () => {
    /* RED WHEN: a door that read no history lets a vault changed more than once through. */
    expect(refusalToPutMoneyIn(facts())!.why).toMatch(/changed 2 times, and this service could not read the chain's record of those changes/);
    expect(refusalToPutMoneyIn(facts({ vaultHistory: 'a change is missing' }))!.why).toMatch(/does not show that every change was made safely.*quote this: a change is missing/);
    expect(refusalToPutMoneyIn(facts({ vaultHistory: null }))).toBeNull();
    /* And the account the vault pays out on, the same way. */
    const accountTwice = r([1, 2], 1, 2n);
    expect(refusalToPutMoneyIn(facts({ vaultHistory: null, account: accountTwice }))!.why).toMatch(/account.*changed 2 times/);
    expect(refusalToPutMoneyIn(facts({ vaultHistory: null, account: accountTwice, accountHistory: null }))).toBeNull();
    /* Changed once is the handover, and needs no history, exactly as before. */
    expect(refusalToPutMoneyIn(facts({ vault: r([1, 2], 1, 1n) }))).toBeNull();
  });
});
