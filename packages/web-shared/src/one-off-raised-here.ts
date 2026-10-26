/**
 * **A ONE-OFF PAYMENT FROM A VAULT, RAISED ON A SIGNER'S DEVICE, AND OFFERED TO
 * PAY ONCE APPROVED.**
 *
 * A one-off is a run with one payee: raised with the account's own `propose`,
 * approved like any run and paid by the vault's own payout. Raising it here: its
 * seed is made, and from it its one leaf, its root, its salt (a first payment's,
 * from the seed's fresh half) and its identity on the chain; the approvals its
 * band needs are read from the vault's spending policy; the vault is checked
 * here for what it can pay; the call is built; then its record is sealed under
 * the company's one-offs key and filed (`fileOneOffHere`, signed by this seat,
 * entered in the company's records), and its proposal filed and sent, naming the
 * record, and both are entered and anchored as a payroll raise ends. The service
 * is sent the sealed record, the signed proposal and the call, and nothing about
 * what is paid, to whom or why: no payments and no run.
 */
import type { KeysHeld } from '../../../src/core/company-key.js';
import { keyOf, sealingWith } from '../../../src/core/company-key.js';
import { assetIdBytes, assetIdHex, assets as theAssets, type AssetId } from '../../../src/core/assets.js';
import { canonical, signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import type { Privacy } from '../../../src/core/movement.js';
import type { PaymentsAmong } from '../../../src/core/ledger.js';
import { batchDigestOf, sealTransferProposal, signProposalFiling } from '../../../src/core/proposal-filing.js';
import { DEVICE_RAISE_VERSION } from '../../../src/core/device-raise.js';
import { refuseARunNoVaultCanPay } from '../../../src/core/run-raising.js';
import { refuseWhatTheVaultCannotPay } from '../../../src/core/vault-holdings.js';
import {
  newOneOffId, newOneOffSeed, ONE_OFF_KIND, ONE_OFF_VERSION, oneOffTidied, OneOffRefused, openOneOff, sealOneOff, type OneOffGiven, type OneOffOpened, type OneOffPayee,
} from '../../../src/midnight/one-off-record.js';
import { rootOfPayments } from '../../../src/midnight/payout-tree.js';
import { assemblePrivatePayments, type PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import { companyRecordEntry, proposalEntry } from '../../../src/midnight/record-manifest.js';
import { verifiedCompanyFiler, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { oneOffSaltOf } from '../../../src/midnight/run-keys.js';
import type { OpenedRound, RaiseRunOrder } from './governed-call-builder.js';
import type { RaiseDoors, RoundOnThePage } from './governed-call-on-device.js';
import {
  oneOffBuiltHere, oneOffOfTheProposalHere, oneOffsHere, type OneOffBelieved, type OneOffReadDoors, type OneOffRecords, type OneOffsHere,
} from './one-off-here.js';
import { FilingNotBelieved } from './http-sealed-pool-store.js';
import { seatThatMayFileHere } from './vault-page-doors.js';
import type { RecordsEntered } from './record-entered-here.js';
import { refuseWhatThePolicyWouldNotCharge } from './raise-checks-here.js';
import { signedStateHere, type CompanyRecordsHere } from './run-rebuilt-here.js';
import { approvalsItsBandNeeds, enteredAndAnchored, LegNotRaisedHere } from './run-raised-here.js';

/** What filing a one-off needs beyond reading one: the seat's signing secret, the store's filings, and where filings are entered. */
export interface OneOffFilingDoors extends Omit<OneOffReadDoors, 'open'> {
  readonly signingSecret: Hex;
  readonly records: OneOffRecords;
  readonly entered: RecordsEntered;
  /** The company key's epoch a filing names when `keys` is one bare key; a device's keys seal under the key in force. */
  readonly keyEpoch: number;
}

/** A one-off payment's record that was not filed, and why. Nothing was filed. */
export class OneOffNotFiled extends Error {
  constructor(why: string, options?: { cause?: unknown }) {
    super(`This one-off payment was not filed: ${why}.`, options);
    this.name = 'OneOffNotFiled';
  }
}

/** What a one-off says, written one way, so two records of it compare as text. */
const factsOf = (o: OneOffOpened): string => canonical({
  vault: o.vault, asset: o.asset, amount: o.amount.toString(), payee: o.payee, reason: o.reason, proposal: o.proposal,
  run: { opensAt: o.run.opensAt.toString(), closesAt: o.run.closesAt.toString(), required: o.run.required.toString() }, seed: o.seed,
});

/** This seat in the directory this device believes, if it may file a one-off (`seatThatMayFileHere`); otherwise why not. */
async function thisSeatHere(doors: Pick<OneOffFilingDoors, 'signingSecret' | 'directory'>): Promise<{ readonly seat: string } | string> {
  const mine = seatThatMayFileHere(await doors.directory(), signingPublicKeyOf(doors.signingSecret), ONE_OFF_KIND,
    'your seat\'s role on this company may not propose payments from a vault');
  return typeof mine === 'string' ? mine : { seat: mine.seat };
}

/** Whether `rec` is this seat's own filing of exactly this one-off. */
const mineAndTheSame = (doors: OneOffFilingDoors, rec: SealedCompanyRecord, given: OneOffOpened): boolean => {
  if (verifiedCompanyFiler(rec)?.toLowerCase() !== signingPublicKeyOf(doors.signingSecret).toLowerCase()) return false;
  try {
    return factsOf(openOneOff(rec, keyOf(doors.keys, rec.keyEpoch), doors.registry)) === factsOf(given);
  } catch {
    return false;
  }
};

/**
 * **FILES A ONE-OFF PAYMENT'S RECORD FROM THIS SEAT**, sealed under the
 * company's key in force for the one-offs purpose, and enters it in the
 * company's records. A one-off is filed once: the same seat filing the same
 * one-off again (a filing that was not entered, say) enters it again, and an id
 * another record holds is refused.
 */
export async function fileOneOffHere(
  doors: OneOffFilingDoors, input: { readonly id: string; readonly given: OneOffGiven },
): Promise<{ readonly state: 'filed' | 'entered-again'; readonly id: string; readonly version: number }> {
  const seat = await thisSeatHere(doors);
  if (typeof seat === 'string') throw new OneOffNotFiled(seat);
  let rec: SealedCompanyRecord;
  let given: OneOffOpened;
  try {
    const sealing = sealingWith(doors.keys, doors.keyEpoch);
    rec = sealOneOff({
      company: doors.accountId, id: input.id, keyEpoch: sealing.epoch, key: sealing.key, given: input.given,
      ...(doors.registry === undefined ? {} : { registry: doors.registry }),
    });
    given = openOneOff(rec, keyOf(doors.keys, rec.keyEpoch), doors.registry);
  } catch (e) {
    if (e instanceof OneOffRefused) throw new OneOffNotFiled(said(e), { cause: e });
    throw e;
  }
  let held: SealedCompanyRecord | null;
  try {
    held = await doors.records.at(ONE_OFF_KIND, input.id, ONE_OFF_VERSION);
  } catch (e) {
    if (!(e instanceof FilingNotBelieved)) throw new OneOffNotFiled(`this wallet could not check whether its record is already filed (${said(e)}). Press Pay again in a minute`, { cause: e });
    held = await doors.records.served(ONE_OFF_KIND, input.id).catch(() => null);
    if (held === null) throw new OneOffNotFiled(`a record is already filed under its number and this wallet cannot trust it (${said(e)}). Press Pay again in a minute`, { cause: e });
  }
  if (held !== null) {
    if (!mineAndTheSame(doors, held, given)) throw new OneOffNotFiled('another record is already filed under this id; raise it under a new one');
    await doors.entered.enter([companyRecordEntry(held)]);
    return { state: 'entered-again', id: input.id, version: held.version };
  }
  try {
    await doors.records.put(rec);
  } catch (e) {
    if ((e as Error)?.name === 'VaultPoolVersionAlreadyFiled') {
      throw new OneOffNotFiled('another record was filed under this id while this one was made; raise it under a new one', { cause: e });
    }
    throw e;
  }
  await doors.entered.enter([companyRecordEntry(rec)]);
  return { state: 'filed', id: input.id, version: rec.version };
}

/** The account's own functions a one-off's identity on the chain is made with. */
interface OneOffRunDeps {
  readonly runPayload: (root: Uint8Array, payees: bigint, opensAt: bigint, closesAt: bigint, required: bigint) => Uint8Array;
  readonly proposalIdOf: (payload: Uint8Array, vault: Uint8Array, salt: Uint8Array) => Uint8Array;
  readonly retrySaltOf: (legRoot: Uint8Array, fresh: Uint8Array) => Uint8Array;
  readonly noVault: () => Uint8Array;
}

/** What raising a one-off payment needs of this device. */
export interface OneOffRaiseDoors extends RaiseDoors {
  readonly records: CompanyRecordsHere & { readonly oneOffs: OneOffsHere };
  /** Where the one-off's record is filed, and the newest version as served, unjudged, to resume a filing from. */
  readonly oneOffFiling: Pick<OneOffRecords, 'put' | 'served'>;
  readonly filing: { readonly seat: string; readonly keyEpoch: number; readonly newId: () => string };
  readonly runs: OneOffRunDeps;
  readonly recorded: { readonly entered: RecordsEntered; readonly anchor: () => Promise<unknown> };
  readonly now?: () => Date;
}

/** A one-off payment as it is asked for. */
export interface OneOffAsked {
  readonly vault: string;
  readonly asset: AssetId;
  readonly amount: bigint;
  readonly form: Privacy;
  readonly payee: OneOffPayee;
  readonly reason: string;
  /** Its window, in seconds since the Unix epoch. */
  readonly opensAt: bigint;
  readonly closesAt: bigint;
}

const hex = (b: Uint8Array): Hex => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') as Hex;
const bytes = (h: string): Uint8Array => Uint8Array.from(h.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));
const said = (e: unknown): string => String((e as Error)?.message ?? e);

/** A summary every one-off's proposal carries alike: what it pays, to whom and why are in its record. */
const SUMMARY = 'One-off payment from a vault';

/**
 * **RAISES A ONE-OFF PAYMENT FROM THIS DEVICE**, as the module says, and answers
 * where it stands. Refused before anything is filed or sent when the one-off is
 * not one its record can hold, its window is past or names no vault, the vault's
 * policy would not charge it, or the vault cannot pay it.
 */
export async function raiseOneOffHere(doors: OneOffRaiseDoors, input: OneOffAsked & { readonly viewingKey: KeysHeld }): Promise<RoundOnThePage> {
  const { records, accountId, service } = doors;
  if (!service.file) throw new LegNotRaisedHere('This page cannot write proposals down. Reload the page to get the current version');
  const registry = doors.assets ?? records.oneOffs.registry ?? records.registry ?? theAssets;
  const key = input.viewingKey;
  const vault = String(input.vault).toLowerCase() as Hex;
  const seed = newOneOffSeed();
  const proposalId = doors.filing.newId();
  const draft = (chainId: Hex, required: bigint) => ({
    vault, asset: input.asset, amount: input.amount, form: input.form, payee: input.payee, reason: input.reason,
    proposal: { id: proposalId, chainId }, run: { opensAt: input.opensAt, closesAt: input.closesAt, required }, seed,
  });
  let tidied: ReturnType<typeof oneOffTidied>;
  try {
    tidied = oneOffTidied(draft('00'.repeat(32) as Hex, 0n), registry);
  } catch (e) {
    if (e instanceof OneOffRefused) throw new LegNotRaisedHere(e.message);
    throw e;
  }
  const { secrets, tree } = oneOffBuiltHere(tidied, records.oneOffs);
  const root = tree.tree.root;
  const window = { opensAt: input.opensAt, closesAt: input.closesAt };
  const now = (doors.now ?? (() => new Date()))();
  try {
    refuseARunNoVaultCanPay({ root, vault, ...window }, hex(doors.runs.noVault()), BigInt(Math.floor(now.getTime() / 1000)));
  } catch (e) {
    throw new LegNotRaisedHere(said(e));
  }
  const { required, policy } = await approvalsItsBandNeeds(doors, key, { vault, asset: tidied.asset, total: tidied.amount, window });
  try {
    refuseWhatThePolicyWouldNotCharge(policy, tidied.amount, required, 'one-off');
  } catch (e) {
    throw new LegNotRaisedHere(said(e));
  }
  doors.progress?.('checking-the-vault');
  await refuseWhatTheVaultCannotPay(doors.holdings, {
    vault, asset: registry.require(tidied.asset), total: tidied.amount, payees: 1n,
    payments: [{ payee: { kind: tidied.paidTo.kind }, token: tidied.token, amount: tidied.amount }],
  }, ['shielded', 'unshielded']);

  const salt = oneOffSaltOf(secrets, doors.runs.retrySaltOf);
  const digest = hex(doors.runs.runPayload(bytes(root), 1n, window.opensAt, window.closesAt, BigInt(required)));
  const chainId = hex(doors.runs.proposalIdOf(bytes(digest), bytes(vault), bytes(salt)));
  const sealing = sealingWith(key, doors.filing.keyEpoch);
  const oneOffId = newOneOffId();
  const change = { asset: tidied.asset, amount: tidied.amount, batchDigest: batchDigestOf([]), salt };
  const proposal = signProposalFiling(accountId, {
    id: proposalId, digest, chainId, keyEpoch: sealing.epoch, createdAt: now.toISOString(),
    sealed: sealTransferProposal({
      accountId, viewingKey: sealing.key, vault, summary: SUMMARY, oneOff: { id: oneOffId, version: 1 }, change,
      proposedBy: doors.filing.seat,
    }),
  }, doors.material.signingSecret as Hex);
  const assetBlinding = (await signedStateHere(records, accountId, key)).assetBlinding;
  const named = { assetId: assetIdBytes(tidied.asset) };
  const assetId = hex(named.assetId);
  const opened: OpenedRound = {
    chainId, digest, vault, salt, summary: SUMMARY,
    half: { assetId, changeAmount: String(change.amount), changeBatchDigest: change.batchDigest },
    made: {
      kind: 'transfer', asset: tidied.asset, facts: { payee: tidied.paidTo, token: tidied.token, amount: tidied.amount }, seed,
      opensAt: String(window.opensAt), closesAt: String(window.closesAt), required,
    },
  };
  const order: RaiseRunOrder = {
    circuit: 'propose',
    run: { root, payees: '1', opensAt: String(window.opensAt), closesAt: String(window.closesAt), vault, required },
    half: { assetId, assetBlinding, proposalSalt: salt, changeAmount: opened.half!.changeAmount, changeBatchDigest: change.batchDigest },
    proposal: chainId,
  };
  doors.progress?.('reading-the-chain');
  const chain = await service.callState(accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({ account: chain.account, material: doors.material, chain, opened, order });
  doors.progress?.('writing-down');
  await fileOneOffHere({
    accountId, directory: records.directory, records: { at: records.oneOffs.at, ...doors.oneOffFiling }, keys: key,
    signingSecret: doors.material.signingSecret as Hex, entered: doors.recorded.entered, keyEpoch: doors.filing.keyEpoch, registry,
  }, { id: oneOffId, given: draft(chainId, BigInt(required)) });
  doors.progress?.('sending');
  const filed = [proposalEntry(accountId, proposal)];
  let round: RoundOnThePage;
  try {
    round = await service.file(accountId, { proposal, tx, version: DEVICE_RAISE_VERSION, salt, vault });
  } catch (e) {
    /* Written down and not sent is still written down: its filer enters it, as a payroll raise does. */
    await doors.recorded.entered.enter(filed).catch(() => undefined);
    throw e;
  }
  return enteredAndAnchored(doors, round, filed);
}

/**
 * **WHAT A VAULT IS HANDED TO PAY AN APPROVED ONE-OFF PAYMENT**, made again here
 * from its record: its one payment over its one-leaf tree, under its proposal's
 * identity and salt, with the approvals it was raised needing; offered only for a
 * `transfer` proposal whose own sealed body names that record, tied both ways
 * (`oneOffOfTheProposalHere`), and when the tree made here names exactly that
 * proposal. For the vault's own payment call (`payPrivatelyFromCompanyVault`,
 * `payPubliclyFromCompanyVault`), after the charge when its vault has a spending
 * policy (`chargeTheRunHere`).
 */
export async function oneOffToPayHere(
  records: Pick<CompanyRecordsHere, 'directory' | 'oneOffs' | 'proposals'>, accountId: string, viewingKey: KeysHeld, proposalId: string,
  deps: Pick<OneOffRunDeps, 'runPayload' | 'proposalIdOf' | 'retrySaltOf'> & {
    readonly paidAmong: (leaves: readonly Hex[]) => Promise<PaymentsAmong | null>;
  },
): Promise<{ readonly order: PrivatePaymentOrderOnTheWire; readonly proposalId: string }> {
  const { believed } = await oneOffsHere(records, accountId);
  let found: OneOffBelieved | null;
  try {
    found = await oneOffOfTheProposalHere(records, accountId, viewingKey, proposalId, believed);
  } catch (e) {
    if (e instanceof OneOffRefused) throw new LegNotRaisedHere(e.message);
    throw e;
  }
  if (found === null) throw new LegNotRaisedHere('The company\'s records hold no one-off payment raised by that proposal, so there is nothing to pay');
  const { oneOff: o, secrets, tree } = found;
  const salt = oneOffSaltOf(secrets, deps.retrySaltOf);
  const facts = { payee: o.paidTo, token: o.token, amount: o.amount };
  const leaves = [...tree.tree.leaves];
  const paid = await deps.paidAmong(leaves);
  const assembled = assemblePrivatePayments({
    order: {
      asset: assetIdHex(o.asset).toLowerCase(), form: o.paidTo.kind, vault: o.vault, proposal: o.proposal.chainId, salt,
      root: tree.tree.root, payees: 1n, opensAt: o.run.opensAt, closesAt: o.run.closesAt,
    },
    leaves, window: { from: o.run.opensAt, until: o.run.closesAt },
    idFrom: (made, w) => hex(deps.proposalIdOf(
      deps.runPayload(bytes(rootOfPayments(made, [facts], o.asset)), 1n, w.from, w.until, o.run.required), bytes(o.vault), bytes(salt))),
    built: tree, facts: [facts],
    paid: paid?.known === true ? new Set(paid.paid) : null,
  });
  if ('refusal' in assembled) throw new LegNotRaisedHere(assembled.refusal.replace(/ Nothing was sent\.$/u, ''));
  return {
    order: o.run.required === 0n ? assembled.order : { ...assembled.order, required: o.run.required.toString() },
    proposalId: o.proposal.id,
  };
}
