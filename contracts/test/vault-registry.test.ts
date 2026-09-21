/**
 * WHICH VAULTS ARE THIS COMPANY'S, AND WHEN ONE STOPS BEING.
 *
 * The gap this closes is a recovery gap rather than a security one, and the
 * distinction is the reason the tests below assert what they do.
 *
 * Anyone may deploy a vault naming anyone's account — nothing consents to a
 * deployment. **That is not a theft hole:** to spend, a proposal must exist
 * whose id was computed with that vault inside it, and only a seated signer can
 * raise one. What a stranger's vault can do is exist, and be paid into. Every
 * vault that has ever PAID is already on chain by name, because `payout`
 * discloses `kernel.self().bytes` to `recordPayment`. So the chain records
 * every vault except the one that most needs recording: one that has been
 * funded and has never paid.
 *
 * Two circuits, and they are deliberately not symmetrical:
 *
 *   `adopt`        the account's alone. Nothing is asked of the vault, because
 *                  a vault that does not exist yet must not be able to stop a
 *                  company writing down what it intends to fund.
 *   `retire`       raised at the VAULT, because the round is refused while the
 *                  vault holds notes and only the vault can see its own pool.
 *                  A contract cannot read another contract's state, so the
 *                  refusal lives where the fact does and calls the account,
 *                  which owns the rule.
 *
 * The one to read last, and the one a future reader is most likely to try to
 * "fix": **a retired vault can still pay.** Nothing consults `vaults` on the
 * spend path, on purpose.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createConstructorContext, createCircuitContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract as Vault, ledger as vaultLedger, pureCircuits as vaultCircuits,
} from '../managed-vault/contract/index.js';
import { pureCircuits } from '../managed/contract/index.js';
import {
  AccountSimulator, privateStateFor, change, type Change,
} from './simulator.js';
import { buildPayoutTree, type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { toHex, fromHex } from '../../src/core/crypto.js';

const VAULT_NOW = 1_800_000_000;
const WIN_FROM = BigInt(VAULT_NOW - 3_600);
const WIN_UNTIL = BigInt(VAULT_NOW + 3_600);
const BLOCK = '0'.repeat(64);

const bytes = (n: number) => new Uint8Array(32).fill(n);

const A = privateStateFor(1);
const B = privateStateFor(2);
const C = privateStateFor(3);
const GBP = bytes(0x9b);
const ALICE = bytes(0x0a);

/** A vault address that is not a deployed vault. The account never dereferences one. */
const STRANGER = bytes(0xf1);

interface VaultPrivate {
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint };
}

const vaultWitnesses = {
  noteToSpend: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.coin],
};

const govChange = (seed: number): Change => change(0n, seed);
const carrying = (sim: AccountSimulator, d: ReturnType<typeof privateStateFor>, c: Change) =>
  sim.applying(d, c);

describe('an account keeps a register of its own vaults', () => {
  let sim: AccountSimulator;
  let vault: Vault<VaultPrivate>;
  let vaultAddr: string;
  let vaultState: any;
  let priv: VaultPrivate;

  const provider = () => ({
    getContractState: async (_b: string, address: unknown) =>
      String(address) === String(sim.address) ? (sim.contractStateForCall as never) : undefined,
  });
  const vaultBytes = () => Uint8Array.from(Buffer.from(vaultAddr, 'hex'));
  const ctx = (circuit: string) => createCircuitContext<VaultPrivate>(
    circuit, vaultAddr as never, BLOCK, vaultState, priv,
    provider() as never, undefined, undefined, VAULT_NOW, BLOCK);

  beforeEach(async () => {
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(VAULT_NOW);

    vault = new Vault<VaultPrivate>(vaultWitnesses as never);
    vaultAddr = sampleContractAddress() as never as string;
    priv = { coin: { nonce: bytes(0x77), color: GBP, value: 1_000n, mt_index: 0n } };
    const init = await vault.initialState(
      createConstructorContext({} as VaultPrivate, BLOCK),
      { bytes: Uint8Array.from(Buffer.from(String(sim.address), 'hex')) } as never);
    vaultState = init.currentContractState;
  });

  /** Raises an adoption round for `v` and takes it to the account's threshold. */
  const adoptionRound = async (v: Uint8Array, c: Change) => {
    const payload = pureCircuits.adoptVaultPayload(v);
    await sim.as(carrying(sim, A, c)).propose(payload);
    const id = sim.proposalId(payload, c.salt);
    await sim.as(carrying(sim, A, c)).approve(id);
    await sim.as(carrying(sim, B, c)).approve(id);
    return id;
  };

  /** The same, for a retirement. */
  const retirementRound = async (v: Uint8Array, c: Change) => {
    const payload = pureCircuits.retireVaultPayload(v);
    await sim.as(carrying(sim, A, c)).propose(payload);
    const id = sim.proposalId(payload, c.salt);
    await sim.as(carrying(sim, A, c)).approve(id);
    await sim.as(carrying(sim, B, c)).approve(id);
    return id;
  };

  /** Puts one note in the vault, so a retirement has something to refuse over. */
  const fund = async () => {
    const coin = { nonce: bytes(0x77), color: GBP, value: 1_000n };
    const dep = await vault.impureCircuits.deposit(ctx('deposit'), coin);
    vaultState = dep.context.callContext.currentQueryContext.state;
  };

  /** Retires through the vault, which is the only route there is. */
  const retire = async (id: Uint8Array, c: Change) => {
    const r = await vault.impureCircuits.retire(ctx('retire'), id, c.salt);
    vaultState = r.context.callContext.currentQueryContext.state;
    sim.adoptFromCall(r.context);
    return r;
  };

  it('ADOPTS a vault through a round at the account\'s own threshold', async () => {
    const c = govChange(81);
    expect(sim.adopted(vaultBytes())).toBe(false);

    const id = await adoptionRound(vaultBytes(), c);
    await sim.as(carrying(sim, A, c)).adopt(vaultBytes(), id);

    expect(sim.adopted(vaultBytes())).toBe(true);
    /* And the round is spent, exactly as every other governance round is. */
    expect(sim.isOpen(id)).toBe(false);
  });

  it('publishes HOW MANY vaults a company runs, which is the decided cost', async () => {
    /*
     * `scope-the-vault-system.md` §3.2 takes this decision rather than hiding
     * from it, and §3.6 must therefore not claim to conceal it. Asserted here
     * so that a later change which quietly made the set private would fail a
     * test rather than a review.
     */
    const c1 = govChange(82);
    await sim.as(carrying(sim, A, c1)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c1));
    const c2 = govChange(83);
    await sim.as(carrying(sim, A, c2)).adopt(STRANGER, await adoptionRound(STRANGER, c2));

    expect(sim.ledger.vaults.size()).toBe(2n);
  });

  it('refuses an adoption from somebody who is not a signer', async () => {
    const c = govChange(84);
    const id = await adoptionRound(vaultBytes(), c);
    await expect(sim.as(carrying(sim, C, c)).adopt(vaultBytes(), id))
      .rejects.toThrow(/not a signer on this account/i);
    expect(sim.adopted(vaultBytes())).toBe(false);
  });

  it('refuses an adoption before the account threshold is met', async () => {
    const c = govChange(85);
    const payload = pureCircuits.adoptVaultPayload(vaultBytes());
    await sim.as(carrying(sim, A, c)).propose(payload);
    const id = sim.proposalId(payload, c.salt);
    await sim.as(carrying(sim, A, c)).approve(id);      // one of two

    await expect(sim.as(carrying(sim, A, c)).adopt(vaultBytes(), id))
      .rejects.toThrow(/not enough approvals yet/i);
    expect(sim.adopted(vaultBytes())).toBe(false);
  });

  it('REFUSES TO ADOPT A VAULT THE ROUND DID NOT NAME', async () => {
    /*
     * The attack this exists for: a round the signers approved for the
     * company's own vault, replayed against an address they never saw. The
     * vault is inside the payload, so the id simply does not recompute.
     */
    const c = govChange(86);
    const id = await adoptionRound(vaultBytes(), c);

    await expect(sim.as(carrying(sim, A, c)).adopt(STRANGER, id))
      .rejects.toThrow(/does not authorise adopting this vault/i);
    expect(sim.adopted(STRANGER)).toBe(false);
  });

  it('refuses to adopt the same vault twice rather than burning the round silently', async () => {
    const c1 = govChange(87);
    await sim.as(carrying(sim, A, c1)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c1));

    const c2 = govChange(88);
    const id2 = await adoptionRound(vaultBytes(), c2);
    await expect(sim.as(carrying(sim, A, c2)).adopt(vaultBytes(), id2))
      .rejects.toThrow(/already adopted that vault/i);
  });

  it('an approval to adopt is not an approval to retire, or to change a threshold', async () => {
    /*
     * Domain separation, played rather than asserted about. The payload for
     * adopting a vault and the payload for setting its threshold are different
     * bytes, so a round raised for one is not a round for the other.
     */
    const v = vaultBytes();
    expect(toHex(pureCircuits.adoptVaultPayload(v)))
      .not.toBe(toHex(pureCircuits.retireVaultPayload(v)));
    expect(toHex(pureCircuits.adoptVaultPayload(v)))
      .not.toBe(toHex(pureCircuits.setVaultThresholdPayload(v, 2n)));

    const c = govChange(89);
    const id = await adoptionRound(v, c);
    await expect(sim.as(carrying(sim, A, c)).setVaultThreshold(v, 3n, id))
      .rejects.toThrow(/does not authorise this vault threshold/i);
  });

  it('RETIRES an empty vault, and the round is the account\'s to approve', async () => {
    const c1 = govChange(90);
    await sim.as(carrying(sim, A, c1)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c1));
    expect(sim.adopted(vaultBytes())).toBe(true);

    const c2 = govChange(91);
    const id = await retirementRound(vaultBytes(), c2);
    await retire(id, c2);

    expect(sim.adopted(vaultBytes())).toBe(false);
    expect(sim.isOpen(id)).toBe(false);

    /*
     * AND THE RETIREMENT IS RECORDED.
     *
     * The account keeps its own log of what it retired, because the company
     * that needs it is one whose device, database and supplier have all gone —
     * the same recovery argument that put `vaults` on chain rather than in our
     * records.
     *
     * MEMBERSHIP AND NOT A DATE, DELIBERATELY. No circuit can read the block
     * time (`blockTimeGte`/`blockTimeLt` are predicates and there is no
     * `kernel.blockTime()`), and a time taken as an argument would be the
     * caller's word for it — here, a VAULT's. So the value is a marker and the
     * date lives in the block that carries the write. The field is `Uint<64>`
     * so a real time can be written by a later circuit; the TYPE is the half
     * that can never be changed.
     */
    expect(sim.ledger.retiredAt.member(vaultBytes())).toBe(true);
  });

  it('RETIREMENT IS HALF BUILT: the retirement is logged and the STALE THRESHOLD SURVIVES', async () => {
    /*
     * WRITTEN AS AN ASSERTION RATHER THAN A SENTENCE IN A DOCUMENT, because
     * retiring a vault has two halves and only one of them is built.
     *
     * `setVaultThreshold` inserts into `thresholds` and NOTHING ANYWHERE
     * REMOVES. So a retired vault keeps its own governing
     * threshold — a number for an address the account has just declared it no
     * longer runs, which `thresholdFor` would hand straight back to
     * `requireApprovedForVault` if that address were ever adopted again.
     *
     * THIS TEST GOES RED THE DAY SOMEBODY CLOSES IT, which is the point: the
     * gap stops being something a reader has to be told and becomes something
     * the suite states. Whoever closes it changes this test in the same round.
     */
    const c1 = govChange(94);
    await sim.as(carrying(sim, A, c1)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c1));

    // Give it a threshold of its own, through its own approved round.
    const c2 = govChange(95);
    const payload = pureCircuits.setVaultThresholdPayload(vaultBytes(), 2n);
    await sim.as(carrying(sim, A, c2)).propose(payload);
    const tid = sim.proposalId(payload, c2.salt);
    await sim.as(carrying(sim, A, c2)).approve(tid);
    await sim.as(carrying(sim, B, c2)).approve(tid);
    await sim.as(carrying(sim, A, c2)).setVaultThreshold(vaultBytes(), 2n, tid);
    expect(sim.ledger.thresholds.member(vaultBytes())).toBe(true);

    const c3 = govChange(96);
    await retire(await retirementRound(vaultBytes(), c3), c3);

    // The half that is built.
    expect(sim.adopted(vaultBytes())).toBe(false);
    expect(sim.ledger.retiredAt.member(vaultBytes())).toBe(true);

    // The half it did not. Not a passing assertion dressed as coverage — this
    // is the defect, stated.
    expect(sim.ledger.thresholds.member(vaultBytes())).toBe(true);
  });

  it('THE ONE THAT MATTERS: refuses to retire a vault that still holds notes', async () => {
    /*
     * Retiring a vault holding money is the same shape as stranding an
     * account: the money stays on chain and the company's rulebook stops naming
     * the thing that holds it. The refusal has to be the CONTRACT's — a
     * client-side refusal is a client-side refusal — and the only contract that
     * can see this pool is the vault itself.
     */
    const c1 = govChange(92);
    await sim.as(carrying(sim, A, c1)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c1));
    await fund();
    expect(vaultLedger(vaultState as never).notes.size()).toBe(1n);

    const c2 = govChange(93);
    const id = await retirementRound(vaultBytes(), c2);
    await expect(retire(id, c2)).rejects.toThrow(/still holds notes/i);

    /* Still the company's, and the round is still open to be run later. */
    expect(sim.adopted(vaultBytes())).toBe(true);
    expect(sim.isOpen(id)).toBe(true);
  });

  it('refuses to retire a vault this account never adopted', async () => {
    const c = govChange(94);
    const id = await retirementRound(vaultBytes(), c);
    await expect(retire(id, c)).rejects.toThrow(/has not adopted that vault/i);
  });

  it('refuses a retirement claimed without the round\'s salt', async () => {
    /*
     * The salt is the proof of possession that stands in for `requireSigner`,
     * which a cross-contract callee cannot use: a contract holds no secret key
     * and sits in no signer tree. Without the right salt the id does not
     * recompute.
     */
    const c = govChange(95);
    await sim.as(carrying(sim, A, c)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c));
    const c2 = govChange(96);
    const id = await retirementRound(vaultBytes(), c2);

    await expect(vault.impureCircuits.retire(ctx('retire'), id, bytes(0xee)))
      .rejects.toThrow(/does not authorise retiring this vault/i);
  });

  it('refuses a retirement that has not reached the account threshold', async () => {
    const c = govChange(97);
    await sim.as(carrying(sim, A, c)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c));

    const c2 = govChange(98);
    const payload = pureCircuits.retireVaultPayload(vaultBytes());
    await sim.as(carrying(sim, A, c2)).propose(payload);
    const id = sim.proposalId(payload, c2.salt);
    await sim.as(carrying(sim, A, c2)).approve(id);     // one of two

    await expect(retire(id, c2)).rejects.toThrow(/not enough approvals yet/i);
    expect(sim.adopted(vaultBytes())).toBe(true);
  });

  it('A RETIRED VAULT CAN STILL PAY, and that is the decision rather than an oversight',
    async () => {
    /*
     * Nothing on the spend path consults `vaults`, deliberately. The list
     * answers "which vaults are this company's" for somebody who has lost
     * everything else; making it an access check would turn a governance
     * mistake — a round raised against the wrong address, a vault retired in
     * error — into money that cannot be moved. Retirement means the product
     * stops OFFERING the vault, and nothing more.
     *
     * If a later change adds a membership check to `recordPayment`, this test
     * is the one that will say so.
     */
    const c1 = govChange(99);
    await sim.as(carrying(sim, A, c1)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c1));
    const c2 = govChange(100);
    await retire(await retirementRound(vaultBytes(), c2), c2);
    expect(sim.adopted(vaultBytes())).toBe(false);

    /* Now fund it and pay somebody out of it. */
    await fund();
    const c3 = govChange(101);
    const leaves: PayoutLeafInput[] = [{
      details: toHex(vaultCircuits.payoutDetails(ALICE, GBP, 250n, bytes(0x40))),
      nonce: toHex(bytes(0xc1)),
    }];
    const tree = buildPayoutTree(leaves);
    const payload = pureCircuits.runPayload(
      fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL);
    await sim.as(carrying(sim, A, c3)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: vaultBytes() });
    const id = sim.proposalId(payload, c3.salt, vaultBytes());
    await sim.as(carrying(sim, A, c3)).approve(id);
    await sim.as(carrying(sim, B, c3)).approve(id);

    const paid = await vault.impureCircuits.payout(
      ctx('payout'),
      id, fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL, c3.salt,
      ALICE, GBP, 250n, bytes(0x40), bytes(0xc1), tree.pathFor(0) as never);

    expect(vaultLedger(
      paid.context.callContext.currentQueryContext.state as never).payments).toBe(1n);
  });
});
