/**
 * **WHAT A PAYROLL PROPOSAL PAYS, READ ON THIS DEVICE FROM THE COMPANY'S OWN
 * RECORDS, SO THAT THE RUN CAN BE MADE AGAIN HERE BEFORE IT IS APPROVED.**
 *
 * Read here, each from the record that holds it:
 *   - the company's state, believed only as the record its founding seat
 *     signed and the company's first anchor on chain holds: the payout seeds
 *     and the pay-record key every payee's secrets come from. The founding seat
 *     is the one the company's first anchor names - never whoever holds a slot
 *     now - and the key it signs with is the one its own wallet signed into the
 *     company's directory. The founding signer removed later, or another seat
 *     put where they sat, changes nothing about which signature is believed;
 *   - the run, opened with the viewing key, and the leg or the retry the
 *     proposal raised;
 *   - the people, as this device believes and would pay them: a person no seat
 *     it believes filed, or whose address or payslip key is not what their own
 *     code names, is not someone this device pays.
 *
 * What is returned is handed to where the approval is built, which makes every
 * leaf, the root and the payload again and proves nothing unless they are the
 * proposal's (`refuseWhatThisDeviceDidNotMake`).
 */
import type { CheckedHeads } from './tree-kept-here.js';
import { vouchedRefusal, type Vouched } from '../../../src/midnight/record-tree.js';
import type { AssetRegistry } from '../../../src/core/assets.js';
import type { Hex, Sealed } from '../../../src/core/crypto.js';
import { openRecord } from '../../../src/core/sealed-records.js';
import { fromHex, parseCanonical, toHex, unseal } from '../../../src/core/crypto.js';
import { payrollRoundOf } from '../../../src/core/retry-cover.js';
import type { PayrollRound } from '../../../src/core/account.js';
import type { Account, Employee, PayrollRun, RosterEmployee, RunLeg, SealedProposal, SealedRun, StateBlinding } from '../../../src/core/types.js';
import type { PaymentFacts } from '../../../src/midnight/payout-tree.js';
import {
  assetOfLeg, factsOfThePaid, legEmployees, legsOfRun, openSealedRun, payRecordsOf, runIdForLeg,
} from '../../../src/core/run-legs.js';
import {
  CREATED_BEFORE_SIGNED_STATE, FOUNDING_KEY_EPOCH, foundingStateRefusal, openStateRecord, stateRecordId,
} from '../../../src/core/founding-state.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import type { RoundOnChain } from './governed-call-builder.js';
import { FOUNDING_ASKED, foundingRecordRefusalHere, judgeIn, kindAsked, listedHere, type DirectoryRead } from './vault-page-doors.js';
import { runFilingRefusal } from '../../../src/core/run-filing.js';
import { companyRecordKey } from '../../../src/midnight/seat-directory.js';
import { proposalEntry, runEntry } from '../../../src/midnight/record-manifest.js';
import { proposalFilingRefusal } from '../../../src/core/proposal-filing.js';
import { payRecordNonceOf } from '../../../src/midnight/run-keys.js';
import type { RaisingHere } from './what-this-device-made.js';
import type { PeopleHere } from './people-on-device.js';
import type { RunMadeHere, WalletReadFacts } from './what-this-device-made.js';
import { knownEntriesOf, paymentEntriesOf } from './payment-entries.js';
import type { AccountPaymentFacts } from 'midnight-identity/profile/records-key';
import { MOST_ENTRIES_ASKED } from 'midnight-identity/profile/request';

/** The company's records this device reads a run from. */
export interface CompanyRecordsHere {
  /**
   * The company's seat directory, as this device believes it now, with who
   * holds the account and the seat its deploy seated as the person's own wallet
   * read them.
   */
  readonly directory: DirectoryRead;
  /** The company's people, opened and judged on this device (`readPeopleHere`). */
  readonly people: () => Promise<PeopleHere>;
  /** The company's state record at one key epoch, as filed, or null when none is. */
  readonly state: (id: string) => Promise<SealedCompanyRecord | null>;
  /** The company's runs, sealed as they are stored. */
  readonly runs: () => Promise<readonly SealedRun[]>;
  /** The company's proposals, sealed as they are stored. Read where a raise or a retry is made here. */
  readonly proposals?: () => Promise<readonly SealedProposal[]>;
  /**
   * **WHERE EACH PROPOSAL STANDS ON THE CHAIN**, by its identity on chain, read
   * from the account's history at the indexer the person's own wallet names
   * (`VaultBuilderClient.roundsOnChain`) and from nowhere else. Every proposal
   * listed here is read with it (`proposalsListedHere`).
   */
  readonly roundsOnChain?: (chainIds: readonly string[]) => Promise<Readonly<Record<string, RoundOnChain>>>;
  /**
   * **THE HEADS OF THE COMPANY'S RECORDS THIS DEVICE CHECKED ITSELF**, as its
   * own database keeps them (`treeKeptHere`): the head a payroll run's raiser
   * seals beside its salt is its latest, and an approver approves only over a
   * head among them. Read where a run is raised or approved here.
   */
  readonly checked?: () => Promise<CheckedHeads | null>;
  /**
   * **WHAT THE ACCOUNT RECORDS ABOUT PAYMENTS, READ BY THE PERSON'S OWN
   * WALLET**: `read` asks the wallet which of the given entries of the
   * account's record of payments it holds, the commitment it holds to its
   * pay-record key, every proposal it holds open and how many entries its
   * record holds (`holdersFromTheWallet` with `movements`); `paidOnceOf` and
   * `paidMovementOf` are the account's own circuits an entry is made with, of a
   * person-month's nonce and of a payee's leaf. Part of the records a run is
   * read from, so nothing that raises or approves a run can be wired without it.
   */
  readonly payments: {
    readonly paidOnceOf: (nonce: Uint8Array) => Uint8Array;
    readonly paidMovementOf: (leaf: Uint8Array) => Uint8Array;
    readonly read: (entries: readonly string[]) => Promise<AccountPaymentFacts>;
  };
  /** The account's own functions a payroll round's identity on chain is made with: what a round's own window is checked against (`roundClosesAtHere`). */
  readonly roundIdentity: RoundIdentity;
  /** The company's own ceilings, opened from its sealed policy record. */
  readonly policy: () => Promise<Account['policy']>;
  readonly registry?: AssetRegistry;
  /** A vault's spending policies, and what the chain holds for them (`spending-policy-here.ts`). */
  readonly spendingPolicies?: SpendingPoliciesHere;
}

/**
 * **A VAULT'S SPENDING POLICIES, AS THIS DEVICE READS AND FILES THEM.** Every
 * version the company's store serves under one policy's key, each believed
 * only as `spending-policy-here.ts` judges it against the directory this
 * device believes; filing a new version, signed by this device's seat; this
 * signer's own seat and wrapping secret, which open it; the contract's own keys
 * for a policy, made in the worker; and what the company's account holds under
 * given keys, read by the person's own wallet (`chainReadThroughTheWallet`) -
 * never an answer the company's service made. Who a version is sealed to is
 * never a door: it is the seats this device believes (`readersIn`).
 */
export interface SpendingPoliciesHere {
  readonly versions: (id: string) => Promise<readonly SealedCompanyRecord[]>;
  readonly file: (rec: SealedCompanyRecord) => Promise<void>;
  readonly me: { readonly signerId: string; readonly wrappingSecret: Hex };
  /** The worker's `spending-policy-keys` ask (`VaultBuilderClient.spendingPolicyKeys`). */
  readonly keys: VaultBuilderClient['spendingPolicyKeys'];
  /** For each key asked, lower-cased, what the account's map of roles holds under it, or null for nothing. */
  readonly onChain: (keys: readonly string[]) => Promise<ReadonlyMap<string, string | null>>;
}

/** Why this device could not read a run from the company's records. Nothing is built without it. */
/**
 * **THE COMPANY'S RUNS AS THE SERVICE LISTS THEM**, refused as withheld when
 * the list leaves out one the company's records name (`listedHere`): the one
 * way a run is listed on this device.
 */
export async function runsListedHere(records: Pick<CompanyRecordsHere, 'runs' | 'directory'>): Promise<readonly SealedRun[]> {
  const [runs, here] = await Promise.all([records.runs(), records.directory(kindAsked('run'))]);
  return listedHere(here, 'run', runs, 'payroll run');
}

/**
 * **THE COMPANY'S PROPOSALS AS THE SERVICE LISTS THEM**, refused as withheld
 * when the list leaves out one the company's records name (`listedHere`), each
 * standing where the chain says it stands (`standingOnChainHere`): the one way a
 * proposal is listed on this device. `served` is a list already read for this
 * decision, judged the same way.
 */
export async function proposalsListedHere(
  records: Pick<CompanyRecordsHere, 'directory' | 'roundsOnChain'> & { readonly proposals: () => Promise<readonly SealedProposal[]> },
  served?: readonly SealedProposal[],
): Promise<readonly SealedProposal[]> {
  const [proposals, here] = await Promise.all([served ?? records.proposals(), records.directory(kindAsked('proposal'))]);
  return standingOnChainHere(records, listedHere(here, 'proposal', proposals, 'proposal'));
}

/** The calls that close a round without carrying it out: withdrawing it, and closing one whose window has closed. */
const CLOSED_UNPAID = new Set(['cancel', 'closeExpiredRun']);

/**
 * **WHERE EACH PROPOSAL STANDS, AS THE CHAIN SAYS IT DOES**, never as the
 * service's plain fields say: every field of where it stands is the chain's, at
 * the indexer the person's own wallet names (`roundsOnChain`).
 *
 *   - **held open** (cleared or not): `open`, with the approvals the account
 *     counts for it;
 *   - **closed**: `cancelled` when a call of a transaction that succeeded in
 *     the block that closed it withdrew a proposal or closed one past its
 *     window, `executed` when no such call did and some call succeeded. The
 *     block may hold other proposals' calls: a change carried out beside
 *     another proposal's withdrawal reads `cancelled`, so a change never reads
 *     carried out when it was withdrawn. A payroll round is closed only those
 *     two ways and `payrollRoundsHere` reads every closed one as `cancelled`;
 *   - **never held**: `open`, with no `raisedAt` - withdrawn before it reached
 *     the chain, refused by the service, sent and not yet seen, or opened and
 *     closed within one block, which the chain cannot tell apart. Its proof
 *     may still be sent, so it is not taken as withdrawn on the service's word.
 *
 * `raisedAt` is the time of the first block whose state held it, and `txRef`
 * the one call to `propose` in that block. Refused, saying what resolves it,
 * when the page cannot read the chain.
 */
export async function standingOnChainHere<P extends {
  readonly id: string; readonly chainId: string; readonly status: string; readonly approvalCount?: number;
  readonly raisedAt?: string; readonly txRef?: string; readonly executedAt?: string;
}>(records: Pick<CompanyRecordsHere, 'roundsOnChain'>, proposals: readonly P[]): Promise<P[]> {
  if (proposals.length === 0) return [];
  if (records.roundsOnChain === undefined) {
    throw new Error('this page cannot read where the company\'s proposals stand on the chain, so it decides nothing from them. '
      + 'Reload the page to get the current version');
  }
  const rounds = await records.roundsOnChain([...new Set(proposals.map((p) => String(p.chainId).toLowerCase()))]);
  return proposals.map((p) => {
    const r = rounds[String(p.chainId).toLowerCase()];
    if (r === undefined) {
      throw new Error(`where proposal ${p.id} stands on the chain was not read, so nothing is decided from it. Reload the page`);
    }
    const { raisedAt: _r, txRef: _t, executedAt: _e, ...rest } = p;
    const closedBy = r.closedBy ?? [];
    const status = r.held !== 'closed' ? 'open' : closedBy.some((c) => CLOSED_UNPAID.has(c)) || closedBy.length === 0 ? 'cancelled' : 'executed';
    return {
      ...rest, status, approvalCount: r.approvals,
      ...(r.raisedAt === undefined ? {} : { raisedAt: new Date(r.raisedAt).toISOString() }),
      ...(r.txRef === undefined ? {} : { txRef: r.txRef }),
    } as unknown as P;
  });
}

export class RunNotReadHere extends Error {
  constructor(why: string, options?: { cause?: unknown }) {
    super(`${why} Nothing was built or sent.`, options);
    this.name = 'RunNotReadHere';
  }
}

const IF_AGAIN = 'If it happens again, do not approve it.';

/**
 * The payout seeds and pay-record key from the state the founding seat signed,
 * as the company's first anchor on chain holds it (`foundingRecordRefusalHere`):
 * the founding seat's entry is one the directory keeps whether the seat is held
 * now or not, so the first state stays believed through any later change of
 * seats.
 */
export async function signedStateHere(
  records: CompanyRecordsHere, accountId: string, viewingKey: Hex,
): Promise<{ readonly seeds: NonNullable<StateBlinding['payoutSeeds']>; readonly payKey: string; readonly assetBlinding: string }> {
  const rec = await records.state(stateRecordId(FOUNDING_KEY_EPOCH));
  if (rec === null) throw new RunNotReadHere(CREATED_BEFORE_SIGNED_STATE.replace(/ Nothing was approved or sent\./u, ''));
  const refused = foundingRecordRefusalHere(await records.directory(FOUNDING_ASKED), rec, (key) => foundingStateRefusal(rec, accountId, key));
  if (refused !== null) {
    throw new RunNotReadHere(`This device does not believe the company state it was given (${refused}), so it cannot check `
      + `what this proposal pays. Reload the page and try again. ${IF_AGAIN}`);
  }
  let blinding;
  try {
    ({ blinding } = openStateRecord(rec, viewingKey));
  } catch (e) {
    throw new RunNotReadHere(`This device cannot open the company's state with the key it holds, so it cannot check what `
      + `this proposal pays. Reload the page and try again. ${IF_AGAIN}`, { cause: e });
  }
  const payKey = String(blinding.payRecordKey ?? '');
  if (!/^[0-9a-f]{64}$/u.test(payKey)) {
    throw new RunNotReadHere('The company\'s state carries no pay-record key, so no run of it can be checked here.');
  }
  return { seeds: blinding.payoutSeeds ?? [], payKey, assetBlinding: blinding.assetBlinding };
}

/** A run of the company opened here with the viewing key, or refused by name. */
const openedHere = (sealed: SealedRun, viewingKey: Hex, what: string): PayrollRun => {
  try {
    return openSealedRun(sealed, viewingKey);
  } catch (e) {
    throw new RunNotReadHere(`This device cannot open ${what}. Reload the page and try again. ${IF_AGAIN}`, { cause: e });
  }
};

/**
 * **ONE OF THE COMPANY'S RUNS, OPENED HERE BY ITS ID.** Refused when the
 * company holds no run by that id, or the run it holds is another company's.
 */
/**
 * **A RUN IS READ ONLY AS A SEAT THIS DEVICE BELIEVES FILED IT, AT ITS NEWEST
 * VERSION.** Its filing signature must cover exactly the run as it is kept,
 * for this company, and be made with the signing key the company's directory
 * holds for a seat whose role may file a run. A run is kept whole and changed
 * in place, so its bytes carry no version: its version is the one whose entry
 * in the company's records names those bytes, and no newer one may be entered.
 * A run nobody signed, a seat signed and the service then changed, or one the
 * service serves from before a newer version was filed, is not read.
 */
async function refuseARunNoSeatFiled(records: CompanyRecordsHere, accountId: string, sealed: SealedRun): Promise<void> {
  const read = { store: 'run' as const, kind: 'run', id: sealed.id, digest: runEntry(accountId, sealed, 1).digest };
  const why = runFilingRefusal(accountId, sealed)
    ?? judgeIn(await records.directory({ records: [read] }))(sealed.filedBy!.publicKey.toLowerCase() as Hex, 'run', companyRecordKey('run', sealed.id), read, true);
  if (why !== null) {
    throw new RunNotReadHere(`This device does not believe the company's record of this payroll run (${why}). Do not act on it. `
      + IF_AGAIN);
  }
}

export async function openedRunHere(records: CompanyRecordsHere, accountId: string, runId: string, viewingKey: Hex): Promise<PayrollRun> {
  return (await keptRunHere(records, accountId, runId, viewingKey)).run;
}

/** The run as the company keeps it, sealed, and as this device opened it, once a believed seat is shown to have filed it. */
export async function keptRunHere(
  records: CompanyRecordsHere, accountId: string, runId: string, viewingKey: Hex,
): Promise<{ readonly sealed: SealedRun; readonly run: PayrollRun }> {
  const sealed = (await runsListedHere(records)).find((r) => r.id === runId);
  if (sealed === undefined || sealed.accountId !== accountId) {
    throw new RunNotReadHere(`This company's records hold no payroll run by that name. Reload the page to see its runs.`);
  }
  await refuseARunNoSeatFiled(records, accountId, sealed);
  const run = openedHere(sealed, viewingKey, 'this payroll run');
  if (run.id !== runId || run.accountId !== accountId) {
    throw new RunNotReadHere(`The payroll run this company's records hold under that name was built for another run or another company. ${IF_AGAIN}`);
  }
  return { sealed, run };
}

/**
 * **THE IDENTITY ON CHAIN OF EVERY PROPOSAL THIS DEVICE BELIEVES**, by the
 * company's name for it: each filed by a seat, its filing signature covering
 * it, and held by the anchor as the newest version (`judgeIn`). One the
 * service wrote itself, or this device does not believe, names nothing.
 */
export async function believedProposalIdsOnChainHere(records: CompanyRecordsHere, accountId: string): Promise<ReadonlyMap<string, string>> {
  const judge = judgeIn(await records.directory(kindAsked('proposal')));
  const ids = new Map<string, string>();
  const readProposals = records.proposals;
  for (const p of readProposals === undefined ? [] : await proposalsListedHere({ ...records, proposals: readProposals })) {
    if (p.filedBy === undefined || p.accountId !== accountId || proposalFilingRefusal(accountId, p) !== null) continue;
    if (judge(p.filedBy.publicKey, 'proposal', companyRecordKey('proposal', p.id), proposalEntry(accountId, p), true) !== null) continue;
    ids.set(p.id, p.chainId.toLowerCase());
  }
  return ids;
}

/**
 * **EVERY RUN OF THE COMPANY'S THIS DEVICE BELIEVES**, opened here: each filed
 * by a seat the directory this device believes may file a run, for this
 * company. A run it does not believe, or cannot open, is passed over, never
 * read: whatever is worked out from these runs is then short of it, and a sum
 * that must open a commitment on the chain is refused rather than believed.
 */
export async function believedRunsHere(records: CompanyRecordsHere, accountId: string, viewingKey: Hex): Promise<readonly PayrollRun[]> {
  const believed: PayrollRun[] = [];
  for (const sealed of await runsListedHere(records)) {
    if (sealed.accountId !== accountId) continue;
    try {
      await refuseARunNoSeatFiled(records, accountId, sealed);
      const run = openedHere(sealed, viewingKey, 'one of the company\'s payroll runs');
      if (run.id === sealed.id && run.accountId === accountId) believed.push(run);
    } catch (e) {
      if (!(e instanceof RunNotReadHere)) throw e;
    }
  }
  return believed;
}

/**
 * **WHAT EACH OF `paid` IS PAID, FROM THE PEOPLE THIS DEVICE BELIEVES AND WOULD
 * PAY**: each person's address and form from their own believed record. A
 * person this device does not believe, or would not pay at the address it
 * holds, is refused by name with `whatToDo`; a run paying anybody not on the
 * roster, or not active, is refused with `whyNot`.
 */
export async function payableFactsHere(
  records: CompanyRecordsHere, paid: readonly Employee[], whatToDo: string, whyNot: string,
): Promise<PaymentFacts[]> {
  return payableFactsOf(await records.people(), paid, whatToDo, whyNot, records.registry);
}

/** `payableFactsHere`, over the people this device has already read. */
export function payableFactsOf(
  people: PeopleHere, paid: readonly Employee[], whatToDo: string, whyNot: string, registry?: AssetRegistry,
): PaymentFacts[] {
  const payable = new Map<string, RosterEmployee>(people.people.map((p) => [p.person.id, p.person]));
  const refusedHere = new Set([...people.notBelieved, ...people.notPayable.map((n) => n.here.person.id)]);
  const notHere = paid.find((e) => refusedHere.has(e.id));
  if (notHere !== undefined) {
    throw new RunNotReadHere(`${notHere.name} is on this run, and this device does not believe their record or would not `
      + `pay them at the address it holds. ${whatToDo}`);
  }
  try {
    return factsOfThePaid(paid, (id) => payable.get(id), registry);
  } catch (e) {
    throw new RunNotReadHere(`${(e as Error).message.replace(/\.?\s*$/u, '.')} ${whyNot}`, { cause: e });
  }
}

/**
 * **THE RUN A PAYROLL PROPOSAL RAISED, AS THIS DEVICE READS IT.** `proposalId`
 * is the company's own name for the proposal. What it pays is the leg's record
 * of its payments, which the tree is built again from; whether this device
 * would pay each person the proposal pays, at exactly that, is one of the raise
 * checks (`raise-checks-here.ts`), run on it wherever it is approved. Refused,
 * by name, when no run of the company raised it or the company's state is not
 * one this device believes.
 */
export async function runRebuiltHere(
  records: CompanyRecordsHere, accountId: string, proposalId: string, viewingKey: Hex,
): Promise<{ readonly run: PayrollRun; readonly leg: RunLeg; readonly made: RunMadeHere }> {
  const sealed = (await runsListedHere(records)).find((r) => r.accountId === accountId && (r.proposalIds ?? []).includes(proposalId));
  if (sealed === undefined) {
    throw new RunNotReadHere('No payroll run of this company raised this proposal, so this device has nothing to check it '
      + `against. ${IF_AGAIN}`);
  }
  await refuseARunNoSeatFiled(records, accountId, sealed);
  const run = openedHere(sealed, viewingKey, 'the payroll run this proposal raised');
  let leg = legsOfRun(run).find((l) => run.proposalIds[l] === proposalId);
  let retry: {
    readonly originalIndices: readonly number[]; readonly opensAt: bigint; readonly closesAt: bigint; readonly required?: bigint;
  } | undefined;
  if (leg === undefined) {
    for (const l of legsOfRun(run)) {
      const found = run.payout?.[l]?.retries?.find((r) => r.proposalId === proposalId);
      if (found !== undefined) { leg = l; retry = found; break; }
    }
  }
  const payout = leg === undefined ? undefined : run.payout?.[leg];
  if (leg === undefined || payout === undefined) {
    throw new RunNotReadHere(`The payroll run this proposal names does not say which of its payments it raised. ${IF_AGAIN}`);
  }
  if (payout.runId !== runIdForLeg(run, leg) || run.accountId !== accountId) {
    throw new RunNotReadHere(`The payroll run this proposal names was built for another run or another company. ${IF_AGAIN}`);
  }
  const state = await signedStateHere(records, accountId, viewingKey);
  const paid = legEmployees(run, leg);
  const window = retry ?? payout;
  const made: RunMadeHere = {
    kind: 'payroll',
    seeds: state.seeds,
    payKey: state.payKey,
    identity: { accountId, runId: payout.runId, epoch: payout.epoch },
    facts: [...payout.facts],
    records: payRecordsOf(run, paid),
    asset: assetOfLeg(leg),
    opensAt: String(window.opensAt),
    closesAt: String(window.closesAt),
    required: String(window.required ?? 0n),
    ...(retry === undefined ? {} : { retry: [...retry.originalIndices] }),
  };
  return { run, leg, made: await checkedAgainstTheRecordsAndTheWallet(records, accountId, run, viewingKey, made) };
}

/**
 * **A RUN MADE HERE, WITH WHAT IT IS CHECKED AGAINST**: what the company's
 * records account for on the chain, and what the person's own wallet read
 * about its payments and about the chain (`withWhatTheWalletRead`). The one way
 * a raise and an approval both put a run made here beside what it is checked
 * against.
 */
export async function checkedAgainstTheRecordsAndTheWallet(
  records: CompanyRecordsHere, accountId: string, run: PayrollRun, viewingKey: Hex, made: Omit<RunMadeHere, 'raising' | 'wallet'>,
  proposals?: readonly SealedProposal[],
): Promise<RunMadeHere> {
  return withWhatTheWalletRead(records, { ...made, raising: await whatTheRecordsAccountFor(records, accountId, run, viewingKey, proposals) });
}

/**
 * **A RUN MADE HERE, WITH WHAT THE PERSON'S OWN WALLET READ ABOUT ITS
 * PAYMENTS AND ABOUT THE CHAIN**: which of its entries the account already
 * records, and the account's commitment to its pay-record key; which of the
 * entries the company's records know about it holds, every proposal it holds
 * open and how many entries its record of payments holds. Where the run is
 * checked and proved, these are what it is checked against, never the account
 * state the service serves.
 *
 * A wallet is asked about at most `MOST_ENTRIES_ASKED` entries at a time, so a
 * company with a longer history is asked in parts; every part must find the
 * chain as the first did, or nothing is taken from any of them.
 */
export async function withWhatTheWalletRead(records: CompanyRecordsHere, made: RunMadeHere): Promise<RunMadeHere> {
  const own = paymentEntriesOf(made, records.payments.paidOnceOf);
  const known = made.raising === undefined ? [] : knownEntriesOf(made.raising, records.payments);
  const asked = [...new Set([...own, ...known])];
  const reads: AccountPaymentFacts[] = [];
  try {
    for (let at = 0; at < asked.length; at += MOST_ENTRIES_ASKED) reads.push(await records.payments.read(asked.slice(at, at + MOST_ENTRIES_ASKED)));
  } catch (e) {
    throw new RunNotReadHere(`Your wallet could not read from the network whether the people on this run were already paid `
      + `(${(e as Error)?.message ?? String(e)}). Try again in a minute.`, { cause: e });
  }
  const first = reads[0];
  if (first === undefined) return made;
  const same = (r: AccountPaymentFacts): boolean => r.payKeyCommitment === first.payKeyCommitment && r.entries === first.entries
    && r.openRounds.length === first.openRounds.length && r.openRounds.every((x, i) => x === first.openRounds[i]);
  if (!reads.every(same)) {
    throw new RunNotReadHere('The chain changed while your wallet was reading it, so what it read cannot be taken as one '
      + 'reading. Try again in a minute.');
  }
  const wallet: WalletReadFacts = {
    payKeyCommitment: first.payKeyCommitment, asked, held: reads.flatMap((r) => [...r.held]),
    openRounds: [...first.openRounds], entries: first.entries,
  };
  return { ...made, wallet };
}

/**
 * **WHAT THE COMPANY'S RECORDS ACCOUNT FOR ON THE CHAIN**, for a raise of
 * `run`: every proposal they hold, by its identity on the chain; every leaf and
 * payment nonce of every leg of every run they hold, the nonces under the
 * company's pay-record key; and what `run`, if it was drawn as a repeat,
 * confirmed it repeats. Read from the records this device opened, never from
 * an answer the service made.
 */
async function whatTheRecordsAccountFor(
  records: CompanyRecordsHere, accountId: string, run: PayrollRun, viewingKey: Hex, read?: readonly SealedProposal[],
): Promise<RaisingHere> {
  const readProposals = records.proposals;
  if (readProposals === undefined) {
    throw new RunNotReadHere('This page cannot read the company\'s proposals, so it cannot raise a run. Reload the page to get '
      + 'the current version.');
  }
  const [proposals, runs, state] = await Promise.all([
    proposalsListedHere({ ...records, proposals: readProposals }, read), runsListedHere(records), signedStateHere(records, accountId, viewingKey)]);
  const opened = runs.filter((r) => r.accountId === accountId).map((r) => openedHere(r, viewingKey, 'one of the company\'s payroll runs'));
  const legs = opened.flatMap((r) => Object.values(r.payout ?? {}));
  return {
    period: run.period,
    knownRounds: proposals.filter((p: SealedProposal) => p.accountId === accountId).map((p) => p.chainId.toLowerCase()),
    knownLeaves: legs.flatMap((l) => l.leaves.map((x) => x.toLowerCase())),
    knownNonces: legs.flatMap((l) => (l.records ?? []).map((rec) => payRecordNonceOf(state.payKey as Hex, rec).toLowerCase())),
    ...(run.repeats === undefined ? {} : {
      confirmed: { of: [...run.repeats.of], ...(run.repeats.chainPayments === undefined ? {} : { chainPayments: run.repeats.chainPayments }) },
    }),
  };
}

/**
 * **THE ACCOUNT'S OWN FUNCTIONS A PAYROLL ROUND'S IDENTITY ON CHAIN IS MADE
 * WITH**: its payload, from the leg's root, payee count, window and the
 * approvals it needs; and its identity, from that payload, its vault and its
 * salt. Handed in by whoever holds the contract, because the page loads none.
 */
export interface RoundIdentity {
  readonly runPayload: (root: Uint8Array, payees: bigint, opensAt: bigint, closesAt: bigint, required: bigint) => Uint8Array;
  readonly proposalIdOf: (payload: Uint8Array, vault: Uint8Array, salt: Uint8Array) => Uint8Array;
}

const HEX64_LOWER = /^[0-9a-f]{64}$/u;
const WHOLE = /^(0|[1-9][0-9]*)$/u;

/**
 * **A PAYROLL RUN'S PROPOSAL, AS ITS SEALED PAYLOAD HOLDS WHAT ITS IDENTITY ON
 * CHAIN IS MADE FROM**: the leg's root and payee count, its window and the
 * approvals sealed beside them, its vault and its salt, and - for a run raised
 * since a run's salt was made from them - the head its raiser checked and the
 * random value. Undefined for a payload that cannot be opened here or holds
 * none of it. What each value is believed for is its reader's to say.
 */
interface RunSealedHere {
  readonly root: Hex; readonly payees: bigint; readonly opensAt: bigint; readonly closesAt: bigint; readonly required: bigint;
  readonly vault: Hex; readonly salt: Hex; readonly vouched?: Vouched;
}

const runSealedOf = (inside: { readonly vault?: unknown; readonly sealedPayload: Sealed }, viewingKey: Hex): RunSealedHere | undefined => {
  let payload: { window?: Record<string, unknown> | null; __required?: unknown; __change?: { salt?: unknown; vouched?: unknown } };
  try {
    payload = parseCanonical(unseal(inside.sealedPayload, viewingKey));
  } catch {
    return undefined;
  }
  const w = payload.window;
  if (w === undefined || w === null || typeof w !== 'object') return undefined;
  const whole = (v: unknown): bigint | null =>
    (typeof v === 'bigint' && v >= 0n ? v : typeof v === 'string' && WHOLE.test(v) ? BigInt(v) : null);
  const hex = (v: unknown): Hex | null => (typeof v === 'string' && HEX64_LOWER.test(v.toLowerCase()) ? v.toLowerCase() as Hex : null);
  const root = hex(w.root);
  const payees = whole(w.payees);
  const opensAt = whole(w.opensAt);
  const closesAt = whole(w.closesAt);
  /* Sealed only when not zero, as every raise seals it. */
  const required = payload.__required === undefined ? 0n : whole(payload.__required);
  const vault = hex(inside.vault);
  const salt = hex(payload.__change?.salt);
  if (root === null || payees === null || opensAt === null || closesAt === null || required === null || vault === null || salt === null) {
    return undefined;
  }
  const v = payload.__change?.vouched as Partial<Vouched> | undefined;
  const vouched = vouchedRefusal(v) === null ? { head: v!.head!.toLowerCase() as Hex, r: v!.r!.toLowerCase() as Hex } : undefined;
  return { root, payees, opensAt, closesAt, required, vault, salt, ...(vouched === undefined ? {} : { vouched }) };
};

/**
 * **WHEN A PAYROLL ROUND'S WINDOW CLOSES, AS ITS OWN SEALED PROPOSAL HOLDS
 * IT**, in seconds: the window sealed in the run's payload beside the leg's
 * root and payee count, believed only when those, with the approvals sealed
 * beside them, make the payload digest its filing names, and that digest with
 * its sealed vault and salt is its identity on chain - so it is the window the
 * chain would hold it to. Undefined for a round sealed without one, or whose
 * window does not make its identity. Never read from the run's record of its
 * leg, which names only the leg's latest round.
 */
export const roundClosesAtHere = (
  rec: Pick<SealedProposal, 'digest' | 'chainId'>, inside: { readonly vault?: unknown; readonly sealedPayload: Sealed },
  viewingKey: Hex, identity: RoundIdentity,
): bigint | undefined => {
  const r = runSealedOf(inside, viewingKey);
  if (r === undefined) return undefined;
  const digest = toHex(identity.runPayload(fromHex(r.root), r.payees, r.opensAt, r.closesAt, r.required));
  if (digest !== String(rec.digest).toLowerCase()) return undefined;
  const id = toHex(identity.proposalIdOf(fromHex(digest as Hex), fromHex(r.vault), fromHex(r.salt)));
  return id === String(rec.chainId).toLowerCase() ? r.closesAt : undefined;
};

/**
 * **A PAYROLL RUN THAT MAY VOUCH FOR A HEAD OF THE COMPANY'S RECORDS**, opened
 * here from its sealed proposal: its identity on chain, the proposal's own
 * record and the digest its entry names, and what its salt was made from. A
 * claim only: it vouches once its fields, with that head, make its identity
 * again by the account's own functions (`vouchedRunIdentityOf`) and the
 * proposal's record proves into a root checked forward from that head.
 */
export interface VouchedRunHere {
  readonly chainId: Hex;
  readonly proposal: string;
  readonly entryDigest: Hex;
  readonly run: RunSealedHere & { readonly vouched: Vouched };
}

/**
 * **EVERY PAYROLL RUN AMONG `chainIds` THAT SAYS WHAT HEAD IT WAS RAISED
 * OVER**, opened here with the company's viewing key from the proposals the
 * service serves: a leg's run only - a retry's salt names its leg's root, which
 * its proposal does not carry, so a retry vouches for nothing - and none of a
 * vault set up by a run that pays nothing.
 */
export const vouchedRunsHere = (
  proposals: readonly SealedProposal[], accountId: string, viewingKey: Hex, chainIds: readonly string[],
): VouchedRunHere[] => {
  const asked = new Set(chainIds.map((c) => c.toLowerCase()));
  const out: VouchedRunHere[] = [];
  for (const rec of proposals) {
    const chainId = String(rec.chainId).toLowerCase();
    if (rec.accountId !== accountId || !asked.has(chainId) || !HEX64_LOWER.test(chainId)) continue;
    let envelope: { kind: string; vault?: unknown; sealedPayload: Sealed };
    try {
      envelope = openRecord('proposals', rec.accountId, rec.sealed, viewingKey);
    } catch {
      continue;
    }
    if (envelope.kind !== 'payroll') continue;
    const run = runSealedOf(envelope, viewingKey);
    if (run?.vouched === undefined) continue;
    let retry: unknown;
    try { retry = (parseCanonical(unseal(envelope.sealedPayload, viewingKey)) as { retry?: unknown }).retry; } catch { continue; }
    if (retry !== undefined) continue;
    out.push({ chainId: chainId as Hex, proposal: rec.id, entryDigest: proposalEntry(accountId, rec as never).digest, run: run as VouchedRunHere['run'] });
  }
  return out;
};

/**
 * **WHETHER A ROUND THE CHAIN NEVER HELD CAN NO LONGER PAY**: its own window,
 * as its sealed proposal holds it (`roundClosesAtHere`), has closed. A round
 * the chain never held is live until then, since its proof may still be sent;
 * after it, no payment against it can land. A round with no window it can be
 * held to stays live.
 */
export const unheldPastItsWindow = (
  round: Pick<PayrollRound, 'raisedAt'> & { readonly closesAt?: bigint }, nowInSeconds: bigint,
): boolean => round.raisedAt === undefined && round.closesAt !== undefined && nowInSeconds >= round.closesAt;

/** What a round's liveness is judged at: the account's own functions its identity is made with, and this device's clock in seconds. */
interface RoundsAt { readonly identity: RoundIdentity; readonly nowInSeconds: bigint }

/**
 * The company's payroll rounds, each opened from its sealed record with the
 * viewing key, standing where the chain says (`proposalsListedHere`): one the
 * chain never held whose own window has closed (`unheldPastItsWindow`, at
 * this device's clock) is withdrawn, since nothing can pay against it any more.
 */
export const payrollRoundsHere = (
  proposals: readonly SealedProposal[], accountId: string, viewingKey: Hex,
  at: RoundsAt,
): PayrollRound[] =>
  proposals.flatMap((rec) => {
    if (rec.accountId !== accountId) return [];
    const inside = openRecord<{ kind: string; vault?: unknown; sealedPayload: Sealed }>('proposals', rec.accountId, rec.sealed, viewingKey);
    const round = payrollRoundOf({
      id: rec.id, kind: inside.kind, status: rec.status, chainId: rec.chainId, sealedPayload: inside.sealedPayload,
      ...(rec.raisedAt === undefined ? {} : { raisedAt: rec.raisedAt }),
    }, viewingKey);
    if (round === null) return [];
    /*
     * A payroll round leaves the account's open proposals only by being
     * withdrawn (`cancel`) or closed past its window (`closeExpiredRun`):
     * paying from it closes nothing. So a closed one is read as closed unpaid
     * whatever other calls its block held - the chain's history names every
     * call of the block, other proposals' and failed ones' too. What it paid is the chain's paid-once record's to say.
     */
    if (round.status === 'executed') return [{ ...round, status: 'cancelled' as const }];
    const closesAt = roundClosesAtHere(rec, inside, viewingKey, at.identity);
    return [unheldPastItsWindow({ ...round, ...(closesAt === undefined ? {} : { closesAt }) }, at.nowInSeconds)
      ? { ...round, status: 'cancelled' as const } : round];
  });
