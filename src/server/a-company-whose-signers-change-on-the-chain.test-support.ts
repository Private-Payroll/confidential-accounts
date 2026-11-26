/**
 * **ONE COMPANY WHOSE SIGNERS CHANGE ON THE CHAIN, OVER REAL HTTP**, for the
 * tests that follow a removal and a seating from the signers' own devices to
 * the chain. Built on `a-company-of-two-seats.test-support.ts` - its directory,
 * records, invitation and people routes and its anchor on the test's chain -
 * with the proposal relays and the roster and vault-key routes mounted beside
 * them. Cy holds a third seat, invited by Ada, and Bo is an admin; Ada's, Bo's
 * and Cy's wallets' records-key statements are in the roster, folded from their
 * own offers. A test may seat more signers after Cy's the same way (`after`).
 *
 * Three pieces are stand-ins, and they are named here:
 *   - **the chain's account**: a map of the proposals it holds open, each with
 *     the signers who approved it, behind the one door a device's proven call
 *     goes through, which a signer's own wallet's sends reach too. It does to
 *     the test's chain what each call would - a seat added, a seat taken off,
 *     a vault's adoption raised, a spending policy set, the record anchor
 *     recovered - and refuses a change of who is seated below
 *     the seat bar, a removal leaving fewer signers than it, and an approval by
 *     a signer it does not hold. The contract's own circuits are not run;
 *   - **the worker that builds a call**: it asks the questions the worker asks
 *     before it builds, with the contract's own pure circuits, and hands the
 *     order through as the transaction;
 *   - **the service's list of a company's proposals and the account's call
 *     state**: read straight from the store, and fixed.
 *   - **the chain the service's deploy route reads**: the account held by the
 *     committee the test's chain holds, with stand-in verifying keys, and a
 *     vault the route accepts landing on it; a seat's worker builds the deploy,
 *     reads it back and reads where the vault's start stands from it.
 */
import { throughAView, type AnchorDoorsBare } from '../testing/anchor-doors-through-a-view.js';
import { beforeAll, expect } from 'vitest';
import type express from 'express';
import { identityFromSecret } from 'midnight-identity';
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import type { SealedAnswer } from '../core/answer-opened.js';
import { fromHex, newBlinding, signingPublicKeyOf, toHex, type Hex } from '../core/crypto.js';
import { openAccount, sealAccount } from '../core/account.js';
import { signVaultKeys } from '../core/vault-keys.js';
import { approverRosterFrom, EVERY_RIGHT } from '../core/vault-approvers.js';
import { newProposalId } from '../core/proposal-filing.js';
import { signedFoundingRoster } from '../core/roster-record.js';
import type { Account, RetirementSignature, SealedAccount, SealedRun } from '../core/types.js';
import type { LedgerStatus } from '../core/ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { policyBarKey } from '../midnight/spending-policy.js';
import type { ChainHolders, CommitteeKey } from '../midnight/seat-directory.js';
import type { RecordsAsked } from '../midnight/records-held.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { assetIdHex, type AssetId } from '../core/assets.js';
import { aVaultHolding, registryWithTestPrivateForms, TEST_TOKEN } from '../testing/assets.js';
import { signCompanyFiling, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';
import { sealSpendingPolicy } from '../midnight/spending-policy-record.js';
import { signedStateHere, type CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import { spendingPolicyHere } from 'vaults-web-shared/spending-policy-read-here.js';
import { VAULT as VAULT_STANDING } from 'vaults-web-shared/vault-standing.js';
import { HttpCompanyRecordStore } from 'vaults-web-shared/http-sealed-pool-store.js';
import { LEDGER_PARAMETERS_HEADER } from 'vaults-web-shared/vault-private-deposit.js';
import type { OneOffsHere } from 'vaults-web-shared/one-off-here.js';
import { openOneOff } from '../midnight/one-off-record.js';
import { openSealedRun } from '../core/run-legs.js';
import { payRecordNonceOf } from '../midnight/run-keys.js';
import { keysByPurpose } from 'vaults-web-shared/keys-by-purpose.js';
import { buildOneOffRun } from '../midnight/payout-tree.js';
import type { OneOffRaiseDoors } from 'vaults-web-shared/one-off-raised-here.js';
import { vaultDetails } from '../testing/vault-details.js';
import { NothingWasSent } from '../core/jobs.js';
import { VAULT_CIRCUITS } from '../midnight/vault-contract.js';
import { adoptionRoundOf, firstSecretRunCarriedOf, secretRunOf, startStandingOf, type AccountLedgerForAStart, type AccountStartPure } from '../midnight/vault-start.js';
import { createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { ContractMaintenanceAuthority, ContractState } from '@midnightntwrk/ledger-v9';
import { companyVaultRoutes } from './company-vaults.js';
import { signerRoutes } from './signer-routes.js';
import { proposalRelayRoutes } from './proposal-relays.js';
import { runRoutes } from './run-routes.js';
import { anchorFunctions, anchorSentInATest, roundsOnATestChain } from '../testing/record-tree-double.js';
import { leavesOfTheContract } from '../testing/directory-seats.js';
import { manifestServiceOf, serviceSource, treeServiceOf } from 'vaults-web-shared/records-source.js';
import { anchorTheRecordsHere } from 'vaults-web-shared/records-anchored-here.js';
import { recordsHeldHere } from 'vaults-web-shared/records-held-here.js';
import { directoryChangeFiledHere } from 'vaults-web-shared/anchored-on-the-way-in.js';
import { attestedIn, directoryHere, directoryWithItsRecordsHere, judgeIn, leaversStatementIn, type DirectoryHere } from 'vaults-web-shared/vault-page-doors.js';
import { rosterHere, seatsAdmittedHere, type RosterDoors } from 'vaults-web-shared/roster-here.js';
import { foldOffersHere, offerVaultKeysHere } from 'vaults-web-shared/roster-filed-here.js';
import { treeKeptInMemory } from 'vaults-web-shared/tree-kept-here.js';
import { grantsHere, policyReadersIn, revokedAtHere } from 'vaults-web-shared/purpose-wraps.js';
import { GRANTS_RECORD } from '../midnight/grants-record.js';
import { governedCallServiceThrough } from 'vaults-web-shared/governed-call-through-the-view.js';
import type { RemovalDoors } from 'vaults-web-shared/signer-removed-on-device.js';
import type { GovernedCallOrder } from 'vaults-web-shared/governed-call-builder.js';
import {
  aCompanyOfTwoSeats, acmeChain, acmeDirectoryDeps, acmeReads, ACME_STATE, seatsTakenByInvitation, ADA, ADDRESS, apiAs, BO, chains, CO, KEY, LABEL, peopleRecords, seatBoAs, seatOf, sendAs, store,
  type Seat,
} from './a-company-of-two-seats.test-support.js';
import { keyFileAround, operationHolding } from '../testing/an-operation-holding.js';
import { viewOver, viewOpenedEachTime, foundingRecordsOver, storeReachOver } from '../testing/writes-over-a-send.js';

/* Bo holds an admin's seat here, as his invitation gave it. */
seatBoAs('admin');

const { refuseARaiseThatIsNotTheRecordedOne, refuseWhatThisDeviceDidNotOpen, identityOfAChange, spendingPolicyKeysOf } = await import('vaults-web-shared/governed-call-builder.js');
const { pureCircuits } = await import('../../contracts/managed/contract/index.js');
const { pureCircuits: vaultPure, Contract: VaultContract } = await import('../../contracts/managed-vault/contract/index.js');

export { ADA, BO, CO, KEY, LABEL, ADDRESS, acmeChain, apiAs, sendAs, store, chains, seatOf, type Seat };

/** Cy, seated by Ada's invitation: the third seat, an admin. */
export const CY = seatOf('cy', 3, LABEL, ADDRESS, CO, ADA);
/** Each seated person's id in the roster. */
export const ID: Record<string, string> = { ada: 'sgn_ada', bo: 'sgn_bo', cy: 'sgn_cy' };
/** The seats a company of more than three signers seats after Cy's, as `aCompanyWhoseSignersChange` was asked. */
let more: readonly Seat[] = [];

/* ── the chain's account, stood in ────────────────────────────────────────── */

/** Every proposal the chain holds open, by its identity on chain: what it changes, the leaf it takes off or the address it invites, and who approved it. */
const open = new Map<string, {
  change: 'add' | 'remove' | 'run' | 'other'; leaf: string | null; approvedBy: Set<string>; raisedBy: string; opensAt?: number; closesAt?: number;
}>();
/** The call that closed each proposal the chain no longer holds open. */
const closedWith = new Map<string, string>();
/** The vaults the account adopted on the test's chain. */
const adoptedVaults = new Set<string>();
/** The vaults the account adopted on the test's chain, in the order it adopted them. */
export const vaultsAdoptedOnTheChain = (): readonly Hex[] => [...adoptedVaults] as Hex[];
/** The proposals the chain holds open, by their identity there, each with what it changes: a run's and a one-off payment's are a `run`. */
export const openOnTheChain = (): readonly { readonly id: string; readonly change: string }[] => [...open].map(([id, o]) => ({ id, change: o.change }));
/**
 * What reached the service and the chain, in order: each directory version filed (`directory 5 retire`), each anchor
 * that landed (`anchored`), and each call the chain took, with the leaf it takes off (`chain removeSignerAndSetThreshold removing
 * <leaf>`) or the leaf an invited person seated (`chain seatInvited <leaf>`).
 */
export const events: string[] = [];
/** Every run's proposal charged to its vault's period on the test's chain, by its identity there. */
export const chargedOnChain = new Set<string>();

/** What the anchor stand-in is handed for each anchor a device sends: the stand-in builder's output, not a proven transaction. The service never sees these in this test world, so a check of what a device sends reads them here. */
export const sentToTheChain: string[] = [];

/** The committee key the chain seats each new leaf with, as the joining wallet gives it. */
export const committeeKeyOfLeaf = new Map<string, CommitteeKey>();

const holdingNow = (): ChainHolders => chains.get(CO)!;
/** The test's chain holds `seats`, at `approvals` and with `seatBar` the bar for a change of who is seated. */
export const holdingOf = (seats: readonly { seat: string; committeeKey: CommitteeKey }[], approvals = 1, seatBar = approvals): ChainHolders => ({
  seats: { committee: seats.map((s) => s.committeeKey), threshold: 1, seats: seats.map((s) => s.seat) }, approvals, seatBar,
});
/** The seats the test's chain holds now. */
export const seatsOnTheChain = (): readonly string[] => holdingNow().seats.seats;

/** The chain's own read of the account, as the service's relays read it. */
const status = async (accountId: string): Promise<LedgerStatus | null> => {
  if (accountId !== CO) return null;
  const h = holdingNow();
  return {
    assets: [], openProposals: [...open].map(([id, o]) => ({ id: id as Hex, change: '00'.repeat(32) as Hex, approvals: o.approvedBy.size })),
    threshold: h.approvals, signerCount: h.seats.seats.length,
    vaultThresholds: h.seatBar > h.approvals ? [{ vault: policyBarKey(), threshold: h.seatBar }] : [],
  } as unknown as LedgerStatus;
};

/**
 * The one door a device's governed call reaches the chain through. It keeps only the open proposals, their approvals,
 * the seats and bars, and what a call carried out writes beside them (a vault adopted, a run charged, a spending policy
 * set), and applies a call's effect on those. It runs none of the contract's circuits, so it leaves out
 * the count of removals a proposal was raised under, the vacant slot a removal leaves in the signers' tree (the list of
 * seats just shortens), and the circuit's limits on a new threshold and its effect on the policy bar.
 */
const submitProvenCall = async (_accountId: string, bytes: Uint8Array, circuit: string) => {
  const { signer, order } = JSON.parse(Buffer.from(bytes).toString('utf8')) as { signer: string; order: GovernedCallOrder };
  if (order.circuit !== circuit) throw new Error(`the door was told ${circuit} and handed ${order.circuit}`);
  const h = holdingNow();
  if (!h.seats.seats.includes(signer)) throw new Error('not a signer on this account');
  const proposal = 'proposal' in order ? String(order.proposal).toLowerCase() : '';
  if (order.circuit === 'propose' && 'governance' in order) {
    const g = order.governance as { kind: string; leaf?: string; address?: string };
    /* The raise counts as its raiser's approval, as the account's `propose` counts it. */
    open.set(proposal, {
      change: g.kind === 'add-signer' ? 'add' : g.kind === 'remove-signer' ? 'remove' : 'other',
      leaf: (g.kind === 'add-signer' ? g.address : g.leaf)?.toLowerCase() ?? null, approvedBy: new Set([signer]), raisedBy: signer,
    });
  } else if (order.circuit === 'propose' && 'adoption' in order) {
    open.set(proposal, { change: 'other', leaf: String(order.adoption.vault).toLowerCase(), approvedBy: new Set([signer]), raisedBy: signer });
  } else if (order.circuit === 'propose' && 'run' in order) {
    /* A run, a one-off payment's included: raised as the account raises it, counting its raiser, who may approve here. */
    open.set(proposal, {
      change: 'run', leaf: null, approvedBy: new Set([signer]), raisedBy: signer, opensAt: Number(order.run.opensAt), closesAt: Number(order.run.closesAt),
    });
  } else if (order.circuit === 'approve') {
    const o = open.get(proposal);
    if (o === undefined) throw new Error('there is no open proposal with that id');
    if (o.approvedBy.has(signer)) throw new Error('you have already approved this proposal');
    o.approvedBy.add(signer);
  } else if (order.circuit === 'adopt') {
    /* A vault adopted once its adoption holds the account's approvals: this chain keeps which vaults the account adopted. */
    const o = open.get(proposal);
    if (o === undefined) throw new Error('there is no open proposal with that id');
    if (o.approvedBy.size < h.approvals) throw new Error('not enough approvals');
    const vault = String(order.vault).toLowerCase();
    if (o.leaf !== vault) throw new Error('that proposal is not for this vault');
    adoptedVaults.add(vault);
    open.delete(proposal);
    closedWith.set(proposal, 'adopt');
  } else if (order.circuit === 'removeSignerAndSetThreshold') {
    const o = open.get(proposal);
    if (o === undefined) throw new Error('there is no open proposal with that id');
    if (o.approvedBy.size < h.seatBar) throw new Error('not enough approvals');
    const leaf = order.leaf.toLowerCase();
    if (o.change !== 'remove' || o.leaf !== leaf) throw new Error('that proposal is not for this removal');
    if (!h.seats.seats.includes(leaf)) throw new Error('that signer is not seated on this account');
    if (h.seats.seats.length - 1 < h.seatBar) throw new Error('that would leave too few signers to approve anything');
    const at = h.seats.seats.indexOf(leaf);
    chains.set(CO, { ...h, seats: { ...h.seats, seats: h.seats.seats.filter((_, i) => i !== at), committee: h.seats.committee.filter((_, i) => i !== at) } });
    open.delete(proposal);
    closedWith.set(proposal, 'removeSignerAndSetThreshold');
  } else if (order.circuit === 'setThreshold') {
    const o = open.get(proposal);
    if (o === undefined) throw new Error('there is no open proposal with that id');
    if (o.approvedBy.size < h.approvals) throw new Error('not enough approvals');
    chains.set(CO, { ...h, approvals: Number(order.threshold), seatBar: Math.max(h.seatBar, Number(order.threshold)) });
    open.delete(proposal);
    closedWith.set(proposal, 'setThreshold');
  } else if ((order.circuit as string) === 'clearRun') {
    /* A run charged to its vault's period: this chain keeps only that it was charged, and checks no period total, no policy and no proof. */
    if (!open.has(proposal)) throw new Error('there is no open proposal with that id');
    chargedOnChain.add(proposal);
  } else if (order.circuit === 'setPolicy') {
    /* A spending policy set once its proposal holds the approvals any change to a policy needs: this chain keeps the vault's marker and the policy's commitment, made with the account's own functions. */
    const o = open.get(proposal);
    if (o === undefined) throw new Error('there is no open proposal with that id');
    if (o.approvedBy.size < Math.max(h.approvals, h.seatBar)) throw new Error('not enough approvals');
    const keys = spendingPolicyKeysOf({ accountPure: pureCircuits as never }, { vault: order.vault, asset: order.asset, assetBlinding: order.assetBlinding, policy: order.policy as never });
    if (keys.commitment?.toLowerCase() !== order.commitment.toLowerCase()) throw new Error('the commitment is not the one the policy makes');
    policyOnChain.set(keys.onKey.toLowerCase(), '01');
    policyOnChain.set(keys.policyKey.toLowerCase(), keys.commitment.toLowerCase());
    open.delete(proposal);
    closedWith.set(proposal, 'setPolicy');
  } else if (order.circuit === 'cancel') {
    open.delete(proposal);
    closedWith.set(proposal, 'cancel');
  } else {
    throw new Error(`this test's chain does not take ${order.circuit}`);
  }
  events.push(order.circuit === 'removeSignerAndSetThreshold' ? `chain removeSignerAndSetThreshold removing ${order.leaf.toLowerCase()}` : `chain ${order.circuit}`);
  return { ref: `ref-${events.length}`, at: new Date().toISOString() };
};

/** The head the account's latest recovery carried out wrote: its `lastRecovery`, all zeroes until one is carried out. */
let lastRecovered = '00'.repeat(32);
/** The head the account's latest recovery carried out wrote, as the account's state holds it. */
export const lastRecoveryOnTheChain = (): string => lastRecovered;

/** A recovery of the record anchor as a signer's wallet hands it to the chain: what the account's `recoverAnchor` is called with. */
interface RecoveryOnTheWire {
  readonly circuit: 'recoverAnchor'; readonly signer: string; readonly previous: string; readonly batch: string;
  readonly held: { readonly approvals: number; readonly signerRoot: string }; readonly tag: string;
  readonly resumesFrom: string; readonly lastRecovery: string; readonly proposal: string;
}

/**
 * A call a signer's own wallet sends straight to the chain, as the chain takes it: a governed call goes through the one
 * door above; a recovery of the record anchor carries out the open recovery it names once its approvals reach the seat
 * bar, while the head the latest recovery wrote is still the one it names, and lands the head that resumes from the batch
 * it names. As above, no circuit runs and no proof is checked.
 */
export const takenFromTheOwnWallet = async (tx: string): Promise<void> => {
  const bytes = Buffer.from(tx, 'base64');
  const sent = JSON.parse(bytes.toString('utf8')) as { readonly order?: GovernedCallOrder } | RecoveryOnTheWire;
  if ('order' in sent && sent.order !== undefined) {
    await submitProvenCall(CO, bytes, sent.order.circuit);
    return;
  }
  const r = sent as RecoveryOnTheWire;
  if (r.circuit !== 'recoverAnchor') throw new Error(`this test's chain does not take ${String(r.circuit)}`);
  const h = holdingNow();
  if (!h.seats.seats.includes(r.signer)) throw new Error('not a signer on this account');
  const id = r.proposal.toLowerCase();
  const o = open.get(id);
  if (o === undefined) throw new Error('there is no open proposal with that id');
  if (o.approvedBy.size < h.seatBar) throw new Error('not enough approvals');
  if (r.lastRecovery.toLowerCase() !== lastRecovered) throw new Error('another recovery was carried out since this one was raised');
  acmeChain.recover(r.previous, r.batch, r.held as never, r.tag, r.resumesFrom);
  lastRecovered = acmeChain.head().toLowerCase();
  open.delete(id);
  closedWith.set(id, 'recoverAnchor');
  events.push('chain recoverAnchor');
};

/**
 * What `s`'s worker builds a recovery with, against the test's chain: the account's state as one block holds it, the head
 * its latest recovery wrote, and the recovery's call, made of what the account's `recoverAnchor` is called with and the
 * tag the device's material gives it, landing in the fallible section.
 */
export const recoveryBuiltBy = (s: Pick<Seat, 'seat'>) => ({
  accountCallChain: async () => ({ blockHash: 'b', accountState: acmeChain.head(), parameters: 'PP' }),
  lastRecovery: async () => lastRecovered,
  recoverAnchor: async (input: {
    account: string; material: { signingSecret: string; blinding: string }; previous: string; batch: string;
    held: { approvals: number; signerRoot: string }; resumesFrom: string; lastRecovery: string; proposal: string;
  }) => {
    const tag = await anchorFunctions.anchorTag({ account: input.account, material: input.material as never });
    const call: RecoveryOnTheWire = {
      circuit: 'recoverAnchor', signer: s.seat, previous: input.previous, batch: input.batch, held: input.held, tag,
      resumesFrom: input.resumesFrom, lastRecovery: input.lastRecovery, proposal: input.proposal,
    };
    return { tx: Buffer.from(JSON.stringify(call)).toString('base64'), placement: 'fallible' as const };
  },
});

/* ── a vault deployed, adopted and started on the test's chain ────────────── */

/** The vaults deployed on the test's chain through the service's deploy route, each with the account and committee it was born held by. */
const deployed = new Map<string, { readonly account: string; readonly committee: readonly CommitteeKey[]; readonly threshold: number }>();
/** What each deployed vault's ledger holds for its start: the commitment to its secret, and its sealed copies and their root by key. */
const vaultLedgers = new Map<string, { nonceCommitment: Uint8Array; readonly copies: Map<string, Uint8Array> }>();
/* A circuit's verifying key, as both the service's build and the vaults it deploys hold it. */
const verifierKeyOf = (circuit: string): Uint8Array => keyFileAround(`vk:${circuit}`);
/* The account's own circuits, as the service's build and the account on the test's chain hold them. */
const ACCOUNT_CIRCUITS = ['adopt', 'approve', 'propose'];
const keysOf = (circuits: readonly string[]): ReadonlyMap<string, Uint8Array> => new Map(circuits.map((c) => [c, verifierKeyOf(c)]));
/* A contract's state as the service reads it: who holds it, its circuits with their keys, and for a vault the account it is pinned to. */
const stateHeldBy = (committee: readonly CommitteeKey[], threshold: number, counter: bigint, circuits: readonly string[], ledger?: { account: string }) => ({
  maintenanceAuthority: { committee: committee.map((k) => ({ tag: k.tag, value: k.value })), threshold, counter },
  operations: () => [...circuits], operation: (c: string) => operationHolding(verifierKeyOf(c)), serialize: () => new Uint8Array([1]),
  ...(ledger === undefined ? {} : { ledger }),
});
interface DeployOnTheWire { readonly vault: string; readonly account: string; readonly committee: readonly CommitteeKey[]; readonly threshold: number }
/** A step of a vault's start as a seat's worker builds it here: the vault's first secret set, or one sealed copy of it written. */
type VaultCallOnTheWire =
  | { readonly vaultCall: 'setNonceSecret'; readonly vault: string; readonly proposal: string; readonly commitment: string; readonly rootKey: string; readonly copiesRoot: string }
  | { readonly vaultCall: 'writeSecretCopy'; readonly vault: string; readonly key: string; readonly commitment: string; readonly every: readonly string[] };
type OnTheWire = DeployOnTheWire | VaultCallOnTheWire | { readonly signer: string; readonly order: GovernedCallOrder };
/* A transaction holding one set of the calls named, each to the contract named, moving no coins. */
const callsOf = (...calls: readonly (readonly [string, string])[]): unknown =>
  ({ intents: new Map([[1, { actions: calls.map(([address, entryPoint]) => ({ address, entryPoint })) }]]) });
/*
 * A transaction as the ledger reads its bytes: a vault's deploy is one action deploying the vault's state held by the
 * committee it names; a governed call is the one call to the account; a vault's secret set asks the account's approval
 * beside the vault's own call; a sealed copy is the one call to the vault.
 */
const txRead = (bytes: Uint8Array): unknown => {
  const d = JSON.parse(Buffer.from(bytes).toString('utf8')) as OnTheWire;
  if ('order' in d) return callsOf([ADDRESS, d.order.circuit]);
  if ('vaultCall' in d) {
    return d.vaultCall === 'setNonceSecret' ? callsOf([ADDRESS, 'approveVaultChange'], [d.vault, 'setNonceSecret']) : callsOf([d.vault, 'writeSecretCopy']);
  }
  return { intents: new Map([[1, { actions: [{ address: d.vault, initialState: stateHeldBy(d.committee, d.threshold, 0n, VAULT_CIRCUITS, { account: d.account }) }] }]]) };
};

/*
 * A step of a vault's start the service sends, as the test's chain takes it: its first secret set under the account's
 * open run holding the approvals the account asks, which closes that run and writes the copies' root; or one sealed copy
 * written, the copies counted written once every one the run names is. No circuit runs and no proof is checked.
 */
const vaultCallTaken = (c: VaultCallOnTheWire): void => {
  const v = vaultLedgers.get(c.vault.toLowerCase());
  if (v === undefined) throw new Error('the chain holds no vault at this address');
  if (c.vaultCall === 'setNonceSecret') {
    const id = c.proposal.toLowerCase();
    const o = open.get(id);
    if (o === undefined || o.change !== 'run') throw new Error('there is no open run with that id');
    if (o.approvedBy.size < holdingNow().approvals) throw new Error('not enough approvals');
    if (v.nonceCommitment.some((b) => b !== 0)) throw new Error('this vault already holds a secret');
    v.nonceCommitment = fromHex(c.commitment as Hex);
    v.copies.set(c.rootKey, fromHex(c.copiesRoot as Hex));
    open.delete(id);
    closedWith.set(id, 'setNonceSecret');
  } else {
    if (toHex(v.nonceCommitment).toLowerCase() !== c.commitment.toLowerCase()) throw new Error('this copy is not of the secret the vault holds');
    v.copies.set(c.key, fromHex(c.commitment as Hex));
    if (c.every.every((k) => v.copies.has(k))) v.copies.set(toHex(vaultPure.copiesWrittenKey()), fromHex(c.commitment as Hex));
  }
  events.push(`chain ${c.vaultCall}`);
};

/**
 * The service's vault routes for a company, over the test's chain: the account is read as born held by the committee the
 * chain holds, with this build's circuits; a deploy the route accepts lands its vault on the chain, and a step of a
 * vault's start the route accepts reaches the chain's door for the account's calls, or the vault's own.
 */
const vaultRoutes = (deps: { signedIn: express.RequestHandler; member: express.RequestHandler }): express.Router => companyVaultRoutes({
  signedIn: deps.signedIn, member: deps.member, store: store as never,
  company: async (id) => (id === CO ? { address: ADDRESS as Hex, threshold: holdingNow().approvals, seats: holdingNow().seats.seats.length, vaultThresholds: [] } : null),
  ledger: {
    sendVault: async (_accountId, _what, _arrival, bytes, check, read) => {
      const tx = await read(bytes);
      const refused = await check(tx);
      if (refused !== null) throw new NothingWasSent(refused);
      const d = JSON.parse(Buffer.from(bytes).toString('utf8')) as OnTheWire;
      if ('order' in d) {
        await submitProvenCall(CO, bytes, d.order.circuit);
      } else if ('vaultCall' in d) {
        vaultCallTaken(d);
      } else {
        deployed.set(d.vault.toLowerCase(), { account: d.account.toLowerCase(), committee: d.committee, threshold: d.threshold });
        vaultLedgers.set(d.vault.toLowerCase(), { nonceCommitment: new Uint8Array(32), copies: new Map() });
        events.push('chain deploy');
      }
      return { ref: `ref-${events.length}`, at: new Date().toISOString(), transactionHash: toHex(sha256(bytes)) };
    },
  },
  chain: {
    contractState: async (address) => {
      if (String(address).toLowerCase() === String(ADDRESS).toLowerCase()) {
        const h = holdingNow();
        return stateHeldBy(h.seats.committee, h.seats.threshold, 1n, ACCOUNT_CIRCUITS);
      }
      const vault = String(address).toLowerCase();
      const v = deployed.get(vault);
      return v === undefined ? null : { ...stateHeldBy(v.committee, v.threshold, 0n, VAULT_CIRCUITS, { account: v.account }), vault };
    },
    serialize: (s) => (s as { serialize(): Uint8Array }).serialize(),
    notesOf: () => [],
    startingLedgerOf: (s) => {
      /* A deploy's state names no vault yet: it holds no secret and no copies. */
      const { ledger: { account }, vault } = s as { ledger: { account: string }; vault?: string };
      const v = vaultLedgerForAStart(vault ?? '');
      const started = v.secretCopies.member(vaultPure.copiesWrittenKey());
      return {
        account, notes: 0n, unshieldedTokens: 0n, payments: 0n, nonceCommitment: toHex(v.nonceCommitment), splitJournal: 0n,
        secretCopies: BigInt(vaultLedgers.get(vault ?? '')?.copies.size ?? 0), reserved: 0n, retired: false, started,
      };
    },
    everCreated: async () => new Set(),
  },
  verifierKeys: async () => keysOf(VAULT_CIRCUITS),
  account: { circuits: ACCOUNT_CIRCUITS, verifierKeys: async () => keysOf(ACCOUNT_CIRCUITS) },
  readers: { proven: async (bytes) => txRead(bytes), finished: async (bytes) => txRead(bytes) },
});

/*
 * What the account holds for a vault's start as the test's chain reads it: the vaults it adopted, its open proposals and
 * the approvals each counts, and the window of each open run. No vault has a bar of its own here.
 */
const accountForAStart = (): AccountLedgerForAStart => {
  const at = (id: Uint8Array) => open.get(toHex(id).toLowerCase());
  return {
    threshold: BigInt(holdingNow().approvals),
    vaults: { member: (v) => adoptedVaults.has(toHex(v).toLowerCase()) },
    thresholds: { member: () => false, lookup: () => 0n },
    openProposals: { member: (id) => at(id) !== undefined },
    approvalCounts: { member: (id) => at(id) !== undefined, lookup: (id) => BigInt(at(id)?.approvedBy.size ?? 0) },
    proposalHolds: { member: () => false, lookup: () => ({ needed: 0n, removals: 0n }) },
    runWindow: [...open].flatMap(([id, o]) => (o.change !== 'run' || o.closesAt === undefined ? []
      : [[fromHex(id as Hex), { opensAt: BigInt(o.opensAt ?? 0), closesAt: BigInt(o.closesAt) }] as [Uint8Array, { opensAt: bigint; closesAt: bigint }]])),
  };
};

/* A vault's ledger as its start reads it, from what the test's chain holds for it. */
const vaultLedgerForAStart = (vault: string) => {
  const v = vaultLedgers.get(vault.toLowerCase());
  const copies = v?.copies ?? new Map<string, Uint8Array>();
  return {
    nonceCommitment: v?.nonceCommitment ?? new Uint8Array(32),
    secretCopies: { member: (k: Uint8Array) => copies.has(toHex(k)), lookup: (k: Uint8Array) => copies.get(toHex(k)) ?? new Uint8Array(32) },
  };
};

/* An answer as the worker hands it over: its numbers as digits and its bytes as hex. */
const onTheWire = (x: unknown): unknown => {
  if (typeof x === 'bigint') return x.toString();
  if (x instanceof Uint8Array) return toHex(x);
  if (Array.isArray(x)) return x.map(onTheWire);
  if (x !== null && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, onTheWire(v)]));
  return x;
};
const START_CIRCUITS = { vault: vaultPure as never, account: pureCircuits as never } as Parameters<typeof startStandingOf>[0];
type RunOnTheWire = { readonly vault: string; readonly commitment: string; readonly copiesRoot: string; readonly copies: readonly { readonly reader: string }[] };
const copyKeyOf = (run: RunOnTheWire, place: number): string =>
  toHex(vaultPure.copyKeyOf(fromHex(run.commitment as Hex), fromHex(run.copies[place]!.reader as Hex), BigInt(place), 0n));

/**
 * The serialized state of a vault deployed on the test's chain, as the indexer answers for it, or null where it holds
 * none: the state the compiled vault's own constructor makes for the account it is pinned to, held by the committee it
 * was born held by.
 */
export const vaultStateOnTheChain = async (address: string): Promise<string | null> => {
  const v = deployed.get(address.toLowerCase());
  if (v === undefined) return null;
  const { currentContractState } = await new VaultContract(NO_WITNESSES as never).initialState(
    createConstructorContext({} as never, '0'.repeat(64)), { bytes: fromHex(v.account as Hex) } as never);
  const state = ContractState.deserialize((currentContractState as { serialize(): Uint8Array }).serialize());
  state.maintenanceAuthority = new ContractMaintenanceAuthority(v.committee.map((k) => ({ tag: k.tag, value: k.value })) as never, v.threshold, 0n);
  return Buffer.from(state.serialize()).toString('hex');
};
/* The vault's constructor calls no witness; the contract still asks that both exist. */
const NO_WITNESSES = { noteToSpend: () => { throw new Error('none'); }, nonceSecret: () => { throw new Error('none'); } };

/* The chain's current parameters as the indexer answers them: the ledger's own header, which is all a device checks. */
const PARAMETERS = Buffer.from(`${LEDGER_PARAMETERS_HEADER}..`).toString('base64');

let vaultsBuilt = 0;
/**
 * What `s`'s worker builds and reads a new vault with, against the test's chain: a deploy held by the committee given and
 * pinned to the account, the vault read back as deployed, the chain at one block, where the vault's start stands, read
 * with the contracts' own pure circuits from what the test's chain holds, its first secret set and each sealed copy of
 * it written, and whether a secret is the one the vault holds.
 */
export const vaultBuiltBy = (s: Pick<Seat, 'seat'>) => ({
  bornHeldVault: async (input: { account: string; holders: { committee: readonly CommitteeKey[]; threshold: number } }) => {
    vaultsBuilt += 1;
    const vault = toHex(sha256(new TextEncoder().encode(`a vault built on this test's chain ${vaultsBuilt}`))).toLowerCase();
    const wire: DeployOnTheWire = { vault, account: input.account.toLowerCase(), committee: input.holders.committee, threshold: input.holders.threshold };
    return { vault, tx: Buffer.from(JSON.stringify(wire)).toString('base64') };
  },
  vaultAsDeployed: async (input: { vault: string; account: string; holders: { committee: readonly CommitteeKey[]; threshold: number } }) => {
    const v = deployed.get(input.vault.toLowerCase());
    if (v === undefined) return { refusal: 'the chain holds no vault at this address. Nothing was sent.' };
    const same = v.account === input.account.toLowerCase() && v.threshold === input.holders.threshold
      && JSON.stringify(v.committee) === JSON.stringify(input.holders.committee);
    return { refusal: same ? null : 'this vault was not created held by the company\'s committee. Nothing was sent.' };
  },
  chainAtOneBlock: async (input: { vault: string }) => (deployed.has(input.vault.toLowerCase())
    ? { blockHash: 'b', vaultState: '', zswapState: '', parameters: PARAMETERS, accountState: acmeChain.head(), account: ADDRESS } : null),
  startStanding: async (input: {
    vault: string; now: string; secret?: string; readers?: readonly string[]; previous?: string; earlier?: readonly string[];
    window?: { opensAt: string; closesAt: string }; again?: string;
  }) => {
    const run = input.secret === undefined ? undefined
      : secretRunOf(START_CIRCUITS, { vault: input.vault as Hex, secret: input.secret as Hex, readers: (input.readers ?? []) as Hex[], ...(input.previous === undefined ? {} : { previous: input.previous }) });
    const standing = startStandingOf(START_CIRCUITS, {
      vault: input.vault as Hex, account: accountForAStart(), vaultLedger: vaultLedgerForAStart(input.vault),
      ...(run === undefined ? {} : { run, ...(input.earlier === undefined ? {} : { earlier: input.earlier }) }),
      now: BigInt(input.now), approvedHere: (id) => open.get(toHex(id).toLowerCase())?.approvedBy.has(s.seat) ?? false,
      ...(input.window === undefined ? {} : { window: { opensAt: BigInt(input.window.opensAt), closesAt: BigInt(input.window.closesAt) } }),
      ...(input.again === undefined ? {} : { again: input.again as Hex }),
    });
    return { standing: onTheWire(standing), ...(run === undefined ? {} : { run: onTheWire(run) }) } as never;
  },
  setNonceSecret: async (input: { vault: string; run: RunOnTheWire; proposal: string }) => {
    const wire: VaultCallOnTheWire = {
      vaultCall: 'setNonceSecret', vault: input.vault.toLowerCase(), proposal: input.proposal, commitment: input.run.commitment,
      rootKey: toHex(vaultPure.copiesRootKeyOf(fromHex(input.run.commitment as Hex))), copiesRoot: input.run.copiesRoot,
    };
    return { tx: Buffer.from(JSON.stringify(wire)).toString('base64') };
  },
  writeSecretCopy: async (input: { vault: string; run: RunOnTheWire; place: number }) => {
    const wire: VaultCallOnTheWire = {
      vaultCall: 'writeSecretCopy', vault: input.vault.toLowerCase(), key: copyKeyOf(input.run, input.place), commitment: input.run.commitment,
      every: input.run.copies.map((_, place) => copyKeyOf(input.run, place)),
    };
    return { tx: Buffer.from(JSON.stringify(wire)).toString('base64') };
  },
  secretIsTheVaults: async (input: { vault: string; secret: string }) => {
    const held = vaultLedgers.get(input.vault.toLowerCase())?.nonceCommitment;
    return held !== undefined && toHex(vaultPure.secretCommitmentOf(fromHex(input.vault as Hex), fromHex(input.secret as Hex))) === toHex(held);
  },
});

/**
 * A wallet taking the seat a proposal to add a signer approved, as the account's `seatInvited` takes it: the address
 * is made here from the coin key of the wallet taking it and the address salt it holds, as the circuit makes it, and
 * the proposal must invite that address and hold the approvals the seat bar asks. Only the holder of the address the
 * proposal names gets the seat, whoever the proposal was raised for; the seat it gets is the leaf its own keys make
 * (`leaf`). The seat goes on the end of the list. This chain checks no proof that the wallet holds the coin key's
 * secret: the contract's own tests hold that.
 */
export const theInviteeTakesTheSeatHere = (
  proposal: string, holder: { readonly coinPublicKey: string; readonly addressSalt: string }, leaf: string,
): void => {
  const h = holdingNow();
  const id = proposal.toLowerCase();
  const o = open.get(id);
  if (o === undefined) throw new Error('there is no open proposal with that id');
  const address = MidnightCommitments.inviteAddressOf(holder.coinPublicKey.toLowerCase() as Hex, holder.addressSalt.toLowerCase() as Hex).toLowerCase();
  if (o.change !== 'add' || o.leaf !== address) throw new Error('that proposal does not invite this wallet with these rights');
  if (o.approvedBy.size < h.seatBar) throw new Error('not enough approvals');
  const seat = leaf.toLowerCase();
  if (h.seats.seats.includes(seat)) throw new Error('that signer is already seated on this account');
  const key = committeeKeyOfLeaf.get(seat);
  if (key === undefined) throw new Error('the test gave no committee key for this leaf');
  chains.set(CO, { ...h, seats: { ...h.seats, seats: [...h.seats.seats, seat], committee: [...h.seats.committee, key] } });
  open.delete(id);
  closedWith.set(id, 'seatInvited');
  seatsTakenByInvitation.set(id, seat);
  events.push(`chain seatInvited ${seat}`);
};

const roundsHere = roundsOnATestChain(async () => [...open].map(([id, o]) => ({
  id, approvals: o.approvedBy.size, approvedBy: o.approvedBy, raisedBy: o.raisedBy, ...(o.opensAt === undefined ? {} : { opensAt: o.opensAt }),
})),
  (id) => { const c = closedWith.get(id); return c === undefined ? [] : [c]; });
/**
 * Where each proposal stands on the test's chain, as each person's own wallet reads it. An open run also says the
 * approvals it needs, as the account counts them for a run: its bar, which here is the account's, as no vault has one
 * of its own and no signer was removed since a run was raised.
 */
export const theChain = async (chainIds: readonly string[], seat?: string): ReturnType<typeof roundsHere> => {
  const rounds = await roundsHere(chainIds, seat);
  return Object.fromEntries(Object.entries(rounds).map(([id, r]) => [id,
    r.held === 'open' && open.get(id)?.change === 'run' ? { ...r, needed: holdingNow().approvals } : r]));
};

/* ── the company: three seats, every wallet's statement in the roster ─────── */

const signerOf = (s: Seat) => ({
  id: ID[s.person]!, leafCommitment: s.seat as Hex, userId: s.person, name: s.person, status: 'active' as const,
  signingPublicKey: s.statement.signingKey as Hex, wrappingPublicKey: 'ab'.repeat(32) as Hex, role: 'admin' as const,
});
/** What a seat's wallet released for the company, and the statement it signed over the records key. */
export const walletOf = (s: { n: number; seat: string }) => ({
  companyKey: toHex(new Uint8Array(32).fill(s.n + 100)) as Hex,
  recordsKey: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(s.n)), LABEL, ADDRESS, new Uint8Array(32).fill(s.n + 100), s.seat),
});
/** Acme's first roster, filed by Ada's founding seat with her vault keys. */
const firstRoster = () => {
  const adas = walletOf(ADA).recordsKey;
  const signers = [ADA, BO, CY, ...more].map(signerOf).map((x) => (x.id !== ID.ada ? x : {
    ...x, vaultKeys: signVaultKeys(CO, ID.ada!, {
      committeeKey: ADA.committeeKey as never, recordsKey: adas.recordsKey as Hex, recordsKeyStatement: adas.signature as Hex, recordsKeySeat: ADA.seat as Hex,
    }, ADA.signingSecret as Hex),
  }));
  return signedFoundingRoster(CO, { name: 'Acme', signers }, KEY, ADA.signingSecret as Hex);
};

/* ── one device of one seat ─────────────────────────────────────────────── */

/** A device's read of the company's `api`, as the page's own `api` reads it: a refusal throws, with the service's words. */
export const api = (person: string) => apiAs(person);

/** One seat's device reading and filing the roster under the filing key its entry names. */
export const rosterDoorsOf = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered'>): RosterDoors => ({
  view: viewOver(api(s.person), CO), accountId: CO, viewingKey: KEY, signingSecret: s.signingSecret as Hex, label: LABEL, account: ADDRESS,
  reads: acmeReads, entered: s.entered,
});
/** The records-key statements the roster this device believes holds, as the page reads them (`attestedIn`). */
export const attestedByTheRoster = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered'>) => async () => attestedIn((await rosterHere(rosterDoorsOf(s))).account);
/** The company's directory and records as `s`'s device believes them, its statements read from the roster it believes. */
export const directoryOf = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered'>) => (asked?: RecordsAsked): Promise<DirectoryHere> =>
  directoryHere({ ...acmeDirectoryDeps(), attested: attestedByTheRoster(s) }, asked);

/** Every version of the company's read grants as the service keeps them. */
export const grantsKept = (): Promise<readonly SealedCompanyRecord[]> => peopleRecords.versions(CO, GRANTS_RECORD.kind, GRANTS_RECORD.id);

/** What `s`'s device anchors and files a directory change through, against the test's chain. */
export const anchorDoorsOf = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered'>, kept = treeKeptInMemory()): AnchorDoorsBare => ({
  accountId: CO,
  changes: kept.changes,
  material: { signingSecret: s.signingSecret as Hex, blinding: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex } as never,
  manifest: manifestServiceOf(serviceSource(api(s.person), CO)),
  tree: treeServiceOf(serviceSource(api(s.person), CO)),
  directory: () => directoryWithItsRecordsHere({ ...acmeDirectoryDeps(), attested: attestedByTheRoster(s) }),
  directoryFilings: async () => store.directoryFilingsOf(CO),
  fileDirectory: async (filing) => {
    const r = await sendAs(s.person)(`/api/accounts/${CO}/directory/${filing.version}`, { method: 'POST', body: JSON.stringify(filing) });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    events.push(`directory ${filing.version} ${filing.change.kind}`);
  },
  onChain: acmeChain.onChain,
  service: {
    callState: async () => ({ account: ADDRESS, accountState: acmeChain.head(), parameters: '', blockHash: 'b' }) as never,
    sendProven: async (_c, tx) => {
      sentToTheChain.push(tx);
      const { previous, batch, held, tag } = JSON.parse(tx) as { previous: Hex; batch: Hex; held: { approvals: number; signerRoot: Hex }; tag: Hex };
      acmeChain.move(previous, batch, held, tag);
      events.push('anchored');
    },
    sealedProposals: async (c) => store.listProposals(c),
    foundingRecords: foundingRecordsOver(api(s.person), CO),
  },
  builder: { ...anchorFunctions, anchor: anchorSentInATest },
});

/** Every batch of the company's records `s`'s device reads, judged from the company's first header: where the check stopped, if it did. */
export const recordsReadBy = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered'>, asked: RecordsAsked) => recordsHeldHere(anchorDoorsOf(s), asked);

/**
 * What `s`'s device changes the company's key through: the key its wallet released for the company, its served copy of
 * the company's first key, the directory's filings as the service serves them, the seat requests waiting, the seats the
 * roster admitted, and its filing of the change.
 */
export const companyKeyDoorsOf = (
  s: Pick<Seat, 'person' | 'signingSecret' | 'entered' | 'n' | 'seat'>, anchor: AnchorDoorsBare = anchorDoorsOf(s),
): NonNullable<RemovalDoors['companyKey']> => ({
  filings: async () => store.directoryFilingsOf(CO),
  served: async () => KEY,
  released: () => walletOf(s).companyKey,
  askTheWallet: async () => walletOf(s).companyKey,
  /* Every seat request the service holds, sealed to the company's inbox, and the seats the roster this device believes admitted. */
  waiting: async () => (store.getAccount(CO)?.pendingSigners ?? []).map((p) => p.sealed as SealedAnswer),
  admitted: async () => {
    const d = rosterDoorsOf(s);
    return seatsAdmittedHere(await api(s.person)(`/api/accounts/${CO}`), d.viewingKey, {
      accountId: CO, label: LABEL, account: ADDRESS, reads: d.reads, own: { signingPublicKey: signingPublicKeyOf(s.signingSecret as Hex) },
      proposals: async () => api(s.person)(`/api/accounts/${CO}/proposals`),
    });
  },
  file: (change, signedFor) => directoryChangeFiledHere(throughAView(anchor), change, signedFor),
  /* The read grants as the service keeps them, judged by this device as a seat: the key epoch a taking-away was filed at. */
  revoked: () => revokedAtHere({
    accountId: CO, versions: grantsKept, directory: directoryOf(s),
    signingPublicKey: signingPublicKeyOf(s.signingSecret as Hex), released: async () => walletOf(s).companyKey,
  }),
});

/**
 * The device of a seat - a removal's and a seating's doors - with what it keeps across opens. With `changesTheKey`,
 * its wallet has released the company's key in this tab, and a removal it finishes changes the company's key.
 */
export const deviceOf = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered' | 'seat' | 'n'>, o: { changesTheKey?: boolean } = {}): RemovalDoors => {
  const kept = treeKeptInMemory();
  const signatures = new Map<string, RetirementSignature[]>();
  const anchor = anchorDoorsOf(s, kept);
  return {
    ...(o.changesTheKey === true ? { companyKey: companyKeyDoorsOf(s, anchor) } : {}),
    service: { ...governedCallServiceThrough(viewOpenedEachTime(api(s.person), CO)), callState: async () => ({ account: ADDRESS, blockHash: 'b', accountState: 'AS', parameters: 'PP' }) as never },
    builder: {
      governedCall: async ({ order, opened }) => {
        refuseWhatThisDeviceDidNotOpen({ accountPure: pureCircuits as never }, order, opened);
        refuseARaiseThatIsNotTheRecordedOne({ accountPure: pureCircuits as never }, order);
        /* The account refuses a signer's second approval as the call is built, and a raise was the raiser's first. */
        if (order.circuit === 'approve' && open.get(String(order.proposal).toLowerCase())?.approvedBy.has(s.seat)) {
          throw Object.assign(new Error('you have already approved this proposal'), { name: 'CallNotBuilt' });
        }
        return { tx: Buffer.from(JSON.stringify({ signer: s.seat, order })).toString('base64') };
      },
      proposalIdentity: async (change, salt) => identityOfAChange({ accountPure: pureCircuits as never }, change, salt),
    },
    material: { signingSecret: s.signingSecret as Hex, blinding: '22'.repeat(32), scope: '33'.repeat(32) },
    accountId: CO,
    records: {
      directory: directoryOf(s),
      state: async (id: string) => (id === ACME_STATE.id ? ACME_STATE : null),
      people: async () => { throw new Error('no person is read in this test'); },
      runs: async () => [],
      proposals: async () => store.listProposals(CO),
      /* This seat's wallet reads the chain for its own approval marker too. */
      roundsOnChain: (ids: readonly string[]) => theChain(ids, s.seat),
      /* The vault's spending policies, read as this seat: a removal counts each vault's approvers at its top band. */
      spendingPolicies: policiesReadBy(s),
    } as never,
    filing: { seat: s.seat, keyEpoch: 0, salt: () => newBlinding(), newId: () => newProposalId(), entered: s.entered },
    approvers: async () => approverRosterFrom({
      threshold: holdingNow().approvals, vaultThresholds: [], seated: seatsOnTheChain().map((leaf) => ({ leaf, rights: EVERY_RIGHT })), adoptedVaults: [], companyWide: 'cc'.repeat(32),
    }),
    vaultName: () => 'company-wide runs',
    leaves: leavesOfTheContract,
    sleep: async () => {}, waitMs: 40, everyMs: 1,
    anchorDirectory: () => anchorTheRecordsHere(throughAView(anchor)),
    leaversStatement: async (seat) => leaversStatementIn(await attestedByTheRoster(s)(), seat, LABEL, ADDRESS),
    directoryChange: (change, signedFor) => directoryChangeFiledHere(throughAView(anchor), change, signedFor),
    kept: kept.changes,
    signatures: {
      keep: async (_c, id, given) => {
        const was = signatures.get(id) ?? [];
        signatures.set(id, [...was.filter((x) => !given.some((y) => y.publicKey === x.publicKey && y.signedFor === x.signedFor)), ...given]);
      },
      all: async (_c, id) => signatures.get(id) ?? [],
    },
  };
};

/**
 * Mounts the company before a file's tests run: the two-seat company's routes, and beside them the proposal relays,
 * the roster and vault-key routes and the company's proposal list. Then Cy's entry is filed, Bo and Cy offer their
 * vault keys and Ada's device folds them into the roster, every version is anchored from Ada's device while the
 * account asks one approval, and the test's chain then holds the three seats at `seatBar`.
 */
export function aCompanyWhoseSignersChange(seatBar = 2, after: readonly Seat[] = [], served: { readonly vaultRows?: boolean } = {}): void {
  more = after;
  for (const s of after) ID[s.person] = `sgn_${s.person}`;
  aCompanyOfTwoSeats((app: express.Express, deps) => {
    const ownsProposal: express.RequestHandler = (req, res, next) => {
      const p = store.getProposal(String(req.params.id));
      return p !== null && store.getAccount(p.accountId)?.memberUserIds.includes(req.userId!) ? next() : res.status(404).json({ error: 'not found' });
    };
    const refuseSigningSecret: express.RequestHandler = (req, res, next) =>
      (req.body && typeof req.body === 'object' && 'signingSecret' in req.body ? res.status(400).json({ code: 'signing-secret-refused' }) : next());
    app.get('/api/accounts/:id', deps.signedIn, deps.member, (req, res) => {
      const id = String(req.params.id);
      res.json({ ...store.getAccount(id), roster: store.newestRoster(id) });
    });
    app.get('/api/accounts/:id/proposals', deps.signedIn, deps.member, (req, res) => { res.json(store.listProposals(String(req.params.id))); });
    /* The company's vault rows as the service lists them, where a file asks for them: each vault the store holds, held by the committee. */
    if (served.vaultRows === true) {
      app.get('/api/accounts/:id/vaults', deps.signedIn, deps.member, (req, res) => {
        res.json({ rows: store.listCompanyVaults(String(req.params.id)).map((v) => ({ vault: v.vault, deployedAt: v.deployedAt, state: VAULT_STANDING.held, why: null })) });
      });
    }
    const vaults = vaultRoutes(deps);
    app.post('/api/accounts/:id/vaults', vaults);
    app.post('/api/accounts/:id/vaults/:vault/start/:step', vaults);
    app.use(signerRoutes({
      signedIn: deps.signedIn, member: deps.member, store, records: () => deps.records, directoryOf: deps.directoryOf,
      ledger: { status, holdsSigner: async (_a, seat) => seatsOnTheChain().includes(String(seat)) },
    }));
    app.use(runRoutes({ signedIn: deps.signedIn, member: deps.member, store, directoryOf: deps.directoryOf, wiring: () => 'simulated' }));
    app.use(proposalRelayRoutes({
      signedIn: deps.signedIn, member: deps.member, ownsProposal, refuseSigningSecret,
      store, ledger: { wiring: 'simulated' as never, status, submitProvenCall: submitProvenCall as never }, directoryOf: deps.directoryOf,
      recordRefusal: () => undefined,
      proposalIdOf: (h, salt, vault) => MidnightCommitments.proposalId(h as Hex, salt as Hex, vault as Hex | undefined),
      /* A vault's adoption and first secret run written down as carried out, checked against what the test's chain holds. */
      adoptionOf: (vault, again) => adoptionRoundOf(pureCircuits as unknown as AccountStartPure, vault, again),
      vaultsAdopted: async () => vaultsAdoptedOnTheChain(),
      firstSecretRunOf: (vault, parts) => firstSecretRunCarriedOf(START_CIRCUITS, vault, parts),
      vaultSecretOf: async (vault) => {
        const v = vaultLedgerForAStart(vault);
        return { commitment: toHex(v.nonceCommitment), started: v.secretCopies.member(vaultPure.copiesWrittenKey()) };
      },
    }));
  }, { roster: firstRoster });

  beforeAll(async () => {
    const account = {
      id: CO, name: 'Acme', createdAt: 'now', signers: [ADA, BO, CY, ...more].map(signerOf), policy: { threshold: 1 }, wrappedKeys: [],
      recovery: { signerIds: [], threshold: 1 }, contractAddress: ADDRESS, companyLabel: LABEL,
    } as unknown as Account;
    store.putAccount(sealAccount(account, KEY, [], 0));
    store.recordAccountDeploy({ accountId: CO, address: ADDRESS as Hex, foundingKey: ADA.committeeKey, deploy: '', insert: '', recordedAt: 'then' });
    chains.set(CO, holdingOf([ADA, BO, CY, ...more]));
    for (const [i, s] of [CY, ...more].entries()) {
      const r = await sendAs(s.person)(`/api/accounts/${CO}/directory/${3 + i}`, { method: 'POST', body: JSON.stringify({ company: CO, version: 3 + i, change: { kind: 'claim', entry: s.entry } }) });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    for (const s of [BO, CY, ...more]) {
      await offerVaultKeysHere(CO, {
        signerId: ID[s.person]!, signingSecret: s.signingSecret as Hex, committeeKey: s.committeeKey as never,
        ...walletOf(s), entry: s.statement, viewingKey: KEY,
      }, viewOver(api(s.person), CO));
    }
    await anchorTheRecordsHere(throughAView(anchorDoorsOf(ADA)));
    expect(await foldOffersHere(rosterDoorsOf(ADA))).toEqual({ folded: [BO.seat, CY.seat, ...more.map((m) => m.seat)], refused: [] });
    chains.set(CO, holdingOf([ADA, BO, CY, ...more], 1, seatBar));
    events.length = 0;
  });
}

/* ── a vault's spending policy, held on the test's chain ──────────────────── */

/** The vault whose spending policy a seat files, and the currency it is for. */
export const VAULT = 'fa'.repeat(32);
const TERMS = {
  bands: [{ ceiling: '10', approvals: '1' }, { ceiling: '20', approvals: '1' }, { ceiling: '30', approvals: '1' }, { ceiling: '40', approvals: '1' }],
  periodLimit: '100', periodStart: '0', periodLength: '60',
};
/** What the account's map of roles holds for each vault's policy, by key: its marker and its commitment. */
const policyOnChain = new Map<string, string>();
/** What the account's map of roles holds at each key asked, as the indexer reads it: a policy's marker or commitment, or nothing. */
export const rolesOnTheChain = (keys: readonly string[]): { readonly key: string; readonly value: string | null }[] =>
  keys.map((key) => ({ key, value: policyOnChain.get(key.toLowerCase()) ?? null }));
/** How many vaults the account's map of roles holds a spending policy set on: each is marked when its policy is set. */
export const policiesSetOnTheChain = (): number => [...policyOnChain.values()].filter((v) => v === '01').length;
/** The secret a seat's device opens what is sealed to its records key with, from what its wallet released for the company. */
export const recordsSecretOf = (s: { n: number }): Hex => toHex(hkdf(sha256, new Uint8Array(32).fill(s.n + 100),
  new TextEncoder().encode('confidential-accounts/company-records-wrapping/v1'), new Uint8Array(0), 32)) as Hex;
/** The contract's own keys for the vault's policy and the commitment `opening` makes, with the account's blinding from its signed state. */
const policyKeys = async (records: CompanyRecordsHere, opening?: { terms: typeof TERMS; blinding: string }, asset: AssetId = TEST_TOKEN) => spendingPolicyKeysOf(
  { accountPure: pureCircuits as never },
  { vault: VAULT, asset: assetIdHex(asset), assetBlinding: (await signedStateHere(records, CO, KEY)).assetBlinding, ...(opening === undefined ? {} : { policy: opening as never }) },
);
/** `s`'s device's company records, with the vault's spending policies read as its own seat. */
function policiesReadBy(s: Pick<Seat, 'n' | 'seat' | 'person' | 'signingSecret' | 'entered'>): NonNullable<CompanyRecordsHere['spendingPolicies']> {
  return {
    versions: (id) => peopleRecords.versions(CO, 'spending-policy', id),
    file: async () => { throw new Error('no policy is filed through this read'); },
    me: { signerId: s.seat, wrappingSecret: recordsSecretOf(s) },
    keys: async (i) => spendingPolicyKeysOf({ accountPure: pureCircuits as never }, i),
    onChain: async (keys) => new Map(keys.map((k) => [k.toLowerCase(), policyOnChain.get(k.toLowerCase()) ?? null])),
    /* The read grants as the service keeps them, judged by this seat's device: the readers given `policy`. */
    grantReaders: async () => policyReadersIn(await grantsHere({
      accountId: CO, versions: grantsKept, directory: directoryOf(s), me: { signerId: s.seat, wrappingSecret: recordsSecretOf(s) },
    })),
  };
}
const policyRecordsOf = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered' | 'seat' | 'n'>): CompanyRecordsHere => ({
  ...(deviceOf(s).records as CompanyRecordsHere),
  spendingPolicies: policiesReadBy(s),
});
/**
 * **THE VAULT'S SPENDING POLICY, FILED BY `by`** sealed to the records key of each seat in `to` as the directory holds
 * it, signed by its seat, kept where the service keeps the company's records and entered from its device; the test's
 * chain then holds the vault's marker and the policy's commitment. Returns the version filed. `o` gives other terms, or
 * another currency, than the test's small ones in its own token.
 */
export const aPolicyFiledBy = async (by: Seat, to: readonly Seat[], o: { readonly terms?: typeof TERMS; readonly asset?: AssetId } = {}): Promise<number> => {
  const records = policyRecordsOf(by);
  const asset = o.asset ?? TEST_TOKEN;
  const opening = { terms: o.terms ?? TERMS, blinding: newBlinding() };
  const keys = await policyKeys(records, opening, asset);
  const version = (await peopleRecords.versions(CO, 'spending-policy', keys.policyKey)).length + 1;
  const here = await directoryOf(by)();
  const rec = signCompanyFiling(sealSpendingPolicy({
    company: CO, id: keys.policyKey as Hex, version, keyEpoch: 0,
    secrets: { vault: VAULT, asset, opening },
    signers: to.map((x) => ({ id: x.seat, wrappingPublicKey: here.dir.seats.find((d) => d.seat === x.seat)!.wrappingKey })) as never,
  }), by.signingSecret as Hex);
  await peopleRecords.put(rec);
  await by.entered.enter([companyRecordEntry(rec)]);
  policyOnChain.set(keys.onKey.toLowerCase(), '01');
  policyOnChain.set(keys.policyKey.toLowerCase(), keys.commitment!.toLowerCase());
  return version;
};
/** The vault's policy as `s`'s device reads it, with its own seat's records key (`spendingPolicyHere`). */
export const policyReadBy = (
  s: Pick<Seat, 'person' | 'signingSecret' | 'entered' | 'seat' | 'n'>, viewingKey: Parameters<typeof spendingPolicyHere>[0]['viewingKey'] = KEY,
) => spendingPolicyHere({ records: policyRecordsOf(s), accountId: CO, viewingKey }, { vault: VAULT, asset: TEST_TOKEN });

/** The company as the service holds it now, opened with the viewing key. */
export const companyNow = (): ReturnType<typeof openAccount> => openAccount(store.getAccount(CO) as SealedAccount, KEY, store.newestRoster(CO) as never);

/* ── a one-off payment from the vault, its record sealed under the company's key ── */

/** Every entry the test's account records as paid: each payment's once-mark and its leaf's movement. */
export const paidOnChain = new Set<string>();
const hexOfBytes = (b: Uint8Array): string => Buffer.from(b).toString('hex');
/**
 * A run's payments recorded as paid on the test's chain, as the account records each payment it makes: each leaf's
 * movement and each person's once-mark for the month, made with the account's own circuits from the run as the company's
 * key opens it and the pay-record key the company's signed state holds.
 */
export const aRunPaidOnTheChain = async (run: SealedRun): Promise<void> => {
  const opened = openSealedRun(run, keysByPurpose(KEY).at(run.keyEpoch));
  const legs = Object.values(opened.payout ?? {});
  if (legs.every((leg) => leg.leaves.length === 0)) throw new Error(`run ${run.id} pays no one, so no payment of it is recorded`);
  const { payKey } = await signedStateHere(policyRecordsOf(ADA), CO, KEY);
  for (const leg of legs) {
    for (const leaf of leg.leaves) paidOnChain.add(hexOfBytes(pureCircuits.paidMovementOf(fromHex(leaf))));
    for (const rec of leg.records ?? []) paidOnChain.add(hexOfBytes(pureCircuits.paidOnceOf(fromHex(payRecordNonceOf(payKey as Hex, rec)))));
  }
};
/** Whether the test's chain records every payment of `run` as paid: each leaf's movement marked, as `aRunPaidOnTheChain` marks it. */
export const paidWholeOnTheChain = (run: SealedRun): boolean => {
  const legs = Object.values(openSealedRun(run, keysByPurpose(KEY).at(run.keyEpoch)).payout ?? {});
  return legs.some((leg) => leg.leaves.length > 0)
    && legs.every((leg) => leg.leaves.every((leaf) => paidOnChain.has(hexOfBytes(pureCircuits.paidMovementOf(fromHex(leaf))))));
};
/** The account's ledger as one block holds it, for a device's own check of what a proposal pays. */
export const ledgerViewNow = () => ({
  openProposals: { member: (id: Uint8Array) => open.has(hexOfBytes(id)) },
  movements: { member: (entry: Uint8Array) => paidOnChain.has(hexOfBytes(entry)) },
});
const judgeOf = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered'>) => async (asked?: RecordsAsked) => judgeIn(await directoryOf(s)(asked));
const oneOffStoreOf = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered'>, signs: boolean) =>
  new HttpCompanyRecordStore(CO, storeReachOver((path, init) => sendAs(s.person)(path, init as never), CO), signs ? s.signingSecret as Hex : null, judgeOf(s));
/**
 * `s`'s device's company records, with its one-off payments read with the company's key, the vault's spending policies, and
 * what its wallet reads of the account's record of payments from the test's chain.
 */
export const oneOffRecordsOf = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered' | 'seat' | 'n'>): CompanyRecordsHere & { readonly oneOffs: OneOffsHere } => {
  const store = oneOffStoreOf(s, false);
  return {
    ...policyRecordsOf(s),
    oneOffs: {
      at: (k, id, v) => store.at(k, id, v), keys: KEY, detailsOf: vaultDetails, registry: registryWithTestPrivateForms(),
      open: openOneOff, treeOf: buildOneOffRun,
    },
    payments: {
      paidOnceOf: (nonce) => pureCircuits.paidOnceOf(nonce), paidMovementOf: (leaf) => pureCircuits.paidMovementOf(leaf),
      read: async (entries) => ({
        payKeyCommitment: null, held: entries.filter((e) => paidOnChain.has(e.toLowerCase())), openRounds: [...open.keys()].sort(), entries: paidOnChain.size,
      }),
    },
  };
};
/** What `s`'s device raises a one-off payment from the vault with, against the test's chain and the service's routes. */
export const oneOffRaiseDoorsOf = (s: Seat): OneOffRaiseDoors => {
  const device = deviceOf(s);
  const filing = oneOffStoreOf(s, true);
  return {
    service: device.service, builder: device.builder, material: device.material, accountId: CO,
    records: oneOffRecordsOf(s), holdings: aVaultHolding(), assets: registryWithTestPrivateForms(),
    oneOffFiling: { put: (rec) => filing.put(rec), served: async () => null },
    filing: { seat: s.seat, keyEpoch: 0, newId: () => newProposalId() },
    runs: {
      runPayload: (...a) => pureCircuits.runPayload(...a), proposalIdOf: (...a) => pureCircuits.proposalIdOf(...a),
      retrySaltOf: (...a) => pureCircuits.retrySaltOf(...a), noVault: () => pureCircuits.noVault(),
    },
    recorded: { entered: s.entered, anchor: () => anchorTheRecordsHere(throughAView(anchorDoorsOf(s))) },
  };
};
