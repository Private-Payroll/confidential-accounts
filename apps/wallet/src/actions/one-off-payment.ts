import type { ActIntent } from 'midnight-identity/profile/request';
import { readVaultAddress } from 'midnight-identity/profile/company-label';
import { assets as theAssets, formatAmount, type AssetId, type AssetRegistry } from '../../../../src/core/assets.js';
import { fromHex, signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import { privacyOf } from '../../../../src/core/movement.js';
import { newProposalId } from '../../../../src/core/proposal-filing.js';
import { recordsKeypairFrom } from '../../../../src/midnight/company-nonce-secret.js';
import { newOneOffSeed, oneOffTidied, OneOffRefused, type OneOffOpened } from '../../../../src/midnight/one-off-record.js';
import { payeeOf } from '../../../../src/midnight/payee-address.js';
import type { NetworkName } from '../../../../src/midnight/network.js';
import { periodOf, periodWindowOf } from '../../../../src/midnight/spending-policy-record.js';
import type { RoundOnChain } from '../../../../packages/web-shared/src/governed-call-builder.js';
import {
  ApprovalNotOwed, governedCallServiceFor, theRoundAsked, nothingWasSentBy, notEnoughApprovalsYet, type GovernedCallDoors, type RoundOnThePage,
} from '../../../../packages/web-shared/src/governed-call-on-device.js';
import type { AccountGovernance } from 'midnight-identity/profile/records-key';
import { HttpCompanyRecordStore } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import { oneOffRaisedByHere, refuseAOneOffToAnotherVendorHere } from '../../../../packages/web-shared/src/one-off-here.js';
import { oneOffToPayHere, type OneOffAsked, type OneOffRaiseDoors } from '../../../../packages/web-shared/src/one-off-raised-here.js';
import { approveWith, chargeWith, raiseOneOffWith, spendingPolicyWith } from '../../../../packages/web-shared/src/one-off-in-the-wallet.js';
import { ChargeNotYetSeen, type ChargeDoors, type ChargesInFlight } from '../../../../packages/web-shared/src/run-charged-here.js';
import { LegNotRaisedHere } from '../../../../packages/web-shared/src/run-raised-here.js';
import type { CompanyRecordsHere } from '../../../../packages/web-shared/src/run-rebuilt-here.js';
import { deviceVaultHoldings } from '../../../../packages/web-shared/src/device-vault-holdings.js';
import {
  payPrivatelyFromCompanyVault, payPubliclyFromCompanyVault, PaymentLandedUnrecorded, PaymentNotAsBuilt, PaymentNotYetSeen,
  PaymentStillInFlight, PublicPaymentNotYetSeen, seatHereIn, vaultNotesHere, wireOf, type PaymentsInFlight, type PayoutDoors, type SecretKeptHere,
} from '../../../../packages/web-shared/src/vault-operation.js';
import { browserChargesInFlight, browserInFlightRecords, browserPaymentsInFlight } from '../../../../packages/web-shared/src/in-flight-in-this-browser.js';
import {
  deviceRecordsFor, deviceSignerFrom, readersIn, vaultServiceFor,
} from '../../../../packages/web-shared/src/vault-page-doors.js';
import { coinsKeptOnThisDevice, type CoinsKeptHere } from '../../../../packages/web-shared/src/vault-coins-kept-here.js';
import type { InFlightOpener } from '../../../../packages/web-shared/src/in-flight-on-this-device.js';
import { SealedNotePool } from '../../../../src/midnight/vault-pool.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { NETWORK } from 'midnight-identity/network';
import {
  companyReachFor, companyRecordsFor, enteredFor, handOverMarked, keptReach, paidAmongFor, pureCircuits, type CompanyChain, type CompanyReach,
  type CompanyRecordsInTheWallet, type PureCircuits,
} from './company-reach.js';
import { anchorDoorsIn, anchoredAtTheEnd, rebuildDoorsIn, UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';
import { StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';
import { approveStep, approving, atTheBar, type Approving, type ApprovalStop, type ProposalKind, type ReadCompany } from './proposal-kinds.js';
import { signerMaterialOf } from '../../../../packages/web-shared/src/private-state.js';

/*
 * A ONE-OFF PAYMENT OUT OF A COMPANY'S VAULT, MADE IN THE WALLET: one window and one passkey. The wallet raises the
 * proposal, seals the one-off's record to the signers under the company key and files it, and, once the chain it reads
 * through its own indexer shows the approvals the proposal needs, charges it to the vault's period (when the vault has a
 * spending policy) and pays it, privately or publicly as the payee's address decides. Asked with a proposal already
 * raised and the payment it should be, it approves through the one approval for every kind of proposal (`approveStep`,
 * with the one-off kind, `oneOffKind`): it refuses the proposal's record unless it is that payment, gives this seat's
 * approval where it is still owed and the chain shows the proposal short of the approvals the account needs, then
 * charges and pays it the same way, as far as the company's account accepts. Every answer from the service is
 * a claim: the proposal's standing, the policy, the payments made and the vault's holdings are read from the chain and
 * from records this wallet opens itself. The proposal carries no amount, payee or name, and the record carries them only
 * sealed to the signers; a public payment's own transaction shows them on the chain, as every public payment does.
 */

/** What the one-off payment needs beyond the company: the chain and builder the other vault actions use. */
export interface OneOffPaymentReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly now: () => number;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The vault secrets this wallet keeps for the person, which a private payment out is made with. */
  readonly secrets: (person: string) => SecretKeptHere;
  /** A test's own company read; the wallet reads it from the saved keys and the chain. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
  /** Where a payment and a charge on their way are kept on this device; the wallet's own storage unless given. */
  readonly kept?: (opener: InFlightOpener) => { readonly payments: PaymentsInFlight; readonly charges: ChargesInFlight; readonly coins?: CoinsKeptHere };
  /** The currencies a payment may be made in; the product's own unless given. */
  readonly assets?: AssetRegistry;
  /** The network a typed-in address must be on; this wallet's own unless given. */
  readonly network?: NetworkName;
  /** How long and how often the wallet waits for the chain to show the proposal, in milliseconds. */
  readonly waitMs?: number;
  readonly everyMs?: number;
}

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.one-off-payment.why.${key}`, ...(values === undefined ? {} : { values }),
});

/** Where the payment got to, as the action's end tells the page. */
export const ONE_OFF_STATE = {
  raised: 'raised', approved: 'approved', awaitingApprovals: 'awaiting-approvals', charged: 'charged', paid: 'paid', alreadyPaid: 'already-paid',
} as const;

/** Whether the payment was charged to the vault's period: charged now, charged already, or none owed because the vault has no policy or it was paid. */
export const ONE_OFF_CHARGE = { charged: 'charged', already: 'already-charged', none: 'none' } as const;

const HEX64 = /^[0-9a-f]{64}$/u;
const WINDOW_BEFORE_S = 300n;
const WINDOW_LONGEST_S = 7n * 86_400n;
const WAIT_MS = 10 * 60_000;
const EVERY_MS = 6_000;
const said = (e: unknown): string => String((e as Error)?.message ?? e);

/* The refusals that mean the proposal's record can never be the payment shown (another vault, currency, filer, vendor address or keys); a record not found yet is not among them. */
const NEVER_MATCHES = new RegExp([
  'another one-off payment, or another version', 'raised by another proposal', 'paid from another vault', 'paid in another currency',
  'filed by another seat', 'pays another address than the vendor', 'pays other keys than the vendor',
].join('|'), 'u');

/**
 * The payment the page asks for, read from its fields: the vault, the currency, the amount, the payee's address and
 * name, the vendor entry it pays if it names one, and the reason, with the form the address decides, each as the record's own rules (`oneOffTidied`) tidy it.
 * Returns the words of the refusal when any of it is not one a one-off payment can carry; those rules decide, never a
 * second statement of them here.
 */
export function oneOffAskedOf(
  intent: ActIntent, network: NetworkName = NETWORK, registry: AssetRegistry = theAssets,
): Omit<OneOffAsked, 'opensAt' | 'closesAt'> | Words {
  const f = intent.fields;
  const vault = readVaultAddress(f['vault']);
  if (vault === null) return why('not-a-vault');
  if (f['token'] === undefined || !HEX64.test(f['token'])) return why('not-a-currency');
  if (f['amount'] === undefined || !/^[1-9][0-9]*$/u.test(f['amount'])) return why('nothing');
  const address = (f['payee'] ?? '').trim();
  let form: 'private' | 'public';
  try {
    form = privacyOf(payeeOf(address, network));
  } catch (e) {
    return why('payee', { says: said(e) });
  }
  const given = {
    vault: vault as string, asset: f['token'] as AssetId, amount: BigInt(f['amount']), form,
    payee: { ref: f['vendor'] ?? null, name: f['payeeName'] ?? null, address, network }, reason: f['reason'] ?? '',
  };
  let tidied: OneOffOpened;
  try {
    tidied = oneOffTidied({
      ...given, vault: given.vault as Hex, proposal: { id: newProposalId(), chainId: '00'.repeat(32) as Hex },
      run: { opensAt: 0n, closesAt: 1n, required: 0n }, seed: newOneOffSeed(),
    }, registry);
  } catch (e) {
    if (e instanceof OneOffRefused) return why('not-a-payment', { says: e.message });
    throw e;
  }
  return { vault: tidied.vault, asset: tidied.asset, amount: tidied.amount, form: tidied.form, payee: tidied.payee, reason: tidied.reason };
}

/**
 * Why the one-off's own record, opened by this wallet, is not the payment the window showed as the page's words, or
 * null when every fact matches: the vault, the currency, the amount, the payee's address and name, the vendor entry it
 * names or that it names none, and the reason.
 */
export const notAsShown = (shown: Omit<OneOffAsked, 'opensAt' | 'closesAt'>, record: Pick<OneOffOpened, 'vault' | 'asset' | 'amount' | 'payee' | 'reason'>): string | null => {
  if (record.vault.toLowerCase() !== shown.vault.toLowerCase()) return 'it pays from another vault';
  if (record.asset.toLowerCase() !== shown.asset.toLowerCase()) return 'it pays in another currency';
  if (record.amount !== shown.amount) return 'it pays another amount';
  if (record.payee.address !== shown.payee.address) return 'it pays another address';
  if ((record.payee.ref ?? null) !== (shown.payee.ref ?? null)) return 'it names another vendor entry';
  if ((record.payee.name ?? null) !== (shown.payee.name ?? null)) return 'it names the payee otherwise';
  if (record.reason !== shown.reason) return 'it gives another reason';
  return null;
};

const keptInTheWallet = (opener: InFlightOpener) => ({
  payments: browserPaymentsInFlight(opener),
  charges: browserChargesInFlight(opener),
  coins: coinsKeptOnThisDevice(browserInFlightRecords(), opener),
});

/**
 * Everything charging and paying out of the vault needs, from this wallet's own reads: the vault's pool opened with this
 * seat, the chain through its own indexer, the vault's secret it keeps, and the calls that send the charge, a payment
 * and a merge - through the service, or straight to the chain (`handOverFor`) - each marking `handed` once it hands a
 * transaction over. Records it files are signed with this seat's key
 * here; the page only carries them. A one-off and a payroll run (`pay-run.ts`) are paid through these same doors.
 */
export function payDoorsFor(
  ctx: StepContext, r: CompanyReach, reach: OneOffPaymentReach, handed: Handed = { over: false },
): PayoutDoors & ChargeDoors & { readonly paidYet: () => Promise<boolean | null> } {
  const person = ctx.person ?? (() => { throw new StepRefused(why('no-person')); })();
  const me = deviceSignerFrom(r.leaf, r.companyKey);
  const opener = { signerId: me.signerId, wrappingSecret: me.wrappingSecret };
  const kept = (reach.kept ?? keptInTheWallet)(opener);
  const directory = r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const judge = r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const base = vaultServiceFor(r.api, r.accountId, r.roster);
  return {
    sleep: (ms) => reach.pause(ms, ctx.signal),
    service: {
      ...base,
      keys: async () => { throw new Error('a payment out of a vault reads no readers from the service.'); },
      payout: (vault, tx) => { handed.over = true; return base.payout(vault, tx); },
      payoutPublicly: (vault, tx) => { handed.over = true; return base.payoutPublicly(vault, tx); },
      merge: (vault, tx) => { handed.over = true; return base.merge(vault, tx); },
    },
    account: r.account,
    onChain: async () => ({ holders: await r.holders() }),
    builder: r.builder,
    indexer: async () => r.chain.indexer,
    me,
    myRecordsKey: recordsKeypairFrom(fromHex(r.companyKey)).publicKey as Hex,
    signers: readersIn(directory).signers,
    records: deviceRecordsFor(r.seat.signingSecret, judge, () => person, enteredFor(r), r.send),
    ...(kept.coins === undefined ? {} : { kept: kept.coins }),
    secretKeptHere: reach.secrets(person),
    inFlight: kept.payments,
    seatHere: () => seatHereIn(directory, r.seat.signingSecret),
    now: () => new Date(reach.now()),
    charge: (id, body) => { handed.over = true; return governedCallServiceFor(r.api).charge!(id, body); },
    filer: signingPublicKeyOf(r.seat.signingSecret).toLowerCase() as Hex,
    chargesInFlight: kept.charges,
    paidYet: async () => null,
    handOver: handOverMarked(r.handOver, handed),
  };
}

/** Whether a step has handed a transaction to the page to send: a stop after that is never told as nothing sent. */
interface Handed { over: boolean }

/**
 * The governed-call doors of this seat: the service's calls (each that hands a transaction over marks `handed`), this
 * wallet's builder, the chain read at one block by this wallet, and where each finished call goes (`handOverFor`).
 */
export const governedDoorsFor = (
  ctx: StepContext, r: CompanyReach, reach: OneOffPaymentReach, records: CompanyRecordsHere, handed: Handed = { over: false },
): GovernedCallDoors => {
  const service = governedCallServiceFor(r.api);
  return {
    service: {
      ...service,
      file: (accountId, body) => { if (body.tx !== undefined) handed.over = true; return service.file!(accountId, body); },
      approve: (id, body) => { handed.over = true; return service.approve(id, body); },
      send: (id, body) => { handed.over = true; return service.send(id, body); },
      callState: async () => {
        const chain = await r.chain.callState(r.account);
        if (chain === null) throw new Error('this wallet could not read the company\'s account at one block, so nothing was built or sent.');
        return { ...chain, account: r.account };
      },
    },
    builder: r.builder,
    material: signerMaterialOf(r.seat),
    accountId: r.accountId,
    records,
    leaves: r.judges.leavesFor(r.account),
    handOver: handOverMarked(r.handOver, handed),
    sleep: (ms) => reach.pause(ms, ctx.signal),
    ...(reach.waitMs === undefined ? {} : { waitMs: reach.waitMs }),
    ...(reach.everyMs === undefined ? {} : { everyMs: reach.everyMs }),
  };
};

/**
 * The raise's doors: the governed-call doors, the vault's holdings as this device reads its pool and the chain, the
 * one-off's record filed signed with this seat's key, the account's pure circuits, and the anchor of what was filed.
 * A pool that a seat which left filed past its boundary, or one the chain contradicts, is filed again from here before
 * the payment is fitted (`vaultNotesHere`), so a payment is never refused only because no balance read came first.
 * What the re-file found is held against the payment only when it could not file the vault again, and then with why;
 * the pool it filed is still checked against the chain.
 */
export function raiseDoorsFor(
  ctx: StepContext, r: CompanyReach, reach: OneOffPaymentReach, records: CompanyRecordsInTheWallet, pure: PureCircuits,
  handed: Handed = { over: false },
): OneOffRaiseDoors {
  const pay = payDoorsFor(ctx, r, reach);
  const judge = r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const filing = new HttpCompanyRecordStore(r.accountId, r.send, r.seat.signingSecret as Hex, judge);
  const pool = new SealedNotePool(pay.records('pool'), { signerId: pay.me.signerId, wrappingSecret: pay.me.wrappingSecret }, pay.signers);
  return {
    ...governedDoorsFor(ctx, r, reach, records, handed),
    records,
    holdings: deviceVaultHoldings({
      chain: async (v) => r.builder.vaultOnChain({ vault: v, indexer: r.chain.indexer }),
      pool: async (v) => ((await pay.records('pool').get(v)) === null ? null : (await pool.load(v)).notes),
      heldCommitmentOf: async (v, note) => (await r.builder.commitments({ vault: v, coin: wireOf(note) })).held,
      paymentsFit: (notes, payments) => r.builder.paymentsFit({
        notes: notes.map(wireOf), payments: payments.map((p) => ({ token: p.token, amount: p.amount.toString() })),
      }),
      fileAgain: async (v) => {
        const rebuilt = await vaultNotesHere(rebuildDoorsIn(ctx, r, r.api, r.send, { coins: () => pay.kept }), v);
        const cured = rebuilt.of === 'as-filed' || rebuilt.of === 'filed';
        return {
          answer: 'the-newest', said: cured ? [] : [...(rebuilt.leaver ?? []), ...rebuilt.said],
          ...(rebuilt.of === 'not-read' ? {} : { notes: rebuilt.notes }),
        };
      },
    }),
    assets: records.registry!,
    oneOffFiling: { put: (rec) => filing.put(rec), served: async () => null },
    filing: { seat: r.leaf, keyEpoch: r.companyKeys.epoch, newId: () => newProposalId() },
    runs: { runPayload: pure.account.runPayload, proposalIdOf: pure.account.proposalIdOf, retrySaltOf: pure.account.retrySaltOf, noVault: pure.account.noVault },
    recorded: { entered: enteredFor(r), anchor: async () => anchoredAtTheEnd(await anchorDoorsIn(r, r.api)) },
    now: () => new Date(reach.now()),
  };
}

/**
 * The window a one-off is paid inside, set by the wallet: from five minutes before now to the earlier of a week from
 * now and the end of the vault's policy period holding now. Under a spending policy it opens no earlier than that
 * period's start, so the whole window lies in the one period the chain charges it to.
 */
export async function oneOffWindowFor(
  records: CompanyRecordsHere, r: Pick<CompanyReach, 'accountId' | 'companyKeys'>, payment: { readonly vault: string; readonly asset: AssetId }, nowMs: number,
): Promise<{ readonly opensAt: bigint; readonly closesAt: bigint }> {
  const now = BigInt(Math.floor(nowMs / 1000));
  let opensAt = now - WINDOW_BEFORE_S;
  let closesAt = now + WINDOW_LONGEST_S;
  const standing = await spendingPolicyWith(records, r.accountId, r.companyKeys, payment);
  if (standing.state === 'set') {
    const period = periodOf(standing.policy, { opensAt: now, closesAt: now + 1n });
    if (period !== null) {
      const holding = periodWindowOf(standing.policy, period);
      if (holding.from > opensAt) opensAt = holding.from;
      if (holding.until < closesAt) closesAt = holding.until;
    }
  }
  return { opensAt, closesAt };
}

/**
 * The approvals the account needs before it charges or pays a one-off: the higher of what its hold took at the raise and
 * the vault's bar now, plus one for every signer removed or replaced since the raise (`requireApprovedForVault`); null
 * when the chain shows no hold. The account's own refusal when it is built (`notEnoughApprovalsYet`) still decides.
 */
export const oneOffNeeded = (round: RoundOnChain, held: AccountGovernance, vault: string): number | null => {
  if (round.needed === undefined) return null;
  const bar = held.vaultThresholds.find((v) => v.vault.toLowerCase() === vault.toLowerCase())?.threshold ?? held.approvals;
  return Math.max(round.needed, bar) + (round.removals ?? 0);
};

/** Polls where the proposal stands on the chain, through this wallet's indexer, until `seen` holds; null when it never does in time. */
async function untilTheChainShows(
  ctx: StepContext, records: CompanyRecordsHere, reach: OneOffPaymentReach, chainId: string, seen: (r: RoundOnChain) => boolean,
): Promise<RoundOnChain | null> {
  const id = chainId.toLowerCase();
  const waitMs = reach.waitMs ?? WAIT_MS;
  const everyMs = reach.everyMs ?? EVERY_MS;
  for (let waited = 0; ; waited += everyMs) {
    const now = (await records.roundsOnChain!([id]))[id];
    if (now !== undefined && seen(now)) return now;
    if (waited >= waitMs) return null;
    await reach.pause(everyMs, ctx.signal);
  }
}

/** A refusal after anything may have been handed over says so; one before says nothing was sent. */
const refusedAfter = (e: unknown, handed: Handed, nothingSent: string, maybeSent: string): never => {
  if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
  throw new StepRefused(why(!handed.over || nothingWasSentBy(e) ? nothingSent : maybeSent, { says: said(e) }));
};

/** The one-off's words for each stop of the one approval. */
const oneOffWhy = (stop: ApprovalStop, values?: Readonly<Record<string, string | number>>): Words =>
  why(({ 'not-raised': 'raise-not-seen', 'may-be-sent': 'approval-may-be-sent', withdrawn: 'closed', counted: 'closed' } as Record<string, string>)[stop] ?? stop, values);

/** The lines of what the one-off pays, as the page names it. */
const paymentShown = (intent: ActIntent, network: NetworkName, registry: AssetRegistry): ShownLine[] => {
  const f = intent.fields;
  const asked = oneOffAskedOf(intent, network, registry);
  const form = 'key' in asked ? null : asked.form;
  const asset = f['token'] === undefined || !HEX64.test(f['token']) ? null : registry.find(f['token'] as AssetId);
  const raw = { amount: f['amount'] ?? '', token: f['token'] ?? '' };
  return [
    asset === null || !/^[0-9]+$/u.test(raw.amount)
      ? { key: 'act.one-off-payment.shown.amount-raw', values: raw, from: 'page' as const }
      : { key: 'act.one-off-payment.shown.amount', values: { shown: formatAmount(BigInt(raw.amount), asset), symbol: asset.symbol, name: asset.name, ...raw }, from: 'page' as const },
    { key: 'act.one-off-payment.shown.payee', values: { payee: f['payee'] ?? '' }, from: 'page' as const },
    ...(f['vendor'] === undefined ? [] : [{ key: 'act.one-off-payment.shown.vendor', values: { vendor: f['vendor'] }, from: 'page' as const }]),
    ...(f['payeeName'] === undefined ? [] : [{ key: 'act.one-off-payment.shown.name', values: { name: f['payeeName'] }, from: 'page' as const }]),
    { key: 'act.one-off-payment.shown.reason', values: { reason: f['reason'] ?? '' }, from: 'page' as const },
    { key: 'act.one-off-payment.shown.vault', values: { vault: f['vault'] ?? '' }, from: 'page' as const },
    ...(form === null ? [] : [{ key: `act.one-off-payment.shown.${form}`, from: 'action' as const }]),
  ];
};

/**
 * Charges the approved one-off to its vault's period (when the vault has a spending policy), then pays it, once the
 * chain shows it at the approvals the account needs; short of them it says so and sends nothing.
 */
function oneOffCarry(reach: OneOffPaymentReach, read: ReadCompany, here: Approving): readonly ActionStep[] {
  const charge: ActionStep = {
    title: { key: 'act.one-off-payment.step.charge' },
    notNeeded: (said) => said['state'] === ONE_OFF_STATE.awaitingApprovals || said['charge'] === ONE_OFF_CHARGE.none,
    run: async (ctx) => {
      if (here.round === null || here.standing === null) throw new StepRefused(why('closed'));
      if (!atTheBar(here.standing, here.needed)) {
        here.short = true;
        ctx.tell({ state: ONE_OFF_STATE.awaitingApprovals });
        return;
      }
      const r = await read.at(ctx);
      const pure = await pureCircuits();
      const records = companyRecordsFor(r, reach, pure);
      const handed: Handed = { over: false };
      const standing = here.standing;
      try {
        const toPay = await oneOffToPayHere(records, r.accountId, r.companyKeys, here.round.id, {
          runPayload: pure.account.runPayload, proposalIdOf: pure.account.proposalIdOf, retrySaltOf: pure.account.retrySaltOf,
          paidAmong: paidAmongFor(records, pure),
        });
        if (toPay.order.payments[0]?.paid === true) {
          here.paid = true;
          ctx.tell({ charge: ONE_OFF_CHARGE.none });
          return;
        }
        const charged = await chargeWith({ ...payDoorsFor(ctx, r, reach, handed), records, accountId: r.accountId }, r.companyKeys, toPay);
        if (charged.state === 'charged') ctx.tell({ state: ONE_OFF_STATE.charged, charge: ONE_OFF_CHARGE.charged });
        else ctx.tell({ charge: charged.state === 'no-policy' ? ONE_OFF_CHARGE.none : ONE_OFF_CHARGE.already });
      } catch (e) {
        if (e instanceof LegNotRaisedHere) throw new StepRefused(why('not-found', { says: e.message }));
        if (e instanceof ChargeNotYetSeen) throw new StepRefused(why('charge-not-seen'));
        if (!handed.over && notEnoughApprovalsYet(e)) {
          here.short = true;
          if (standing.outrun === true && standing.removals === undefined) throw new StepRefused(why('outrun'));
          ctx.tell({ state: ONE_OFF_STATE.awaitingApprovals });
          return;
        }
        if (handed.over && !(e instanceof StepRefused || e instanceof ActionStopped)) {
          /* A charge refused after it was handed over: a proposal the chain shows closed meanwhile is not charged again. */
          const id = here.round.chainId.toLowerCase();
          const now = (await records.roundsOnChain!([id]).catch(() => ({} as Record<string, RoundOnChain>)))[id];
          if (now?.held === 'closed') throw new StepRefused(why('closed'));
        }
        refusedAfter(e, handed, 'not-charged', 'charge-may-be-sent');
      }
    },
  };

  const pay: ActionStep = {
    title: { key: 'act.one-off-payment.step.pay' },
    notNeeded: (said) => said['state'] === ONE_OFF_STATE.awaitingApprovals,
    run: async (ctx) => {
      if (here.round === null || here.standing === null || here.short || !atTheBar(here.standing, here.needed)) return;
      if (here.paid) {
        ctx.tell({ state: ONE_OFF_STATE.alreadyPaid });
        return;
      }
      const r = await read.at(ctx);
      const pure = await pureCircuits();
      const records = companyRecordsFor(r, reach, pure);
      const paidAmong = paidAmongFor(records, pure);
      const handed: Handed = { over: false };
      try {
        const { order } = await oneOffToPayHere(records, r.accountId, r.companyKeys, here.round.id, {
          runPayload: pure.account.runPayload, proposalIdOf: pure.account.proposalIdOf, retrySaltOf: pure.account.retrySaltOf, paidAmong,
        });
        const payment = order.payments[0]!;
        if (payment.paid === true) {
          ctx.tell({ state: ONE_OFF_STATE.alreadyPaid });
          return;
        }
        const doors = payDoorsFor(ctx, r, reach, handed);
        if (order.form === 'shielded') await payPrivatelyFromCompanyVault(doors, { order, payment });
        else await payPubliclyFromCompanyVault({ ...doors, paidYet: async () => (await paidAmong([payment.leaf])).paid.length === 1 }, { order, payment });
        ctx.tell({ state: ONE_OFF_STATE.paid });
      } catch (e) {
        if (e instanceof LegNotRaisedHere) throw new StepRefused(why('not-found', { says: e.message }));
        if (e instanceof PaymentNotYetSeen || e instanceof PublicPaymentNotYetSeen) throw new StepRefused(why('payment-not-seen', { says: e.message }));
        if (e instanceof PaymentLandedUnrecorded) throw new StepRefused(why('payment-not-recorded', { says: e.message }));
        if (e instanceof PaymentStillInFlight) throw new StepRefused(why('payment-on-its-way', { says: e.message }));
        if (e instanceof PaymentNotAsBuilt) throw new StepRefused(why('payment-not-as-built', { says: e.message }));
        if (!handed.over && notEnoughApprovalsYet(e)) {
          if (here.standing.outrun === true && here.standing.removals === undefined) throw new StepRefused(why('outrun'));
          ctx.tell({ state: ONE_OFF_STATE.awaitingApprovals });
          return;
        }
        refusedAfter(e, handed, 'not-paid', 'payment-not-seen');
      }
    },
  };
  return [charge, pay];
}

/**
 * **THE ONE-OFF AS A KIND OF PROPOSAL** (`ProposalKind`): its record is opened from the company's records and approved
 * only when it pays exactly what the page shows (`notAsShown`), to the vendor entry it names if any; its raiser's
 * approval counts only where its rights let it approve on that vault, so the account's refusal says when it already
 * did; once at its bar it is charged and paid.
 */
export function oneOffKind(reach: OneOffPaymentReach): ProposalKind {
  const network = reach.network ?? NETWORK;
  const registry = reach.assets ?? theAssets;
  return {
    fields: ['vault', 'token', 'amount', 'payee', 'reason'],
    changesTheCompany: false,
    shown: async (intent) => [
      { key: 'act.one-off-payment.shown.proposal', values: { proposal: intent.fields['proposal'] ?? '' }, from: 'page' as const },
      ...paymentShown(intent, network, registry),
      { key: 'act.one-off-payment.shown.matched', from: 'action' as const },
      { key: 'act.one-off-payment.shown.approve', from: 'action' as const },
      { key: 'act.one-off-payment.shown.carry-out', from: 'action' as const },
    ],
    check: (intent) => {
      const asked = oneOffAskedOf(intent, network, registry);
      return 'key' in asked ? asked : null;
    },
    opened: async (_ctx, r, intent) => {
      const named = intent.fields['proposal']!;
      const asked = oneOffAskedOf(intent, network, registry);
      if ('key' in asked) throw new StepRefused(asked);
      const records = companyRecordsFor(r, reach, await pureCircuits());
      try {
        const found = await oneOffRaisedByHere(records, r.accountId, r.companyKeys, named);
        if (found === null) throw new StepRefused(why('not-a-one-off'));
        const differs = notAsShown(asked, found.oneOff);
        if (differs !== null) throw new StepRefused(why('not-as-shown', { says: differs }));
        await refuseAOneOffToAnotherVendorHere(records, found.oneOff);
        return { id: named, chainId: found.oneOff.proposal.chainId };
      } catch (e) {
        if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
        if (e instanceof OneOffRefused && NEVER_MATCHES.test(e.message)) throw new StepRefused(why('not-as-shown', { says: said(e).replace(/\.$/u, '') }));
        throw new StepRefused(why('not-found', { says: said(e) }));
      }
    },
    needed: (round, held, intent) => oneOffNeeded(round, held, readVaultAddress(intent.fields['vault']) ?? ''),
    approve: async (ctx, r, _intent, round, handed) => {
      const records = companyRecordsFor(r, reach, await pureCircuits());
      try {
        const served = theRoundAsked(await governedCallServiceFor(r.api).standing(round.id), round.id, round.chainId);
        await approveWith(governedDoorsFor(ctx, r, reach, records, handed), { ...served, id: round.id, chainId: round.chainId }, r.companyKeys);
      } catch (e) {
        if (e instanceof ApprovalNotOwed && e.why === 'counted') throw e;
        if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
        refusedAfter(e, handed, 'not-approved', 'approval-may-be-sent');
      }
    },
    stateAt: (_atItsBar, approvedNow) => (approvedNow ? ONE_OFF_STATE.approved : null),
    carry: (here, read) => oneOffCarry(reach, read, here),
    upkeep: { coins: (opener) => (reach.kept ?? keptInTheWallet)(opener).coins },
    why: oneOffWhy,
  };
}

/** The one-off payment action, raised here or, named by its proposal, approved through the one approval and paid. */
export function oneOffPaymentAction(reach: OneOffPaymentReach): ActionDefinition {
  const network = reach.network ?? NETWORK;
  const registry = reach.assets ?? theAssets;
  const kind = oneOffKind(reach);
  return Object.freeze({
    headline: 'act.one-off-payment.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => {
      if (intent.fields['proposal'] !== undefined) {
        return [...await kind.shown(intent), ...upkeepShown(), { key: 'act.one-off-payment.shown.nothing-else', from: 'action' as const }];
      }
      return [
        ...paymentShown(intent, network, registry),
        { key: 'act.one-off-payment.shown.window', from: 'action' as const },
        { key: 'act.one-off-payment.shown.record', from: 'action' as const },
        { key: 'act.one-off-payment.shown.carry-out', from: 'action' as const },
        ...upkeepShown(),
        { key: 'act.one-off-payment.shown.nothing-else', from: 'action' as const },
      ];
    },
    checks: [
      { key: 'act.one-off-payment.check.seat' },
      { key: 'act.one-off-payment.check.payment' },
      { key: 'act.one-off-payment.check.vault' },
      { key: 'act.one-off-payment.check.policy' },
      { key: 'act.one-off-payment.check.chain' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => {
      if (intent.fields['record'] === undefined) return why('not-a-company');
      return kind.check(intent);
    },
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const here = approving();
      const seat: ActionStep = {
        title: { key: 'act.one-off-payment.step.seat' },
        run: async (ctx) => { await read.at(ctx); },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, kind.upkeep ?? {});
      const raise: ActionStep = intent.fields['proposal'] !== undefined
        ? approveStep(kind, intent, read, here, { key: 'act.one-off-payment.step.approve' })
        : {
          title: { key: 'act.one-off-payment.step.raise' },
          run: async (ctx) => {
            const r = await read.at(ctx);
            const pure = await pureCircuits();
            const records = companyRecordsFor(r, reach, pure);
            const asked = oneOffAskedOf(intent, network, registry);
            if ('key' in asked) throw new StepRefused(asked);
            let window: { readonly opensAt: bigint; readonly closesAt: bigint };
            try {
              window = await oneOffWindowFor(records, r, asked, reach.now());
            } catch (e) {
              if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
              throw new StepRefused(why('not-raised', { says: said(e) }));
            }
            let round: RoundOnThePage;
            const handed: Handed = { over: false };
            try {
              round = await raiseOneOffWith(raiseDoorsFor(ctx, r, reach, records, pure, handed), { ...asked, ...window }, r.companyKeys);
            } catch (e) {
              return refusedAfter(e, handed, 'not-raised', 'raise-may-be-sent');
            }
            ctx.tell({ state: ONE_OFF_STATE.raised });
            here.round = { id: round.id, chainId: round.chainId.toLowerCase() };
            const standing = await untilTheChainShows(ctx, records, reach, round.chainId, (s) => s.held !== 'never');
            if (standing === null) throw new StepRefused(why('raise-not-seen'));
            if (standing.held === 'closed' || standing.held === 'never') throw new StepRefused(why('closed'));
            here.standing = standing;
            here.needed = oneOffNeeded(standing, await r.holders(), asked.vault);
            ctx.tell({ approvals: standing.approvals, ...(here.needed === null ? {} : { needed: here.needed }) });
          },
        };
      return [seat, upkeep.first, raise, ...oneOffCarry(reach, read, here), upkeep.last];
    },
  } satisfies ActionDefinition);
}
