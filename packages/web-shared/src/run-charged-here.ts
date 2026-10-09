/**
 * **AN APPROVED RUN CHARGED TO ITS VAULT'S PERIOD FROM A SIGNER'S DEVICE, AND
 * WHAT A PERIOD HAS BEEN CHARGED, WORKED OUT AGAIN ON ANY SIGNER'S DEVICE.**
 *
 * A vault under a spending policy pays a run only once it is charged to the
 * period its window lies in. The device that pays the run charges it first,
 * as the first thing paying it does (`payAnApprovedLeg`); a run from a vault
 * with no policy is paid as it always was, and a run the chain already holds
 * as charged is not charged again.
 *
 * **WHAT IS READ, AND FROM WHERE.** The vault's policy, through the one way a
 * policy is read on a device (`spendingPolicyHere`): the chain through the
 * person's own wallet, the opening from the company's records. The account's
 * state at one block, at the indexer the person's own wallet names - the state
 * the charge is built on and the period's total is worked out from. The
 * company's runs, each filed by a seat this device believes: every leg and
 * retry of this vault and currency whose window lies in the period, whatever
 * its proposal's status now, since the chain counts every root it marked
 * charged. No total is kept anywhere: each charge works it out again.
 *
 * **A CHARGE IS SEEN TO LAND BEFORE THE RUN IS PAID.** After relaying a
 * charge the device asks the chain, at the indexer the person's own wallet
 * names, until it holds the run as charged; nothing is paid before then. The
 * charge is kept on this device, sealed, from just before it is relayed until
 * the chain shows it or it can no longer land, so paying again while the
 * wallet's indexer lags waits for it rather than charging the run, or another
 * run of the vault, on a read that does not show it yet.
 */
import { assetIdHex, type AssetId } from '../../../src/core/assets.js';
import type { Hex } from '../../../src/core/crypto.js';
import { assetOfLeg } from '../../../src/core/run-legs.js';
import type { PayrollRun } from '../../../src/core/types.js';
import { periodOf, periodWindowOf } from '../../../src/midnight/spending-policy-record.js';
import type { PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import type { RunTreeOnTheWire } from './run-charge-builder.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import { believedRunsHere, signedStateHere, type CompanyRecordsHere } from './run-rebuilt-here.js';
import { spendingPolicyHere } from './spending-policy-here.js';
import type { KeptOnThisDevice } from './in-flight-on-this-device.js';
import {
  chainAtOneBlockHere, DEPOSIT_TIME_TO_LIVE_MS, until, type BuiltOnHereDoors, type Pacing,
} from './vault-operation.js';

/** Why this device did not charge a run to its period, or could not say what a period has been charged. Nothing was sent. */
export class RunNotChargedHere extends Error {
  constructor(why: string, options?: { cause?: unknown }) {
    super(`${why.replace(/\s*Nothing was (proved|built) or sent\.\s*$/u, '').replace(/\.?\s*$/u, '.')} Nothing was sent.`, options);
    this.name = 'RunNotChargedHere';
  }
}

/** What reading a vault's policy and the company's runs needs of this device. */
interface RecordsHereDoors {
  readonly records: CompanyRecordsHere;
  readonly accountId: string;
  readonly viewingKey: Hex;
}

/**
 * **A CHARGE THIS DEVICE HAS RELAYED AND NOT YET SEEN LAND**: the identity on
 * the chain of the run's proposal, and when it was kept, in milliseconds, just
 * before the relay. It holds no total and names no coin.
 */
export interface ChargeInFlight {
  readonly proposal: string;
  readonly recordedAt: number;
}

/** One charge in flight per vault on this device, changed or forgotten only under the claim it was kept with. */
export type ChargesInFlight = KeptOnThisDevice<ChargeInFlight>;

/** What charging a run, and working out a period's total, needs of this device beyond the records. */
export interface ChargeDoors extends BuiltOnHereDoors, Pacing {
  readonly builder: BuiltOnHereDoors['builder'] & Pick<VaultBuilderClient, 'clearRun' | 'periodTotal' | 'runCharged'>;
  /**
   * The company's service's route a proven charge is relayed by: it sends the
   * call and takes the run's proposal, still open on the chain, as charged.
   */
  readonly charge?: (proposalId: string, body: { tx: string }) => Promise<unknown>;
  /** Where this device keeps a charge it relayed until the chain shows it. A vault under a policy pays nothing without it. */
  readonly chargesInFlight?: ChargesInFlight;
  readonly now?: () => Date;
}

/** **THE CHARGE WAS RELAYED, OR MAY HAVE BEEN, AND THE CHAIN THE WALLET READS DOES NOT SHOW IT YET.** Nothing was paid. */
export class ChargeNotYetSeen extends Error {
  constructor(readonly vault: string, why: string) {
    super(`${why} Nothing was paid. Try again in a minute: paying again waits for this charge, and does not charge the `
      + 'run again while it can still land.');
    this.name = 'ChargeNotYetSeen';
  }
}

const sentNothing = (e: unknown): boolean => (e as { nothingWasSent?: unknown })?.nothingWasSent === true;

/** Where the chain the person's own wallet reads holds a run's proposal now, at one block. */
async function standingHere(doors: ChargeDoors, vault: Hex, proposal: string) {
  const chain = await chainAtOneBlockHere(doors, vault);
  return doors.builder.runCharged({ accountState: chain.accountState, proposal });
}

/**
 * **A CHARGE THIS DEVICE RELAYED EARLIER FROM THIS VAULT, SETTLED FIRST.**
 * Forgotten once the chain no longer holds its run's proposal open and not
 * charged, or once it can no longer land; otherwise waited for, and while it
 * still does not show, nothing is built or sent.
 */
async function earlierChargeSettled(doors: ChargeDoors, kept: ChargesInFlight, vault: Hex): Promise<void> {
  const earlier = await kept.get(vault);
  if (earlier === null) return;
  const now = (doors.now?.() ?? new Date()).getTime();
  const landed = now > earlier.recordedAt + DEPOSIT_TIME_TO_LIVE_MS
    || (await until(doors, async () => ((await standingHere(doors, vault, earlier.proposal)) === 'open' ? null : true))) !== null;
  if (!landed) {
    throw new ChargeNotYetSeen(vault, 'a charge of a run from this vault was sent from this device and the chain your wallet '
      + 'reads does not show it yet, so no run from this vault is charged or paid from here until it does.');
  }
  await kept.forget(vault, earlier.claim);
}

/**
 * **THE COMPANY'S RUNS THAT MAY HAVE BEEN CHARGED TO ONE PERIOD OF A VAULT'S
 * POLICY FOR ONE CURRENCY**: every leg and retry of every run this device
 * believes, from this vault, in this currency, whose window lies in the
 * period - each with its root and its tree's leaves and amounts, from which
 * the worker makes its total again, whatever its proposal's status now.
 */
export function runsInThePeriod(
  runs: readonly PayrollRun[], input: { readonly vault: string; readonly asset: string; readonly from: bigint; readonly until: bigint },
): RunTreeOnTheWire[] {
  const vault = input.vault.toLowerCase();
  const asset = input.asset.toLowerCase();
  const inside = (w: { opensAt: bigint; closesAt: bigint }) => w.opensAt >= input.from && w.closesAt <= input.until;
  const found: RunTreeOnTheWire[] = [];
  for (const run of runs) {
    for (const [leg, payout] of Object.entries(run.payout ?? {})) {
      if (payout === undefined || assetIdHex(assetOfLeg(leg as never)).toLowerCase() !== asset) continue;
      const amounts = payout.facts.map((f) => f.amount.toString());
      if (payout.vault.toLowerCase() === vault && inside(payout)) {
        found.push({ root: payout.root, leaves: [...payout.leaves], amounts });
      }
      for (const r of payout.retries ?? []) {
        if (r.vault.toLowerCase() !== vault || !inside(r)) continue;
        if (r.originalIndices.some((i) => payout.leaves[i] === undefined || amounts[i] === undefined)) continue;
        found.push({ root: r.root, leaves: r.originalIndices.map((i) => payout.leaves[i]!), amounts: r.originalIndices.map((i) => amounts[i]!) });
      }
    }
  }
  return found;
}

/** The vault's policy for the currency, opened here, refused unless the vault has one for it. */
async function policySetHere(doors: RecordsHereDoors, vault: string, asset: string) {
  const standing = await spendingPolicyHere(doors, { vault, asset: asset as AssetId });
  if (standing.state === 'none') return null;
  if (standing.state === 'not-for-this-currency') {
    throw new RunNotChargedHere('the vault this run is paid from has a spending policy, but none for the currency it pays in, so '
      + 'the chain will not charge it and the vault will not pay it. Set a policy for this currency first');
  }
  return standing;
}

/**
 * **WHAT A VAULT HAS BEEN CHARGED IN ONE PERIOD UNDER ITS POLICY FOR ONE
 * CURRENCY**, worked out again on this device - which need never have charged
 * anything - from the account's state at one block and the company's runs, and
 * taken only when it opens the commitment the chain holds for the period.
 */
export async function periodTotalHere(
  doors: RecordsHereDoors & ChargeDoors, input: { readonly vault: string; readonly asset: string; readonly period: bigint },
): Promise<bigint> {
  const vault = input.vault.toLowerCase() as Hex;
  const asset = input.asset.toLowerCase();
  const standing = await policySetHere(doors, vault, asset);
  if (standing === null) throw new RunNotChargedHere('this vault has no spending policy, so nothing is charged to its periods');
  const window = periodWindowOf(standing.policy, input.period);
  const [runs, state, chain] = await Promise.all([
    believedRunsHere(doors.records, doors.accountId, doors.viewingKey),
    signedStateHere(doors.records, doors.accountId, doors.viewingKey),
    chainAtOneBlockHere(doors, vault),
  ]);
  try {
    return BigInt(await doors.builder.periodTotal({
      accountState: chain.accountState,
      total: {
        vault, asset, assetBlinding: state.assetBlinding, policy: standing.opening, period: input.period.toString(),
        runs: runsInThePeriod(runs, { vault, asset, ...window }),
      },
    }));
  } catch (e) {
    throw new RunNotChargedHere(String((e as Error)?.message ?? e), { cause: e });
  }
}

/** What charging an approved run did: no policy to charge it to, already charged, or charged now. */
type RunCharged =
  | { readonly state: 'no-policy' }
  | { readonly state: 'already-charged' }
  | { readonly state: 'charged'; readonly spentBefore: bigint };

/**
 * **AN APPROVED RUN CHARGED TO ITS VAULT'S PERIOD FROM THIS DEVICE**, before
 * it is paid: `order` is what the vault is handed for it, with the approvals
 * its proposal was raised needing, as this device opened them
 * (`legToPayHere`). A vault with no policy charges nothing; a run the chain
 * holds as charged is not charged again; otherwise the charge is built and
 * proved here against the period's total worked out again from one block's
 * state, and relayed. It answers `charged` only once the chain the person's
 * own wallet reads holds the run as charged. A charge this device relayed
 * earlier from the same vault and has not seen land is waited for first, and
 * while it does not show nothing is built or sent.
 */
export async function chargeTheRunHere(
  doors: RecordsHereDoors & ChargeDoors,
  run: { readonly order: PrivatePaymentOrderOnTheWire; readonly proposalId: string },
): Promise<RunCharged> {
  const { order } = run;
  const vault = order.vault.toLowerCase() as Hex;
  const asset = order.asset.toLowerCase();
  const standing = await policySetHere(doors, vault, asset);
  if (standing === null) return { state: 'no-policy' };
  const kept = doors.chargesInFlight;
  if (doors.charge === undefined || kept === undefined) {
    throw new RunNotChargedHere('this page cannot charge a run to its vault\'s period, and a vault under a spending policy pays '
      + 'only a run that is charged. Reload the page to get the current version');
  }
  await earlierChargeSettled(doors, kept, vault);
  const opensAt = BigInt(order.opensAt);
  const closesAt = BigInt(order.closesAt);
  const [runs, state, chain] = await Promise.all([
    believedRunsHere(doors.records, doors.accountId, doors.viewingKey),
    signedStateHere(doors.records, doors.accountId, doors.viewingKey),
    chainAtOneBlockHere(doors, vault),
  ]);
  /* The runs that may share the run's period; a run in no single period is refused by the worker, with nothing summed. */
  const period = periodOf(standing.policy, { opensAt, closesAt });
  const window = period === null ? null : periodWindowOf(standing.policy, period);
  let built: { tx: string | null; spent: string | null };
  try {
    built = await doors.builder.clearRun({
      account: chain.account,
      run: {
        proposal: order.proposal, vault, salt: order.salt, required: order.required ?? '0',
        opensAt: opensAt.toString(), closesAt: closesAt.toString(), asset, assetBlinding: state.assetBlinding,
        policy: standing.opening, root: order.root,
        leaves: order.payments.map((p) => p.leaf), amounts: order.payments.map((p) => p.amount),
      },
      runs: window === null ? [] : runsInThePeriod(runs, { vault, asset, ...window }),
      chain: { accountState: chain.accountState, parameters: chain.parameters },
    });
  } catch (e) {
    throw new RunNotChargedHere(String((e as Error)?.message ?? e), { cause: e });
  }
  if (built.tx === null) return { state: 'already-charged' };
  const proposal = String(order.proposal).toLowerCase();
  const claim = await kept.claim(vault, { proposal, recordedAt: (doors.now?.() ?? new Date()).getTime() });
  if (claim === null) {
    throw new RunNotChargedHere('another charge from this vault is being sent from this browser. Try again in a minute');
  }
  try {
    await doors.charge(run.proposalId, { tx: built.tx });
  } catch (e) {
    if (sentNothing(e)) await kept.forget(vault, claim);
    throw e;
  }
  /* ---- the run is paid only once the chain the wallet reads holds it as charged ---- */
  const seen = await until(doors, async () => {
    const where = await standingHere(doors, vault, proposal);
    return where === 'open' ? null : where;
  });
  if (seen === null) {
    throw new ChargeNotYetSeen(vault, 'the charge of this run to its period was sent, and the chain your wallet reads does not show '
      + 'it yet.');
  }
  await kept.forget(vault, claim);
  if (seen === 'not-open') {
    throw new Error('the charge was sent, and the chain your wallet reads no longer holds this run\'s proposal open, so it cannot '
      + 'be paid as it stands. Reload the run to see where it stands. Nothing was paid.');
  }
  return { state: 'charged', spentBefore: BigInt(built.spent ?? '0') };
}
