/**
 * **A RUN IS CHARGED ON THE DEVICE AS WHAT ITS PROPOSAL WAS RAISED AS.** A run
 * of its own names no leg; a retry names the leg it pays again, and what that
 * leg's retries have taken is worked out again here from the company's records
 * and taken only when it opens what the chain keeps. Every case runs the
 * charge's own builder with the account's compiled pure circuits, over a chain
 * held here, up to the call it would prove.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { pureCircuits } from '../../../contracts/managed/contract/index.js';
import { assetIdHex } from '../../../src/core/assets.js';
import { fromHex, toHex } from '../../../src/core/crypto.js';
import { sumTreeOfLeaves } from '../../../src/midnight/payout-tree.js';
import { policyOpeningFromWire } from '../../../src/midnight/spending-policy-record.js';
import { TEST_TOKEN } from '../../../src/testing/assets.js';
import { buildClearRun, type RunToChargeOnTheWire, type RunTreeOnTheWire } from './run-charge-builder.js';

const P = pureCircuits;
const ASSET = assetIdHex(TEST_TOKEN).toLowerCase();
const VAULT = 'a1'.repeat(32);
const ACCOUNT = 'cc'.repeat(32);
const BLINDING = 'b1'.repeat(32);
const NOW = 1_800_000_000n;
const OPENING = {
  terms: {
    bands: [{ ceiling: '1000', approvals: '1' }, { ceiling: '2000', approvals: '1' }, { ceiling: '3000', approvals: '1' }, { ceiling: '4000', approvals: '1' }],
    periodLimit: '5000', periodStart: String(NOW - 86_400n), periodLength: String(30n * 86_400n),
  },
  blinding: 'c3'.repeat(32),
};
const POLICY = policyOpeningFromWire(OPENING);
const WINDOW = { opensAt: NOW, closesAt: NOW + 3_600n };
const NO_LEG = new Uint8Array(32);

const leaf = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
/** A tree of the company's, as its record names it. */
const treeOf = (leaves: string[], amounts: bigint[]): RunTreeOnTheWire & { top: bigint; total: bigint } => {
  const t = sumTreeOfLeaves(leaves as never, amounts, ASSET as never);
  return { root: t.root.toLowerCase(), leaves, amounts: amounts.map(String), top: t.top as unknown as bigint, total: t.total };
};
const LEG = treeOf([leaf(1), leaf(2), leaf(3)], [400n, 250n, 350n]);
const THE_RETRY = treeOf([leaf(2)], [250n]);
/* The leg's earlier retries, as the records name them: none names a proposal this device believes, so none is ruled out by the chain. */
const EARLIER = [treeOf([leaf(1)], [400n]), treeOf([leaf(3)], [350n])].map((t) => ({ ...t, proposal: null }));
const FRESH = 'f1'.repeat(32);

/* The chain as one block holds it. */
let roles: Map<string, Uint8Array>;
let open: Map<string, Uint8Array>;
const view = () => ({
  signerRoles: { member: (k: Uint8Array) => roles.has(toHex(k)), lookup: (k: Uint8Array) => roles.get(toHex(k))! },
  openProposals: { member: (k: Uint8Array) => open.has(toHex(k)), lookup: (k: Uint8Array) => open.get(toHex(k))! },
});
const policyKey = () => P.policyKeyOf(fromHex(VAULT), P.assetKeyOf(fromHex(ASSET), fromHex(BLINDING)));
const periodKey = () => P.periodKeyOf(policyKey(), P.policyCommitmentOf(POLICY), 0n);
const legCharged = () => P.chargedKeyOf(periodKey(), fromHex(LEG.root));
const takenOnChain = (total: bigint) => P.legTakenOf(total, P.periodBlindingOf(POLICY.blinding, 0n));

/** What the call would be proved with: its arguments and the record it reads, or nothing when it was refused first. */
let built: { args: unknown[]; record: { legTaken?: bigint; periodSpent?: bigint } } | null;
const deps = () => ({
  accountPure: P,
  runtimeState: { deserialize: () => ({ data: null }) },
  accountLedger: () => view(),
  ledger: {
    ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: '', encryptionPublicKey: '' }) },
    ZswapChainState: class {}, LedgerParameters: { deserialize: () => ({}) },
  },
  contracts: {
    createUnprovenCallTxFromInitialStates: async (_: unknown, o: { args: unknown[]; initialPrivateState: never }) => {
      built = { args: o.args, record: o.initialPrivateState };
      return { private: { nextPrivateState: o.initialPrivateState, unprovenTx: {} } };
    },
  },
  prove: async () => ({ serialize: () => new Uint8Array([1]) }),
  random: (n: number) => new Uint8Array(n),
} as never);

/** A run raised over `tree` with salt `retrySaltOf(leg, fresh)`, open on the chain, as it is handed to be charged. */
const raised = (tree: RunTreeOnTheWire, leg: Uint8Array, retry?: RunToChargeOnTheWire['retry'], fresh = FRESH): RunToChargeOnTheWire => {
  const salt = P.retrySaltOf(leg, fromHex(fresh));
  const id = P.proposalIdOf(P.runPayload(fromHex(tree.root), BigInt(tree.leaves.length), WINDOW.opensAt, WINDOW.closesAt, 1n), fromHex(VAULT), salt);
  open.set(toHex(id), new Uint8Array(32).fill(9));
  return {
    proposal: toHex(id), vault: VAULT, salt: toHex(salt), required: '1', opensAt: String(WINDOW.opensAt), closesAt: String(WINDOW.closesAt),
    asset: ASSET, assetBlinding: BLINDING, policy: OPENING, root: tree.root, leaves: tree.leaves, amounts: tree.amounts, fresh,
    ...(retry === undefined ? {} : { retry }),
  };
};
const charge = (run: RunToChargeOnTheWire) =>
  buildClearRun(deps(), { account: ACCOUNT, run, runs: [], chain: { accountState: new Uint8Array(0), parameters: new Uint8Array(0) } });
const asRetry = { leg: { root: LEG.root, leaves: LEG.leaves, amounts: LEG.amounts }, others: EARLIER };

beforeEach(() => {
  built = null;
  roles = new Map([[toHex(policyKey()), P.policyCommitmentOf(POLICY)]]);
  open = new Map();
});

describe('A RUN IS CHARGED AS WHAT ITS PROPOSAL WAS RAISED AS', () => {
  it('A RUN OF ITS OWN NAMES NO LEG AND THE FRESH HALF OF ITS SALT', async () => {
    await charge(raised(LEG, NO_LEG));
    /* RED WHEN: a run of its own is charged naming a leg, or with another fresh salt than its record keeps. */
    expect(built!.args.slice(-4)).toEqual([NO_LEG, fromHex(FRESH), 0n, 0n]);
  });

  it('A RETRY NAMES ITS LEG, ITS FRESH SALT AND ITS LEG\'S TOP AND TOTAL', async () => {
    await charge(raised(THE_RETRY, fromHex(LEG.root), asRetry));
    /* RED WHEN: a retry is charged without its leg, so the chain charges its people whole a second time. */
    expect(built!.args.slice(-4)).toEqual([fromHex(LEG.root), fromHex(FRESH), LEG.top, LEG.total]);
  });

  it('A SALT THAT IS NOT retrySaltOf(LEG OR NONE, FRESH) IS REFUSED BEFORE ANYTHING IS BUILT', async () => {
    /* RED WHEN: a run raised as a retry is charged as a run of its own. */
    await expect(charge({ ...raised(THE_RETRY, fromHex(LEG.root), asRetry), retry: undefined }))
      .rejects.toThrow(/was not raised as a run of its own with the salt its record holds/);
    /* RED WHEN: a run of its own is charged as a retry of a leg its salt does not name. */
    await expect(charge({ ...raised(THE_RETRY, NO_LEG), retry: asRetry })).rejects.toThrow(/was not raised over the leg its record names/);
    expect(built).toBeNull();
  });
});

describe('WHAT A LEG\'S RETRIES HAVE TAKEN, WORKED OUT AGAIN FROM THE RECORDS', () => {
  it('IS NOTHING WHILE THE CHAIN HOLDS ONLY THE MARK THAT THE LEG WAS CHARGED, OR THE LEG WAS NOT CHARGED IN THE PERIOD', async () => {
    roles.set(toHex(legCharged()), P.chargedMark());
    await charge(raised(THE_RETRY, fromHex(LEG.root), asRetry));
    /* RED WHEN: a leg's first retry says earlier retries took something, which the chain refuses. */
    expect(built!.record.legTaken).toBe(0n);
    roles.delete(toHex(legCharged()));
    await charge(raised(THE_RETRY, fromHex(LEG.root), asRetry));
    /* RED WHEN: a retry of a leg not charged in its period says its leg's retries took something: the chain charges it as a run of its own. */
    expect(built!.record.legTaken).toBe(0n);
  });

  it('IS THE TOTAL OF THE LEG\'S OTHER RETRIES THAT OPENS WHAT THE CHAIN KEEPS', async () => {
    roles.set(toHex(legCharged()), takenOnChain(350n));
    await charge(raised(THE_RETRY, fromHex(LEG.root), asRetry));
    /* RED WHEN: what the leg's retries took is not found among the records' retries, or another total that does not open the chain's is used. */
    expect(built!.record.legTaken).toBe(350n);
    roles.set(toHex(legCharged()), takenOnChain(750n));
    await charge(raised(THE_RETRY, fromHex(LEG.root), asRetry));
    /* RED WHEN: only one earlier retry at a time is tried, so a third retry after two free ones is refused and its people left unpaid. */
    expect(built!.record.legTaken).toBe(750n);
  });

  it('WHEN NO TOTAL OF THE RECORDS OPENS IT, NOTHING IS CHARGED, AND THE REFUSAL SAYS WHAT IS MISSING AND WHAT A RUN OF ITS OWN WOULD COST', async () => {
    roles.set(toHex(legCharged()), takenOnChain(300n));
    /* RED WHEN: a retry whose leg's taken total cannot be made again is charged anyway, as free or as a run of its own. */
    await expect(charge(raised(THE_RETRY, fromHex(LEG.root), asRetry)))
      .rejects.toThrow(/a retry of this leg that was charged is missing from the company's records[\s\S]*charge its whole 250 to the period/);
    expect(built).toBeNull();
  });

  it('A LEG WHOSE RECORD DOES NOT MAKE ITS ROOT, OR MORE RETRIES THAN ARE WORKED OVER, IS REFUSED, AND NOTHING IS BUILT', async () => {
    roles.set(toHex(legCharged()), takenOnChain(350n));
    const run = raised(THE_RETRY, fromHex(LEG.root), asRetry);
    /* RED WHEN: a leg whose leaves and amounts do not make its root is taken, so the retry is refused in the wrong words. */
    await expect(charge({ ...run, retry: { ...asRetry, leg: { ...asRetry.leg, amounts: ['400', '250', '351'] } } }))
      .rejects.toThrow(/the leg this retry pays again does not make the root its record names/);
    /* RED WHEN: the totals of any number of retries are worked over, which doubles the work with every one. */
    await expect(charge({ ...run, retry: { ...asRetry, others: Array.from({ length: 21 }, () => EARLIER[0]!) } }))
      .rejects.toThrow(/worked out over more than 20 retries of one leg/);
    expect(built).toBeNull();
  });

  it('A RETRY THE CHAIN HOLDS OPEN AND NEVER CLEARED IS NOT COUNTED: A SEAT\'S SPARE RETRIES CROWD OUT NONE THAT WERE', async () => {
    roles.set(toHex(legCharged()), takenOnChain(350n));
    /* The retry that took 350 was cleared; twenty-one more of the same people were raised and never approved. */
    const cleared = { ...EARLIER[1]!, proposal: 'e0'.repeat(32) };
    open.set(cleared.proposal, P.clearedMark());
    const spares = Array.from({ length: 21 }, (_, i) => ({ ...EARLIER[0]!, proposal: (i + 1).toString(16).padStart(2, '0').repeat(32) }));
    for (const s of spares) open.set(s.proposal, new Uint8Array(32).fill(7));
    /* RED WHEN: retries the chain never cleared are worked over - one seat's spare retries stop every free retry of the leg. */
    await charge(raised(THE_RETRY, fromHex(LEG.root), { ...asRetry, others: [cleared, ...spares] }));
    /* RED WHEN: the cleared retry's take is not the one found, so the leg's taken total is not the chain's. */
    expect(built!.record.legTaken).toBe(350n);
  });

  it('A RETRY THE CHAIN NO LONGER HOLDS OPEN IS STILL AMONG THE TOTALS TRIED: THIS DEVICE DOES NOT READ WHETHER IT WAS CLEARED BEFORE IT CLOSED', async () => {
    roles.set(toHex(legCharged()), takenOnChain(350n));
    const closed = { ...EARLIER[1]!, proposal: 'e1'.repeat(32) };
    /* RED WHEN: only retries the chain still holds as cleared are counted, so a leg whose cleared retry has since closed is charged whole again. */
    await charge(raised(THE_RETRY, fromHex(LEG.root), { ...asRetry, others: [closed] }));
    expect(built!.record.legTaken).toBe(350n);
  });
});
