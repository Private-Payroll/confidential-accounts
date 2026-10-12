/**
 * **EVERY ANCHOR CALL THAT LANDED ON A COMPANY'S ACCOUNT, READ FROM ITS OWN
 * HISTORY IN THE PAGE'S WORKER.**
 *
 * What is real here: the account is the compiled account, moved on by its own
 * `anchor` circuit; each state of its history is that account's own serialised
 * state; the worker's own handler reads them with the account's own functions
 * and reads who held the account the one way a wallet reads it. What is the
 * test's: the indexer, which serves those states as the account's history.
 *
 * The head a device folds to, the committee as each anchor landed, and who
 * holds the account now as a batch's header names them, come from this history
 * at the indexer the person's own wallet names - never from the company's
 * service.
 */
import { describe, expect, it } from 'vitest';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import * as L from '@midnightntwrk/ledger-v9';
import * as accountModule from '../managed/contract/index.js';
import { pureCircuits } from '../managed/contract/index.js';
import { AccountSimulator, leafOfDevice, privateStateFor, ZERO_32 } from './simulator.js';
import { answerVaultAsk } from 'vaults-web-shared/vault-worker-entry.js';
import { signerRootOf } from 'vaults-web-shared/governed-call-builder.js';
import type { ContractHistory, ContractHistoryEntry } from '../../src/midnight/contract-history.js';
import { CREATION_STEPS } from '../../src/midnight/deferral.js';

/** The circuits the second creation step inserts: none is in an account deployed on the founding device. */
const SECOND_STEP = new Set<string>(CREATION_STEPS.second);

const A = privateStateFor(1);
const B = privateStateFor(2);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
/** The head after these batches, each anchored by its seat and judged against who holds `sim`'s account now. */
const foldOn = (sim: AccountSimulator, ...steps: (readonly [by: typeof A, batch: Uint8Array])[]) => {
  const h = sim.heldNow();
  return steps.reduce((head, [by, b]) => pureCircuits.anchorHeadOf(head, pureCircuits.anchorHeldOf(b, h.approvals, h.signerRoot, sim.anchorTagOf(by))), ZERO_32);
};
const batch = (n: number) => new Uint8Array(32).fill(n);
const INDEXER = { indexerUri: 'https://indexer.example/api/v4/graphql', indexerWsUri: 'wss://indexer.example/api/v4/graphql/ws' };

/** The account's state as the chain holds it now, serialised as the indexer serves it. */
const stateOf = (sim: AccountSimulator): Uint8Array => (sim.contractStateForCall as { serialize(): Uint8Array }).serialize();

/** A test's indexer, serving `steps` as the account's history, and counting how often the whole of it is read. */
const indexerServing = (steps: () => ContractHistoryEntry[], latest: () => string) => {
  const reads = { whole: 0 };
  const history: ContractHistory = { latest: async () => latest(), of: async () => { reads.whole += 1; return steps(); } };
  return { history, reads };
};

const ask = (history: ContractHistory, account = 'ac'.repeat(32)) => answerVaultAsk(async () => ({
  accountPure: pureCircuits, accountLedger: (accountModule as any).ledger, runtimeState: (runtime as any).ContractState,
  accountTree: { StateBoundedMerkleTree: runtime.StateBoundedMerkleTree, CompactTypeBytes: runtime.CompactTypeBytes, CompactTypeMerkleTreeDigest: runtime.CompactTypeMerkleTreeDigest },
  historyAt: (indexer: typeof INDEXER) => { expect(indexer).toEqual(INDEXER); return history; },
}) as never, { id: 1, network: 'undeployed', ask: 'anchors-on-chain', account, indexer: INDEXER } as never);

describe('THE ACCOUNT\'S ANCHORS, READ FROM ITS HISTORY IN THE WORKER', () => {
  it('EACH ANCHOR CALL THAT LANDED, OLDEST FIRST: THE HEAD IT LEFT, THE COMMITTEE THEN, AND ITS BLOCK; A STEP THAT MOVED NO HEAD IS NOT ONE', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(1_800_000_000);
    const steps: ContractHistoryEntry[] = [];
    const step = (n: number) => steps.push({ kind: n === 0 ? 'deploy' : 'call', transaction: `${n}`.padStart(64, '0'), state: stateOf(sim), block: { height: 10 + n, at: 1_800_000_000_000 + n }, succeeded: true });
    step(0);
    await sim.as(A).anchor(ZERO_32, batch(1));
    step(1);
    /* A call that moved no head: the account acted, and the anchor stayed where it was. */
    step(2);
    await sim.as(B).anchor(foldOn(sim, [A, batch(1)]), batch(2));
    step(3);
    const answer = await ask(indexerServing(() => steps, () => '3'.padStart(64, '0')).history) as unknown as {
      ok: boolean; landed: any[]; now: { approvals: number; signerRoot: string; signers: string[] }; seatsNow: string[]; error?: string;
    };
    expect(answer.ok, answer.error).toBe(true);
    /* RED WHEN: a step that moved no head is read as an anchor, or the deploy is - two anchors landed, and only two. */
    expect(answer.landed.map((l) => [l.head, l.height, l.at])).toEqual([
      [hex(foldOn(sim, [A, batch(1)])), 11, 1_800_000_000_001],
      [hex(foldOn(sim, [A, batch(1)], [B, batch(2)])), 13, 1_800_000_000_003],
    ]);
    /* RED WHEN: the committee is not read off the state each anchor left. */
    for (const l of answer.landed) expect(Array.isArray(l.committee)).toBe(true);
    /* RED WHEN: who holds the account now is not read off the history's latest state as a header names them: the approvals the
     * account requires, the root of its signer tree as the account's own ledger holds it, and each slot's leaf. */
    expect(answer.now.approvals).toBe(2);
    expect(answer.now.signerRoot).toBe(sim.heldNow().signerRoot.field.toString(16).padStart(64, '0'));
    expect(answer.now.signers).toEqual([hex(leafOfDevice(A)), hex(leafOfDevice(B))]);
    expect([...answer.seatsNow].sort()).toEqual([hex(leafOfDevice(A)), hex(leafOfDevice(B))].sort());
  });

  it("WHO HOLDS THE ACCOUNT NOW, AFTER A SIGNER IS REMOVED: THE REMOVED SIGNER'S SLOT HOLDS THE VACANT LEAF, AND THE LEAVES MAKE THE ACCOUNT'S ROOT", async () => {
    const C = privateStateFor(3);
    const sim = await AccountSimulator.liveAccount([A, B, C], 2n);
    /* The deploy's state, before the removal: the history's first step. */
    const before = stateOf(sim);
    const c = { asset: new Uint8Array(32), amount: 0n, batch: new Uint8Array(32), salt: new Uint8Array(32).fill(77) };
    const payload = pureCircuits.removeSignerPayload(sim.leafOf(A));
    await sim.as(sim.applying(B, c as never)).propose(payload);
    const id = sim.proposalId(payload, c.salt);
    await sim.as(B).approve(id);
    await sim.as(C).approve(id);
    await sim.as(sim.applying(B, c as never)).removeSigner(sim.leafOf(A), id);
    /* RED WHEN who holds the account now is read off any step but the latest: here the deploy's still holds A. */
    const steps: ContractHistoryEntry[] = [
      { kind: 'deploy', transaction: '04'.repeat(32), state: before, block: { height: 1, at: 1 }, succeeded: true },
      { kind: 'call', transaction: '05'.repeat(32), state: stateOf(sim), block: { height: 2, at: 2 }, succeeded: true },
    ];
    const answer = await ask(indexerServing(() => steps, () => '05'.repeat(32)).history, 'ae'.repeat(32)) as unknown as {
      ok: boolean; now: { approvals: number; signerRoot: string; signers: string[] }; seatsNow: string[]; error?: string;
    };
    expect(answer.ok, answer.error).toBe(true);
    /* RED WHEN: a removed signer's slot is left out or read as a seat - the leaves would then not make the account's root. */
    expect(answer.now.signers).toEqual([hex(pureCircuits.vacantSlot()), hex(leafOfDevice(B)), hex(leafOfDevice(C))]);
    expect([...answer.seatsNow].sort()).toEqual([hex(leafOfDevice(B)), hex(leafOfDevice(C))].sort());
    expect(answer.now.signerRoot).toBe(sim.heldNow().signerRoot.field.toString(16).padStart(64, '0'));
    /* RED WHEN: the root a device rebuilds from the leaves is not the account's own: every honest anchor's seats would be unbelieved. */
    const tree = { StateBoundedMerkleTree: runtime.StateBoundedMerkleTree, CompactTypeBytes: runtime.CompactTypeBytes, CompactTypeMerkleTreeDigest: runtime.CompactTypeMerkleTreeDigest };
    expect(signerRootOf({ accountTree: tree as never }, answer.now.signers)).toBe(answer.now.signerRoot);
    /* RED WHEN: the account's own anchor refuses the holders read here: they are the account's as its circuit checks them. */
    await sim.as(B).anchor(ZERO_32, batch(3), { approvals: BigInt(answer.now.approvals), signerRoot: { field: BigInt(`0x${answer.now.signerRoot}`) } });
    expect(hex(sim.anchorHead()!)).toBe(hex(foldOn(sim, [B, batch(3)])));
  });

  it('A HISTORY IS READ AGAIN IN FULL ONLY WHEN THE ACCOUNT HAS ACTED SINCE; AN ACCOUNT THAT IS NOT ONE IS NOT ASKED ABOUT', async () => {
    const sim = await AccountSimulator.liveAccount([A], 1n);
    const steps: ContractHistoryEntry[] = [{ kind: 'deploy', transaction: '01'.repeat(32), state: stateOf(sim), block: { height: 1, at: 1 }, succeeded: true }];
    let latest = '01'.repeat(32);
    const served = indexerServing(() => steps, () => latest);
    const account = 'ad'.repeat(32);
    expect((await ask(served.history, account) as unknown as { landed: unknown[] }).landed).toEqual([]);
    await ask(served.history, account);
    /* RED WHEN: the whole history is read again for every read though the account has not acted - every read of a record pays for it. */
    expect(served.reads.whole).toBe(1);
    await sim.as(A).anchor(ZERO_32, batch(7));
    steps.push({ kind: 'call', transaction: '02'.repeat(32), state: stateOf(sim), block: { height: 2, at: 2 }, succeeded: true });
    latest = '02'.repeat(32);
    /* RED WHEN: a history kept from an earlier read is answered after the account has acted - an anchor since would go unseen. */
    expect((await ask(served.history, account) as unknown as { landed: Array<{ head: string }> }).landed.map((l) => l.head)).toEqual([hex(foldOn(sim, [A, batch(7)]))]);
    expect(served.reads.whole).toBe(2);
    /* RED WHEN: the indexer is asked about something that is not an account's address. */
    await expect(ask(served.history, 'not an account')).rejects.toThrow(/not a company account this device can name/u);
  });

  it('HOW THE ACCOUNT WAS DEPLOYED, FROM ITS HISTORY\'S FIRST STEP: ITS SEATS, ITS COMMITTEE AND THRESHOLD, AND WHETHER IT RAN THE ANCHOR ALREADY', async () => {
    const sim = await AccountSimulator.liveAccount([A], 1n);
    const founder = L.signatureVerifyingKey(L.signingKeyFromBip340(new Uint8Array(32).fill(5)));
    /* The account's state as a deploy leaves it: the circuits it was deployed with, held by `committee` at `threshold`. */
    const deployedWith = (circuits: (name: string) => boolean, committee: unknown[], threshold: number, counter = 0n): Uint8Array => {
      const full = runtime.ContractState.deserialize(stateOf(sim)) as unknown as {
        data: unknown; operations(): Array<string | Uint8Array>; operation(n: string | Uint8Array): unknown;
      };
      const state = new runtime.ContractState() as unknown as { data: unknown; setOperation(n: string | Uint8Array, op: unknown): void; serialize(): Uint8Array };
      state.data = full.data;
      for (const op of full.operations()) {
        const name = typeof op === 'string' ? op : new TextDecoder().decode(op);
        if (circuits(name)) state.setOperation(op, full.operation(op));
      }
      const onLedger = L.ContractState.deserialize(state.serialize());
      onLedger.maintenanceAuthority = new L.ContractMaintenanceAuthority(committee as never, threshold, counter);
      return onLedger.serialize();
    };
    const read = async (steps: ContractHistoryEntry[], account: string) => {
      const answer = await ask(indexerServing(() => steps, () => steps[steps.length - 1]!.transaction).history, account) as unknown as {
        ok: boolean; deployed: { seats: string[]; committee: Array<{ tag: string; value: string }>; threshold: number; updates: number; ranSecondStep: boolean } | null; error?: string;
      };
      expect(answer.ok, answer.error).toBe(true);
      return answer.deployed;
    };
    const deploy = (state: Uint8Array): ContractHistoryEntry => ({ kind: 'deploy', transaction: '0a'.repeat(32), state, block: { height: 1, at: 1 }, succeeded: true });
    const firstStepOnly = deployedWith((n) => !SECOND_STEP.has(n), [founder], 1);
    /* RED WHEN: the seats, the committee or its threshold are not read off the deploy's own state. */
    expect(await read([deploy(firstStepOnly), { kind: 'call', transaction: '0b'.repeat(32), state: deployedWith(() => true, [founder, founder], 2), block: { height: 2, at: 2 }, succeeded: true }], 'b1'.repeat(32)))
      .toEqual({ seats: [hex(leafOfDevice(A))], committee: [{ tag: String((founder as any).tag), value: String((founder as any).value).toLowerCase() }], threshold: 1, updates: 0, ranSecondStep: false });
    /* RED WHEN: an account deployed already running its anchor, a second-step circuit, is not read so. */
    expect((await read([deploy(deployedWith(() => true, [founder], 1))], 'b2'.repeat(32)))?.ranSecondStep).toBe(true);
    expect((await read([deploy(deployedWith((n) => !SECOND_STEP.has(n) || n === 'anchor', [founder], 1))], 'b5'.repeat(32)))?.ranSecondStep).toBe(true);
    /* RED WHEN: a first step whose committee had already been updated - in the deploy's own block - is not read so. */
    expect((await read([deploy(deployedWith((n) => !SECOND_STEP.has(n), [founder], 1, 1n))], 'b4'.repeat(32)))?.updates).toBe(1);
    /* RED WHEN: a history whose first step is not the deploy is read as one. */
    expect(await read([{ ...deploy(firstStepOnly), kind: 'call' }], 'b3'.repeat(32))).toBeNull();
  });
});
