/**
 * **AN APPROVED RUN IS CHARGED TO ITS VAULT'S PERIOD FROM A DEVICE, WITH THE
 * PERIOD'S TOTAL WORKED OUT AGAIN FROM THE COMPANY'S RUNS.**
 *
 * **WHAT IS A STAND-IN, SAID HERE:** where the vault stands under its policy
 * (`spendingPolicyHere`), the company's believed runs and signed state
 * (`believedRunsHere`, `signedStateHere`) and the account's state at one block
 * (`chainAtOneBlockHere`) are substituted as modules; the worker, the
 * service's route and the chain's answer to whether a run is charged are
 * objects recording what they were handed, the chain's answer lagging the
 * relay by as many reads as a test sets. Where a charge on its way is kept
 * is the device's own sealed store, in memory. The charge
 * built and the total worked out against the account's own state is
 * `contracts/test/a-spending-policy-is-set-from-a-device.test.ts`'s; the route
 * is `src/server/a-proposal-is-relayed-for-a-seat-that-may-act.test.ts`'s.
 *
 * Every assertion names the change that turns it red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PayrollRun } from '../../../src/core/types.js';
import { assetIdHex } from '../../../src/core/assets.js';
import { TEST_TOKEN, OTHER_TEST_TOKEN } from '../../../src/testing/assets.js';
import type { PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import type { Hex } from '../../../src/core/crypto.js';
import { vouchedFreshOf } from '../../../src/midnight/record-tree.js';

const T = assetIdHex(TEST_TOKEN).toLowerCase();
const VAULT = 'a1'.repeat(32);
const OTHER_VAULT = 'a2'.repeat(32);
const DAY = 86_400n;
/* Periods of ten days from day 100: period 0 is days 100 to 110, period 1 days 110 to 120. */
const START = 100n * DAY;
const POLICY = {
  terms: {
    bands: [{ ceiling: 1000n, approvals: 1n }, { ceiling: 2000n, approvals: 2n }, { ceiling: 3000n, approvals: 2n }, { ceiling: 4000n, approvals: 2n }],
    periodLimit: 5000n, periodStart: START, periodLength: 10n * DAY,
  },
  blinding: new Uint8Array(32).fill(3),
};
/* The same policy as the device's worker is handed it: written from POLICY, never beside it. */
const OPENING = {
  terms: {
    bands: POLICY.terms.bands.map((b) => ({ ceiling: String(b.ceiling), approvals: String(b.approvals) })),
    periodLimit: String(POLICY.terms.periodLimit), periodStart: String(POLICY.terms.periodStart), periodLength: String(POLICY.terms.periodLength),
  },
  blinding: Buffer.from(POLICY.blinding).toString('hex'),
};

let standing: { state: 'none' | 'not-for-this-currency' | 'set' } = { state: 'set' };
let runs: PayrollRun[] = [];
/* The identity on chain of every proposal the device believes, by the company's name for it. */
let onChain = new Map<string, string>();
vi.mock('./spending-policy-here.js', () => ({
  spendingPolicyHere: async () => (standing.state === 'set' ? { state: 'set', policy: POLICY, opening: OPENING, keys: {}, commitment: '', version: 1 } : standing),
}));
vi.mock('./run-rebuilt-here.js', () => ({
  believedRunsHere: async () => runs,
  believedProposalIdsOnChainHere: async () => onChain,
  signedStateHere: async () => ({ seeds: [], payKey: '', assetBlinding: 'b1'.repeat(32) }),
}));
vi.mock('./vault-operation.js', async (real) => ({
  ...(await real<typeof import('./vault-operation.js')>()),
  chainAtOneBlockHere: async () => ({ account: 'cc'.repeat(32), accountState: 'STATE', parameters: 'PARAMS', vaultState: '', zswapState: '', blockHash: '' }),
}));
const { chargeTheRunHere, periodTotalHere, runsInThePeriod, RunNotChargedHere, ChargeNotYetSeen } = await import('./run-charged-here.js');
const { sealedOnThisDevice, inFlightInMemory } = await import('./in-flight-on-this-device.js');
const { DEPOSIT_TIME_TO_LIVE_MS } = await import('./vault-operation.js');
type ChargeInFlight = import('./run-charged-here.js').ChargeInFlight;

const leaf = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const at = (day: bigint) => day * DAY;
/** A run of one leg in `asset` from `vault`, over `leaves` at `amounts`, in `[opens, closes)` days, with retries. */
const aRun = (id: string, o: {
  vault?: string; asset?: string; amounts: number[]; opens: bigint; closes: bigint; proposal?: string;
  retries?: Array<{ indices: number[]; vault?: string; opens: bigint; closes: bigint; root: string; proposal?: string }>;
}): PayrollRun => ({
  id, accountId: 'acc', proposalIds: o.proposal === undefined ? {} : { [`${o.asset ?? TEST_TOKEN}:shielded`]: o.proposal }, payout: {
    [`${o.asset ?? TEST_TOKEN}:shielded`]: {
      root: `${id}-root`, payees: BigInt(o.amounts.length), opensAt: at(o.opens), closesAt: at(o.closes), vault: o.vault ?? VAULT,
      leaves: o.amounts.map((_, i) => leaf(i + 1)), facts: o.amounts.map((a) => ({ amount: BigInt(a) })),
      retries: (o.retries ?? []).map((r) => ({
        originalIndices: r.indices, root: r.root, payees: BigInt(r.indices.length), opensAt: at(r.opens), closesAt: at(r.closes),
        vault: r.vault ?? VAULT, proposedBy: 's', at: '',
        ...(r.proposal === undefined ? {} : { proposalId: r.proposal }),
      })),
    },
  },
} as unknown as PayrollRun);

/** The run every charge below charges, as the company's records hold it: its leg raised as the proposal charged. */
const V1 = { head: '1a'.repeat(32) as Hex, r: 'f3'.repeat(32) as Hex };
/** The fresh half of its salt, made from what its proposal's filing seals: the head its raiser checked and a random value. */
const FRESH = vouchedFreshOf(V1.head, V1.r);
const theRun = () => aRun('r0', { amounts: [30, 40], opens: 103n, closes: 104n, proposal: 'prp_theRunAAAAAA' });

const anOrder = (opens: bigint, closes: bigint, required?: string): PrivatePaymentOrderOnTheWire => ({
  asset: T, form: 'shielded', symbol: 'T', vault: VAULT as never, proposal: '0f'.repeat(32) as never, salt: '5a'.repeat(32) as never,
  root: '9a'.repeat(32) as never, payees: '2', opensAt: String(at(opens)), closesAt: String(at(closes)), ...(required === undefined ? {} : { required }),
  payments: [{ leaf: leaf(7), amount: '30' }, { leaf: leaf(8), amount: '40' }] as never,
});

let asked: unknown[] = [];
let answer: { tx: string | null; spent: string | null } | Error = { tx: 'TX', spent: '700' };
const sent: Array<[string, unknown]> = [];
/* The chain as the wallet's indexer shows it: how many more reads before a relayed charge shows, and where each proposal stands. */
let lag = 0;
let chainHolds = new Map<string, 'charged' | 'open' | 'not-open'>();
let relayed: string | null = null;
let readsOfTheCharge: string[] = [];
let relayFails: Error | null = null;
let now = 1_000_000;
const me = { signerId: 'ada', wrappingSecret: '11'.repeat(32) as never };
let store = inFlightInMemory();
let kept = sealedOnThisDevice<ChargeInFlight>(store, me, 'charge');
const doors = (withCharge = true, withKept = true) => ({
  records: {} as never, accountId: 'acc', viewingKey: '00'.repeat(32) as never, account: 'cc'.repeat(32) as never, indexer: async () => null,
  builder: {
    clearRun: async (i: unknown) => { asked.push(i); if (answer instanceof Error) throw answer; return answer; },
    periodTotal: async (i: unknown) => { asked.push(i); return '1234'; },
    runCharged: async (i: { accountState: string; proposal: string }) => {
      readsOfTheCharge.push(i.proposal);
      if (relayed === i.proposal && lag-- <= 0) return 'charged';
      return chainHolds.get(i.proposal) ?? 'open';
    },
  } as never,
  ...(withCharge ? {
    charge: async (id: string, body: { tx: string }) => {
      if (relayFails !== null) throw relayFails;
      sent.push([id, body]); relayed = '0f'.repeat(32);
    },
  } : {}),
  ...(withKept ? { chargesInFlight: kept } : {}),
  waitMs: 50, everyMs: 10, sleep: async () => undefined, now: () => new Date(now),
});

beforeEach(() => {
  standing = { state: 'set' }; runs = [theRun()]; onChain = new Map(); asked = []; sent.length = 0; answer = { tx: 'TX', spent: '700' };
  lag = 0; chainHolds = new Map(); relayed = null; readsOfTheCharge = []; relayFails = null; now = 1_000_000;
  store = inFlightInMemory(); kept = sealedOnThisDevice<ChargeInFlight>(store, me, 'charge');
});

describe('THE RUNS A PERIOD\'S TOTAL IS WORKED OUT FROM', () => {
  it('EVERY LEG AND RETRY OF THIS VAULT AND CURRENCY WHOSE WINDOW LIES IN THE PERIOD, EACH WITH ITS OWN LEAVES AND AMOUNTS, WHATEVER BECAME OF IT', () => {
    const found = runsInThePeriod([
      aRun('r1', { amounts: [10, 20, 30], opens: 101n, closes: 102n, retries: [
        { indices: [2, 0], opens: 103n, closes: 104n, root: 'retry-in' },
        { indices: [1], vault: OTHER_VAULT, opens: 103n, closes: 104n, root: 'retry-other-vault' },
        { indices: [1], opens: 109n, closes: 111n, root: 'retry-crossing' },
      ] }),
      aRun('r2', { amounts: [5], opens: 111n, closes: 112n, retries: [{ indices: [0], opens: 105n, closes: 106n, root: 'retry-of-a-later-leg' }] }),
      aRun('r3', { amounts: [7], opens: 101n, closes: 102n, vault: OTHER_VAULT }),
      aRun('r4', { amounts: [9], opens: 101n, closes: 102n, asset: OTHER_TEST_TOKEN }),
    ], { vault: VAULT, asset: T, from: at(100n), until: at(110n) });
    /* RED WHEN: another vault's or currency's run is summed, a window outside the period is, or one inside is left out. */
    expect(found.map((r) => r.root)).toEqual(['r1-root', 'retry-in', 'retry-of-a-later-leg']);
    /* RED WHEN: a retry is summed over the whole leg, or over its people out of the order its own tree has them. */
    expect(found[1]).toEqual({ root: 'retry-in', leaves: [leaf(3), leaf(1)], amounts: ['30', '10'] });
    expect(found[0]).toEqual({ root: 'r1-root', leaves: [leaf(1), leaf(2), leaf(3)], amounts: ['10', '20', '30'] });
  });

  it('A WINDOW EXACTLY THE PERIOD IS IN IT, ONE A SECOND WIDER EITHER SIDE IS NOT, AND A RETRY NAMING NOBODY ON ITS LEG IS PASSED OVER', () => {
    const exact = aRun('edge', { amounts: [1], opens: 100n, closes: 110n });
    const early = { ...exact, payout: { [`${TEST_TOKEN}:shielded`]: { ...Object.values(exact.payout!)[0]!, root: 'early', opensAt: at(100n) - 1n } } } as unknown as PayrollRun;
    const late = { ...exact, payout: { [`${TEST_TOKEN}:shielded`]: { ...Object.values(exact.payout!)[0]!, root: 'late', closesAt: at(110n) + 1n } } } as unknown as PayrollRun;
    const stray = aRun('stray', { amounts: [1], opens: 120n, closes: 121n, retries: [{ indices: [0, 9], opens: 101n, closes: 102n, root: 'nobody-at-9' }] });
    /* RED WHEN: a run whose window is the whole period is left out - its charge then never opens the period's total, and nothing more is paid. */
    /* RED WHEN: a window reaching outside the period by one second is summed, or a retry naming a position its leg has not is sent to the worker. */
    expect(runsInThePeriod([exact, early, late, stray], { vault: VAULT, asset: T, from: at(100n), until: at(110n) }).map((r) => r.root))
      .toEqual(['edge-root']);
  });
});

describe('CHARGING AN APPROVED RUN BEFORE IT IS PAID', () => {
  it('BUILDS THE CHARGE OF EXACTLY THE RUN THE DEVICE OPENED, AGAINST THE RUNS OF ITS PERIOD AND ONE BLOCK\'S STATE, AND RELAYS IT AS ITS PROPOSAL', async () => {
    runs = [aRun('r1', { amounts: [100], opens: 101n, closes: 102n }), aRun('r9', { amounts: [100], opens: 111n, closes: 112n }), theRun()];
    const r = await chargeTheRunHere(doors(), { order: anOrder(103n, 104n, '2'), proposalId: 'prp_theRunAAAAAA', vouched: V1 });
    /* RED WHEN: what is charged is not the leg as the paying device opened it - its identity, salt, window, the approvals its order carries, or tree. */
    expect(asked).toEqual([{
      account: 'cc'.repeat(32),
      run: {
        proposal: '0f'.repeat(32), vault: VAULT, salt: '5a'.repeat(32), required: '2', opensAt: String(at(103n)), closesAt: String(at(104n)),
        asset: T, assetBlinding: 'b1'.repeat(32), policy: OPENING, root: '9a'.repeat(32), leaves: [leaf(7), leaf(8)], amounts: ['30', '40'],
        /* RED WHEN: the fresh half of the run's salt is not the one its proposal's filing seals. */
        fresh: FRESH,
      },
      /* RED WHEN: the total is summed over runs outside the run's own period. */
      runs: [{ root: 'r1-root', leaves: [leaf(1)], amounts: ['100'] }, { root: 'r0-root', leaves: [leaf(1), leaf(2)], amounts: ['30', '40'] }],
      /* RED WHEN: the charge is built on any state but the one block the device read at the wallet's indexer. */
      chain: { accountState: 'STATE', parameters: 'PARAMS' },
    }]);
    /* RED WHEN: the proven charge is not relayed, or relayed as another proposal. */
    expect(sent).toEqual([['prp_theRunAAAAAA', { tx: 'TX' }]]);
    expect(r).toEqual({ state: 'charged', spentBefore: 700n });
    /* RED WHEN: the run is answered charged without the chain the wallet reads being asked about its own proposal. */
    /* Asked once before the charge is built, whether the chain already holds it charged, and once after it is relayed. */
    expect(readsOfTheCharge).toEqual(['0f'.repeat(32), '0f'.repeat(32)]);
    /* RED WHEN: a charge the chain shows is still kept as on its way, so the next charge from the vault waits on it. */
    expect(store.kept.size).toBe(0);
  });

  it('A VAULT WITH NO POLICY IS PAID AS IT ALWAYS WAS: NOTHING IS BUILT OR SENT', async () => {
    standing = { state: 'none' };
    /* RED WHEN: a run from a vault with no policy is charged - the chain refuses it, after a fee. */
    expect(await chargeTheRunHere(doors(), { order: anOrder(103n, 104n), proposalId: 'prp_theRunAAAAAA', vouched: V1 })).toEqual({ state: 'no-policy' });
    expect([asked, sent]).toEqual([[], []]);
  });

  it('A RUN THE CHAIN ALREADY HOLDS AS CHARGED IS NOT CHARGED AGAIN', async () => {
    answer = { tx: null, spent: null };
    /* RED WHEN: a run already charged is relayed again. */
    expect(await chargeTheRunHere(doors(), { order: anOrder(103n, 104n), proposalId: 'prp_theRunAAAAAA', vouched: V1 })).toEqual({ state: 'already-charged' });
    expect(sent).toEqual([]);
  });

  it('REFUSES, SENDING NOTHING: A POLICY FOR ANOTHER CURRENCY ONLY, A PAGE THAT CANNOT RELAY A CHARGE, OR A CHARGE THE WORKER REFUSED', async () => {
    standing = { state: 'not-for-this-currency' };
    /* RED WHEN: a run the chain will never charge is let through to be paid. */
    await expect(chargeTheRunHere(doors(), { order: anOrder(103n, 104n), proposalId: 'prp_theRunAAAAAA', vouched: V1 })).rejects.toThrow(/none for the currency it pays in/u);
    standing = { state: 'set' };
    /* RED WHEN: a policy vault's run goes on to be paid uncharged because the page has no route for the charge. */
    await expect(chargeTheRunHere(doors(false), { order: anOrder(103n, 104n), proposalId: 'prp_theRunAAAAAA', vouched: V1 })).rejects.toThrow(RunNotChargedHere);
    /* RED WHEN: a charge is built on a page with nowhere to keep it while it lands, so paying again could charge twice. */
    await expect(chargeTheRunHere(doors(true, false), { order: anOrder(103n, 104n), proposalId: 'prp_theRunAAAAAA', vouched: V1 })).rejects.toThrow(RunNotChargedHere);
    expect(asked).toEqual([]);
    answer = new Error('the company\'s records do not account for everything the chain has charged. Nothing was proved or sent.');
    /* RED WHEN: a refused charge is relayed anyway, or its words are lost. */
    await expect(chargeTheRunHere(doors(), { order: anOrder(103n, 104n), proposalId: 'prp_theRunAAAAAA', vouched: V1 }))
      .rejects.toThrow(/^the company's records do not account for everything the chain has charged\. Nothing was sent\.$/u);
    expect(sent).toEqual([]);
  });
});

describe('A RUN IS CHARGED AS WHAT ITS PROPOSAL WAS RAISED AS, READ FROM THE COMPANY\'S RUNS THIS DEVICE BELIEVES', () => {
  const V2 = { head: '1a'.repeat(32) as Hex, r: 'f4'.repeat(32) as Hex };
  const F2 = vouchedFreshOf(V2.head, V2.r);
  const leg = () => aRun('l1', { amounts: [10, 20, 30], opens: 101n, closes: 102n, proposal: 'prp_theLegAAAAAA', retries: [
    { indices: [1], opens: 103n, closes: 104n, root: 'the-retry', proposal: 'prp_theRetryAAAA' },
    { indices: [2, 0], opens: 105n, closes: 106n, root: 'an-earlier-retry', proposal: 'prp_earlierAAAAA' },
    { indices: [0], vault: OTHER_VAULT, opens: 103n, closes: 104n, root: 'another-vault' },
    { indices: [0], opens: 111n, closes: 112n, root: 'a-later-period' },
  ] });

  it('A RETRY NAMES ITS FRESH SALT, ITS LEG, AND THE LEG\'S OTHER RETRIES IN ITS VAULT AND PERIOD, EACH OVER ITS OWN PEOPLE', async () => {
    runs = [leg()];
    await chargeTheRunHere(doors(), { order: anOrder(103n, 104n), proposalId: 'prp_theRetryAAAA', vouched: V2 });
    const charged = (asked[0] as { run: { fresh: string; retry: unknown } }).run;
    /* RED WHEN: a retry is charged with another fresh half than the one its proposal's filing seals. */
    expect(charged.fresh).toBe(F2);
    /* RED WHEN: a retry is charged without its leg, or with the leg's retries from another vault or period, or itself among them. */
    expect(charged.retry).toEqual({
      leg: { root: 'l1-root', leaves: [leaf(1), leaf(2), leaf(3)], amounts: ['10', '20', '30'] },
      others: [{ root: 'an-earlier-retry', leaves: [leaf(3), leaf(1)], amounts: ['30', '10'], proposal: null }],
    });
  });

  it('EACH OF THE LEG\'S OTHER RETRIES NAMES ITS PROPOSAL ON CHAIN WHEN THE DEVICE BELIEVES THE PROPOSAL, SO ONE NEVER CLEARED CAN BE LEFT OUT', async () => {
    runs = [leg()];
    onChain = new Map([['prp_earlierAAAAA', 'e0'.repeat(32)]]);
    await chargeTheRunHere(doors(), { order: anOrder(103n, 104n), proposalId: 'prp_theRetryAAAA', vouched: V2 });
    const charged = (asked[0] as { run: { retry: { others: Array<{ root: string; proposal: string | null }> } } }).run;
    /* RED WHEN: an earlier retry the device believes is charged naming no proposal, so a retry the chain never cleared counts as taken. */
    expect(charged.retry.others.map((o) => [o.root, o.proposal])).toEqual([['an-earlier-retry', 'e0'.repeat(32)]]);
  });

  it('A RETRY WHOSE PROPOSAL THE DEVICE DOES NOT BELIEVE IS CHARGED NAMING NO PROPOSAL, SO IT CANNOT PASS FOR ONE THE CHAIN HOLDS OPEN', async () => {
    runs = [leg()];
    await chargeTheRunHere(doors(), { order: anOrder(103n, 104n), proposalId: 'prp_theRetryAAAA', vouched: V2 });
    /* RED WHEN: a retry whose proposal the device does not believe is named by a proposal anyway - the service's word for which one it was. */
    expect((asked[0] as { run: { retry: { others: Array<{ proposal: string | null }> } } }).run.retry.others.map((o) => o.proposal)).toEqual([null]);
  });

  it('A LEG NAMES ITS OWN FRESH SALT AND NO LEG', async () => {
    runs = [leg()];
    await chargeTheRunHere(doors(), { order: anOrder(101n, 102n), proposalId: 'prp_theLegAAAAAA', vouched: V1 });
    const charged = (asked[0] as { run: { fresh: string; retry?: unknown } }).run;
    /* RED WHEN: a leg is charged as a retry, or with another fresh half than its proposal's. */
    expect([charged.fresh, charged.retry]).toEqual([FRESH, undefined]);
  });

  it('A RUN NO BELIEVED RUN RAISED, OR WHOSE PROPOSAL DOES NOT SAY HOW ITS SALT WAS MADE, IS NOT CHARGED, AND NOTHING IS BUILT OR SENT', async () => {
    runs = [leg()];
    /* RED WHEN: a proposal no run this device believes raised is charged on what the service says it is. */
    await expect(chargeTheRunHere(doors(), { order: anOrder(103n, 104n), proposalId: 'prp_unknownAAAAA', vouched: V1 })).rejects.toThrow(/no payroll run of this company that this device believes raised this proposal/u);
    /* RED WHEN: a run whose proposal seals nothing its salt is made from, or a value not thirty-two bytes, is sent to be charged, which the chain refuses after a fee. */
    await expect(chargeTheRunHere(doors(), { order: anOrder(101n, 102n), proposalId: 'prp_theLegAAAAAA' })).rejects.toThrow(/does not say how its salt was made/u);
    await expect(chargeTheRunHere(doors(), { order: anOrder(101n, 102n), proposalId: 'prp_theLegAAAAAA', vouched: { head: V1.head, r: 'f3' as Hex } })).rejects.toThrow(/does not say how its salt was made/u);
    expect([asked, sent]).toEqual([[], []]);
  });

  it('A RUN THE CHAIN ALREADY HOLDS AS CHARGED IS ANSWERED SO FIRST: NEITHER ITS FRESH HALF NOR ITS RUN IS NEEDED TO PAY IT', async () => {
    runs = [];
    chainHolds.set('0f'.repeat(32), 'charged');
    /* RED WHEN: a run already charged is refused for want of what only charging it needs - its people are then never paid. */
    expect(await chargeTheRunHere(doors(), { order: anOrder(103n, 104n), proposalId: 'prp_theRunAAAAAA' })).toEqual({ state: 'already-charged' });
    expect([asked, sent]).toEqual([[], []]);
  });

  it('A RETRY WHOSE LEG IS IN ANOTHER CURRENCY IS NOT CHARGED AGAINST IT', async () => {
    runs = [aRun('l2', { asset: OTHER_TEST_TOKEN, amounts: [10], opens: 101n, closes: 102n, retries: [
      { indices: [0], opens: 103n, closes: 104n, root: 'cross', proposal: 'prp_crossAAAAAAA' },
    ] })];
    /* RED WHEN: a retry is charged against a leg paying in another currency. */
    await expect(chargeTheRunHere(doors(), { order: anOrder(103n, 104n), proposalId: 'prp_crossAAAAAAA', vouched: V2 })).rejects.toThrow(/in another currency than the retry/u);
    expect(asked).toEqual([]);
  });
});

describe('A CHARGE IS SEEN TO LAND BEFORE THE RUN IS PAID, AND PAYING AGAIN ON A STALE READ NEVER CHARGES TWICE', () => {
  const run = { order: anOrder(103n, 104n, '2'), proposalId: 'prp_theRunAAAAAA', vouched: V1 };

  it('WAITS AFTER THE RELAY UNTIL THE CHAIN THE WALLET READS HOLDS THE RUN AS CHARGED, AND ONLY THEN ANSWERS CHARGED', async () => {
    lag = 3;
    /* RED WHEN: the run is answered charged - and its first payment built - while the wallet's indexer does not show the charge. */
    expect(await chargeTheRunHere(doors(), run)).toEqual({ state: 'charged', spentBefore: 700n });
    expect(readsOfTheCharge).toHaveLength(5);
    expect(store.kept.size).toBe(0);
  });

  it('A CHARGE THE INDEXER STILL DOES NOT SHOW STOPS THE LEG; PAYING AGAIN ON THE SAME STALE READ WAITS FOR IT AND SENDS NO SECOND CHARGE', async () => {
    lag = 100;
    await expect(chargeTheRunHere(doors(), run)).rejects.toThrow(ChargeNotYetSeen);
    expect(sent).toHaveLength(1);
    /* RED WHEN: the charge on its way is not kept on this device until it is seen. */
    expect(store.kept.size).toBe(1);
    /* Paying again: the indexer still lags, so the worker, reading the same stale state, would build the charge again. */
    asked = [];
    await expect(chargeTheRunHere(doors(), run)).rejects.toThrow(/does not show it yet/u);
    /* RED WHEN: paying again on a read that does not show the first charge builds or relays a second one. */
    expect(asked).toEqual([]);
    expect(sent).toHaveLength(1);
    /* The indexer catches up: the earlier charge is settled and forgotten, and the chain now holds the run as charged. */
    lag = 0; answer = { tx: null, spent: null };
    expect(await chargeTheRunHere(doors(), run)).toEqual({ state: 'already-charged' });
    expect(sent).toHaveLength(1);
    expect(store.kept.size).toBe(0);
  });

  it('AN EARLIER CHARGE OF ANOTHER RUN FROM THE SAME VAULT IS WAITED FOR BEFORE THIS RUN IS CHARGED AGAINST THE PERIOD', async () => {
    await kept.claim(VAULT as never, { proposal: '0e'.repeat(32), recordedAt: now });
    /* RED WHEN: a run is charged on a period total read while another charge from the vault may still land. */
    await expect(chargeTheRunHere(doors(), run)).rejects.toThrow(ChargeNotYetSeen);
    expect([asked, sent]).toEqual([[], []]);
    /* Once the chain shows the earlier one, this run is charged. */
    chainHolds.set('0e'.repeat(32), 'charged');
    expect(await chargeTheRunHere(doors(), run)).toEqual({ state: 'charged', spentBefore: 700n });
    expect(sent).toHaveLength(1);
  });

  it('A KEPT CHARGE PAST THE TIME A CALL CAN LAND IS FORGOTTEN, AND THE RUN IS CHARGED', async () => {
    await kept.claim(VAULT as never, { proposal: '0e'.repeat(32), recordedAt: now });
    now += DEPOSIT_TIME_TO_LIVE_MS + 1;
    /* RED WHEN: a charge that can no longer land keeps every run from the vault from being charged and paid for good. */
    expect(await chargeTheRunHere(doors(), run)).toEqual({ state: 'charged', spentBefore: 700n });
    /* Asked once before the charge is built, whether the chain already holds it charged, and once after it is relayed. */
    expect(readsOfTheCharge).toEqual(['0f'.repeat(32), '0f'.repeat(32)]);
  });

  it('A CHARGE ANOTHER TAB OF THIS BROWSER IS SENDING FROM THE VAULT STOPS THIS ONE BEFORE IT IS RELAYED', async () => {
    /* The slot is empty when this device looks, and another tab claims it before this one can. */
    const taken = { ...kept, claim: async () => null };
    await expect(chargeTheRunHere({ ...doors(), chargesInFlight: taken }, run)).rejects.toThrow(/another charge from this vault is being sent from this browser/u);
    /* RED WHEN: a charge is relayed without its record kept - a second tab charges on the same period total, refused after a fee. */
    expect(sent).toEqual([]);
  });

  it('A RELAY THAT SENT NOTHING IS FORGOTTEN AT ONCE; ONE THAT MAY HAVE SENT IS KEPT AND WAITED FOR', async () => {
    relayFails = Object.assign(new Error('refused. Nothing was sent.'), { nothingWasSent: true });
    await expect(chargeTheRunHere(doors(), run)).rejects.toThrow(/Nothing was sent/u);
    /* RED WHEN: a relay the service says sent nothing is kept, and every later charge from the vault waits on it. */
    expect(store.kept.size).toBe(0);
    relayFails = new Error('the connection was lost');
    await expect(chargeTheRunHere(doors(), run)).rejects.toThrow(/connection was lost/u);
    /* RED WHEN: a relay that may have reached the chain is forgotten, so paying again could charge the run twice. */
    expect(store.kept.size).toBe(1);
  });

  it('A RUN WHOSE PROPOSAL THE CHAIN NO LONGER HOLDS OPEN AFTER THE CHARGE IS NOT ANSWERED CHARGED', async () => {
    chainHolds.set('0f'.repeat(32), 'not-open'); lag = 100;
    /* RED WHEN: a run the chain no longer holds open is reported charged and goes on to be paid. */
    await expect(chargeTheRunHere(doors(), run)).rejects.toThrow(/no longer holds this run's proposal open[\s\S]*Nothing was paid\.$/u);
    expect(store.kept.size).toBe(0);
  });
});

describe('WHAT A PERIOD HAS BEEN CHARGED, ON ANY SIGNER\'S DEVICE', () => {
  it('IS WORKED OUT BY THE WORKER FROM ONE BLOCK\'S STATE AND THE RUNS OF THAT PERIOD, AND REFUSED FOR A VAULT WITH NO POLICY', async () => {
    runs = [aRun('r1', { amounts: [100], opens: 101n, closes: 102n }), aRun('r9', { amounts: [100], opens: 111n, closes: 112n })];
    /* RED WHEN: the total is taken from anything but the worker's working out, or over another period's runs. */
    expect(await periodTotalHere(doors(), { vault: VAULT, asset: T, period: 1n })).toBe(1234n);
    expect(asked).toEqual([{ accountState: 'STATE', total: {
      vault: VAULT, asset: T, assetBlinding: 'b1'.repeat(32), policy: OPENING, period: '1', runs: [{ root: 'r9-root', leaves: [leaf(1)], amounts: ['100'] }],
    } }]);
    standing = { state: 'none' };
    await expect(periodTotalHere(doors(), { vault: VAULT, asset: T, period: 1n })).rejects.toThrow(/no spending policy/u);
  });
});
