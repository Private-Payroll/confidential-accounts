/**
 * THE ONE-OFF PAYMENT'S RECORD - one of the company's records, of its own kind,
 * `transfer`.
 *
 * A one-off payment is a payment from a vault to one payee outside payroll. On
 * the chain it is a run with one payee, raised, approved and paid as any run
 * is. Off the chain it is this record: what is paid, from which vault, in which
 * currency, to which address, why, under which proposal, in which window, and
 * the one seed its secrets come from (`oneOffSecretsOf`). It is never one of
 * payroll's records and names no person, month or kind of pay.
 *
 * **SEALED TO THE SIGNERS, NEVER TO THE SERVICE.** The body is sealed under the
 * company's key, with a purpose of its own (`one-offs`, never payroll's), as a
 * vault's name is, so every signer's device opens it - one seated after it was
 * filed too, through the company key's rotations - rebuilds the payment and
 * checks the proposal it is raised over; the service keeps bytes it cannot
 * read. A signer who leaves keeps what they could already read. The body
 * is padded to one size, so its length says nothing about the payee's name, the
 * address or the reason, and the record's id is random, because the id is in
 * the clear on every path.
 *
 * **THE PAYEE IS AN ADDRESS.** A one-off is paid to an address typed straight
 * in, with an optional name as shown when it was paid. `ref` is the record's
 * place for a vendor entry, and is always null: no one-off names one. The
 * address decides whether it is paid privately or publicly.
 *
 * Filed once: a one-off raised again is a new record.
 */
import { canonical, parseCanonical, randomBytes, seal, toHex, unseal, type Hex } from '../core/crypto.js';
import { purposeKey } from '../core/sealed-records.js';
import { assets as theAssets, ledgerTokenOf, type AssetId, type AssetRegistry } from '../core/assets.js';
import { privacyOf, type Privacy } from '../core/movement.js';
import { PROPOSAL_ID } from '../core/proposal-filing.js';
import { isNetworkName, type NetworkName } from './network.js';
import { payeeOf, type Payee } from './payee-address.js';
import type { SealedCompanyRecord } from './sealed-record-wire.js';
import { ONE_OFF_KIND, ONE_OFF_VERSION, OneOffRefused } from './one-off-kind.js';

export { ONE_OFF_KIND, ONE_OFF_VERSION, OneOffRefused };

/** The purpose of the company's key a one-off is sealed under: its own, never payroll's. */
export const ONE_OFF_PURPOSE = 'one-offs' as const;

/** The most characters a payee's name, its address and a one-off's reason may take. */
export const ONE_OFF_NAME_MOST = 128;
export const ONE_OFF_ADDRESS_MOST = 256;
export const ONE_OFF_REASON_MOST = 500;

/**
 * The one size every one-off's body is sealed at: the longest name and reason
 * at four bytes a character, the longest address, and room for the rest.
 */
export const ONE_OFF_SEALED_BYTES = 4 * (ONE_OFF_NAME_MOST + ONE_OFF_REASON_MOST) + ONE_OFF_ADDRESS_MOST + 1024;

/** Who a one-off is paid to: an address, its network, and the name it was paid under, if any. `ref` names a vendor entry once the vendor list exists. */
export interface OneOffPayee {
  readonly ref: null;
  readonly name: string | null;
  readonly address: string;
  readonly network: NetworkName;
}

/** A one-off payment as its record holds it. */
export interface OneOff {
  readonly vault: Hex;
  readonly asset: AssetId;
  /** In the currency's smallest unit. */
  readonly amount: bigint;
  readonly payee: OneOffPayee;
  readonly reason: string;
  /** The proposal it is raised over: its name in the company's records and its identity on the chain. */
  readonly proposal: { readonly id: string; readonly chainId: Hex };
  /** The run's window, in seconds since the Unix epoch, and the approvals it was raised needing. */
  readonly run: { readonly opensAt: bigint; readonly closesAt: bigint; readonly required: bigint };
  /** The one secret its nonce, its payee's blinding and its salt's fresh half are derived from (`oneOffSecretsOf`). */
  readonly seed: Hex;
}

/** A one-off as it is asked for: with the form it is to be paid in, which its address must agree with. */
export type OneOffGiven = OneOff & { readonly form: Privacy };

/** A one-off as a device reads it: the record's facts, and the payee, form and token they come to. */
export type OneOffOpened = OneOff & { readonly form: Privacy; readonly paidTo: Payee; readonly token: Hex };

const HEX64 = /^[0-9a-f]{64}$/u;
const ONE_OFF_ID = /^one_[0-9a-f]{32}$/u;
const UINT64 = 1n << 64n;
const UINT128 = 1n << 128n;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTROL_BUT_A_LINE_BREAK = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;
const characters = (s: string): number => [...s].length;

/** A new one-off's id: random, so it says nothing about who is paid. */
export const newOneOffId = (): string => `one_${toHex(randomBytes(16))}`;

/** A new one-off's seed: 32 random bytes, sealed in its record and nowhere else. */
export const newOneOffSeed = (): Hex => toHex(randomBytes(32));

const refuseAnId = (id: string): void => {
  if (!ONE_OFF_ID.test(id)) {
    throw new OneOffRefused('A one-off payment is filed under a random id (newOneOffId), and this id is not one, so it could carry a name.');
  }
};

const whole = (what: string, v: unknown, below: bigint): bigint => {
  if (typeof v !== 'bigint' || v < 0n || v >= below) throw new OneOffRefused(`A one-off payment's ${what} is not a whole number it can carry.`);
  return v;
};

/**
 * **A ONE-OFF AS IT IS KEPT**, or refused with the reason. The address is read
 * as a Midnight address on its network, and decides the form: a one-off set to
 * one form with an address of the other is refused, and so is a currency with
 * no such form. Its name and reason are trimmed and kept to one size.
 */
export const oneOffTidied = (given: OneOffGiven, registry: AssetRegistry = theAssets): OneOffOpened => {
  const g = given as Partial<OneOffGiven> | null;
  if (g === null || typeof g !== 'object') throw new OneOffRefused('This is not a one-off payment.');
  const vault = String(g.vault ?? '').toLowerCase() as Hex;
  if (!HEX64.test(vault)) throw new OneOffRefused('A one-off payment names the vault it is paid from by its address, and this is not one.');
  const asset = String(g.asset ?? '').toLowerCase() as AssetId;
  if (!HEX64.test(asset)) throw new OneOffRefused('A one-off payment names the currency it is paid in, and this is not one.');
  const amount = whole('amount', g.amount, UINT128);
  if (amount === 0n) throw new OneOffRefused('A one-off payment has to move a positive amount.');
  const p = g.payee as Partial<OneOffPayee> | undefined;
  if (p === undefined || p === null || typeof p !== 'object') throw new OneOffRefused('A one-off payment names who it is paid to.');
  if (p.ref !== null) {
    throw new OneOffRefused('A one-off payment is paid to an address for now: a vendor entry is named once the company has its vendor list.');
  }
  let name: string | null = null;
  if (p.name !== null && p.name !== undefined) {
    if (typeof p.name !== 'string') throw new OneOffRefused('A payee\'s name is text.');
    name = p.name.normalize('NFC').trim();
    if (characters(name) < 1 || characters(name) > ONE_OFF_NAME_MOST) {
      throw new OneOffRefused(`A payee's name is 1 to ${ONE_OFF_NAME_MOST} characters, or none, and this one is ${characters(name)}.`);
    }
    if (CONTROL.test(name)) throw new OneOffRefused('A payee\'s name is one line of text, with no line breaks or control characters.');
  }
  if (typeof p.network !== 'string' || !isNetworkName(p.network)) throw new OneOffRefused('A one-off payment names the network its address is on.');
  const address = String(p.address ?? '').trim();
  if (address.length < 1 || address.length > ONE_OFF_ADDRESS_MOST) {
    throw new OneOffRefused(`A payee's address is 1 to ${ONE_OFF_ADDRESS_MOST} characters, and this one is ${address.length}.`);
  }
  let paidTo: Payee;
  try {
    paidTo = payeeOf(address, p.network);
  } catch (e) {
    throw new OneOffRefused((e as Error).message, { cause: e });
  }
  const says = privacyOf(paidTo);
  if (g.form !== says) {
    throw new OneOffRefused(`This one-off payment is set to ${String(g.form)} and the address is a ${says} one. An address decides which way `
      + `it is paid, and this choice cannot change that. Either switch it to ${says}, or use a ${String(g.form)} address.`);
  }
  try {
    ledgerTokenOf(asset, paidTo.kind, registry);
  } catch (e) {
    throw new OneOffRefused((e as Error).message, { cause: e });
  }
  if (typeof g.reason !== 'string') throw new OneOffRefused('Give the payment a reason, so it can be recognised later.');
  const reason = g.reason.normalize('NFC').trim();
  if (characters(reason) < 1) throw new OneOffRefused('Give the payment a reason, so it can be recognised later.');
  if (characters(reason) > ONE_OFF_REASON_MOST) {
    throw new OneOffRefused(`A one-off payment's reason is at most ${ONE_OFF_REASON_MOST} characters, and this one is ${characters(reason)}.`);
  }
  if (CONTROL_BUT_A_LINE_BREAK.test(reason)) throw new OneOffRefused('A one-off payment\'s reason is text and line breaks, with no other control characters.');
  const proposal = g.proposal as Partial<OneOff['proposal']> | undefined;
  const chainId = String(proposal?.chainId ?? '').toLowerCase() as Hex;
  if (typeof proposal?.id !== 'string' || !PROPOSAL_ID.test(proposal.id) || !HEX64.test(chainId)) {
    throw new OneOffRefused('A one-off payment names the proposal it is raised over, by its name and its identity on the chain.');
  }
  const run = g.run as Partial<OneOff['run']> | undefined;
  const opensAt = whole('window', run?.opensAt, UINT64);
  const closesAt = whole('window', run?.closesAt, UINT64);
  if (opensAt >= closesAt) throw new OneOffRefused('A one-off payment\'s window ends after it opens.');
  const required = whole('number of approvals', run?.required, UINT64);
  const seed = g.seed;
  if (typeof seed !== 'string' || !HEX64.test(seed)) throw new OneOffRefused('A one-off payment\'s seed is 32 bytes of lower-case hex.');
  return {
    vault, asset, amount, payee: { ref: null, name, address, network: p.network }, reason,
    proposal: { id: proposal.id, chainId }, run: { opensAt, closesAt, required }, seed,
    form: says, paidTo, token: ledgerTokenOf(asset, paidTo.kind, registry).toLowerCase() as Hex,
  };
};

interface OneOffLabel {
  readonly record: typeof ONE_OFF_KIND;
  readonly company: string;
  readonly id: string;
  readonly version: number;
}
const LABEL = '$label';

const bodyOf = (o: OneOffOpened, label: OneOffLabel): string => {
  const text = canonical({
    vault: o.vault, asset: o.asset, amount: o.amount.toString(),
    payee: { ref: null, name: o.payee.name, address: o.payee.address, network: o.payee.network },
    reason: o.reason, proposal: o.proposal,
    run: { opensAt: o.run.opensAt.toString(), closesAt: o.run.closesAt.toString(), required: o.run.required.toString() },
    seed: o.seed, [LABEL]: label,
  });
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > ONE_OFF_SEALED_BYTES) throw new OneOffRefused('This one-off payment does not fit the size every one-off is sealed at.');
  return text + ' '.repeat(ONE_OFF_SEALED_BYTES - bytes);
};

/**
 * **THE RECORD OF A ONE-OFF, SEALED UNDER THE COMPANY'S KEY AT `keyEpoch`** for
 * the one-offs purpose, unsigned: the store signs it as it files it.
 */
export const sealOneOff = (input: {
  readonly company: string;
  readonly id: string;
  readonly keyEpoch: number;
  /** The company's key at `keyEpoch`. */
  readonly key: Hex;
  readonly given: OneOffGiven;
  readonly registry?: AssetRegistry;
}): SealedCompanyRecord => {
  refuseAnId(input.id);
  const tidied = oneOffTidied(input.given, input.registry);
  const label: OneOffLabel = { record: ONE_OFF_KIND, company: input.company, id: input.id, version: ONE_OFF_VERSION };
  return {
    company: input.company, kind: ONE_OFF_KIND, id: input.id, version: ONE_OFF_VERSION, keyEpoch: input.keyEpoch,
    sealed: seal(bodyOf(tidied, label), purposeKey(input.key, input.company, ONE_OFF_PURPOSE)),
    wrapped: [],
  };
};

/**
 * **A ONE-OFF, AS ONE SIGNER'S DEVICE OPENS IT**, with the company's key at the
 * epoch the record names, or refused with the reason. A record sealed for
 * another id, company or version is refused.
 */
export const openOneOff = (rec: SealedCompanyRecord, key: Hex, registry: AssetRegistry = theAssets): OneOffOpened => {
  if (rec.kind !== ONE_OFF_KIND) throw new OneOffRefused('This record is not a one-off payment.');
  let body: Record<string, unknown>;
  try {
    body = parseCanonical<Record<string, unknown>>(unseal(rec.sealed, purposeKey(key, rec.company, ONE_OFF_PURPOSE)));
  } catch (e) {
    throw new OneOffRefused('This one-off payment does not open with the company\'s key this device holds, so it is damaged or not '
      + 'this company\'s.', { cause: e });
  }
  const label = body?.[LABEL] as Partial<OneOffLabel> | undefined;
  if (label?.record !== ONE_OFF_KIND || label.company !== rec.company || label.id !== rec.id || label.version !== rec.version) {
    throw new OneOffRefused('What is sealed inside this one-off payment says it is another record or another version than the one it '
      + 'is filed as, so it is not believed.');
  }
  const digits = (v: unknown): bigint => {
    if (typeof v !== 'string' || !/^[0-9]{1,39}$/u.test(v)) throw new OneOffRefused('A number sealed in this one-off payment is not a whole number.');
    return BigInt(v);
  };
  const p = body.payee as Record<string, unknown> | undefined;
  const run = body.run as Record<string, unknown> | undefined;
  const opened = oneOffTidied({
    vault: body.vault as Hex, asset: body.asset as AssetId, amount: digits(body.amount),
    payee: { ref: p?.ref as null, name: p?.name as string | null, address: p?.address as string, network: p?.network as NetworkName },
    reason: body.reason as string, proposal: body.proposal as OneOff['proposal'],
    run: { opensAt: digits(run?.opensAt), closesAt: digits(run?.closesAt), required: digits(run?.required) },
    seed: body.seed as Hex,
    form: typeof p?.address === 'string' && typeof p?.network === 'string' && isNetworkName(p.network)
      ? privacyOfAddress(p.address, p.network) : 'private',
  }, registry);
  return opened;
};

const privacyOfAddress = (address: string, network: NetworkName): Privacy => {
  try {
    return privacyOf(payeeOf(address, network));
  } catch (e) {
    throw new OneOffRefused((e as Error).message, { cause: e });
  }
};
