import type { Identity } from '../keys/derivation.js';
import { committeeKeyFor, committeeSigningKeyFor } from './committee-key.js';
import { usableOrigin } from './origin.js';
import { readAccountAddress, readCompanyLabel } from './company-label.js';
import type { AccountAddress, CompanyLabel } from './company-label.js';
import type {
  CommitteeKeyOnTheWire, CommitteeOnTheWire, CommitteeRequest, SuperAdminChangeOnTheWire,
} from './request.js';

/**
 * WHAT THIS WALLET CHECKS, SHOWS, AND THEN SIGNS, WHEN A PAGE ASKS IT TO SIGN A
 * CHANGE TO WHO HOLDS A COMPANY'S RULES.
 *
 * **THE CHAIN, NEVER THE PAGE.** Who holds each contract now, its counter, and
 * the account a vault is pinned to come from what this wallet read at its own
 * indexer (`ChainRead`); the page's word on any of them is never used. A
 * hand-over is signed only when the committee it installs is the one holding
 * the company's account on the chain. A change of the super admins is signed
 * only when its bytes, rebuilt here, are the bytes the page sent, the account
 * on the chain is held by the committee it replaces or the one it installs,
 * and every key it puts on a contract this wallet signs has signed those bytes
 * with its own key. A joining key signs the rebuilt bytes, and only when the
 * change installs it.
 *
 * **ONE CHANGE, AND THE WALLET MAKES IT.** Each contract's update is built here
 * (`committeeUpdateOf`, the one builder every party uses) at the counter the
 * chain holds, and signed at every place this person's key holds on that
 * contract's committee on the chain. Nothing here reads a seat, a signer, a
 * role or a roster.
 *
 * **THIS FILE LOADS NO WEBASSEMBLY.** The ledger's classes are handed in by the
 * screen, which loads them; the arithmetic of the key itself is
 * `committee-key.ts`'s.
 */

export const COMMITTEE_SIGNATURES_SCHEMA = 'midnight-identity/committee-signatures/v1';
export const COMMITTEE_JOIN_SCHEMA = 'midnight-identity/committee-join/v1';

type Key = { readonly tag: string; readonly value: string };

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX128 = /^[0-9a-f]{128}$/u;
const HEX = /^[0-9a-f]+$/u;
const DIGITS = /^[0-9]{1,20}$/u;

const bytesOfHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../gu) ?? [], (b) => parseInt(b, 16));
const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const same = (a: { value: string }, b: { value: string }): boolean => a.value.toLowerCase() === b.value.toLowerCase();
const sameKey = (a: Key, b: Key): boolean => a.tag.toLowerCase() === b.tag.toLowerCase() && same(a, b);
const keyIn = (keys: readonly Key[], k: Key): boolean => keys.some((x) => sameKey(x, k));
const sameCommittee = (a: { committee: readonly Key[]; threshold: number }, b: { committee: readonly Key[]; threshold: number }): boolean =>
  a.threshold === b.threshold && a.committee.length === b.committee.length && a.committee.every((k, i) => sameKey(k, b.committee[i]!));
const wireKey = (k: Key): CommitteeKeyOnTheWire => Object.freeze({ tag: 'schnorr', value: k.value.toLowerCase() }) as CommitteeKeyOnTheWire;

/* ── A CHANGE OF THE SUPER ADMINS: ITS BYTES, AND A JOINING KEY'S SIGNATURE OVER THEM ── */

/** The tag a change of the super admins' bytes begin with; nothing else a wallet signs begins with it. */
export const SUPER_ADMIN_CHANGE_TAG = 'confidential-accounts:super-admin-change:v1';

/**
 * **THE BYTES OF A CHANGE OF THE SUPER ADMINS**: the tag, the company's label,
 * the account, the salt, the committee it replaces, the committee it installs
 * and each contract with its counter, each part with its length. Every
 * joining key signs these bytes, and the change's identity is their hash. The
 * one definition: every device and every wallet makes them here.
 */
export function superAdminChangeBytes(
  company: string, account: string, salt: string,
  change: Pick<SuperAdminChangeOnTheWire, 'from' | 'committee' | 'threshold' | 'contracts'>,
): Uint8Array {
  const out: number[] = [];
  const u32 = (n: number) => { out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); };
  const text = (t: string) => { const b = new TextEncoder().encode(t); u32(b.length); out.push(...b); };
  const hex = (h: string) => { const b = bytesOfHex(h.toLowerCase()); u32(b.length); out.push(...b); };
  const committee = (c: { readonly committee: readonly Key[]; readonly threshold: number }) => {
    u32(c.threshold); u32(c.committee.length);
    for (const k of c.committee) { text(k.tag.toLowerCase()); hex(k.value); }
  };
  text(SUPER_ADMIN_CHANGE_TAG); text(company); hex(account); hex(salt);
  committee(change.from); committee(change);
  u32(change.contracts.length);
  for (const c of change.contracts) {
    text(c.contract); hex(c.address);
    const n = BigInt(c.counter);
    for (let i = 7; i >= 0; i -= 1) out.push(Number((n >> BigInt(i * 8)) & 255n));
  }
  return Uint8Array.from(out);
}

/** The ledger's own signature check. `@midnightntwrk/ledger-v9` satisfies it. */
export interface SignatureCheck {
  verifySignature(key: never, data: Uint8Array, signature: never): boolean;
}

/**
 * Whether `signature` is `key`'s own signature over a change's bytes, checked
 * by the ledger's own signature check, as every committee key signs: a
 * wallet's signer hashes the bytes before it signs, so a check over the raw
 * bytes would refuse a real wallet's signature. Never throws.
 */
export function joinedBy(ledger: SignatureCheck, bytes: Uint8Array, key: Key, signature: string): boolean {
  const tag = key.tag.toLowerCase();
  if (tag !== 'schnorr' || !HEX64.test(key.value.toLowerCase()) || !HEX128.test(signature.toLowerCase())) return false;
  try {
    return ledger.verifySignature({ tag, value: key.value.toLowerCase() } as never, bytes, { tag, value: signature.toLowerCase() } as never);
  } catch { return false; }
}

/* ── ONE BUILDER OF A COMMITTEE UPDATE ── */

/**
 * The largest counter the chain holds for a contract's authority: it is a
 * 32-bit number, and the chain's next counter after it is itself, so a
 * contract at it would never move on and every signature over its updates
 * would stay good for ever. No update is built at it.
 */
export const LARGEST_COUNTER = 0xffff_ffffn;

/** Why no update is built at `counter`, which is `LARGEST_COUNTER` or above: the one sentence every builder gives. */
export const largestCounterRefusal = (counter: bigint): string =>
  `this contract's maintenance counter is ${counter}, the largest the chain holds, and a contract at it never moves past it, `
  + 'so a signature on any of its updates would stay good for ever. Nothing was built.';

/** The ledger classes a committee update is built from. `@midnightntwrk/ledger-v9` satisfies it. */
export interface CommitteeUpdateLedger {
  ContractMaintenanceAuthority: new (committee: never[], threshold: number, counter?: bigint) => object;
  ReplaceAuthority: new (authority: never) => object;
  MaintenanceUpdate: new (address: string, updates: never[], counter: bigint) => { readonly dataToSign: Uint8Array };
}

/**
 * **THE ONE UPDATE THAT INSTALLS A COMMITTEE ON A CONTRACT**: the contract's
 * whole list of keys replaced with `to`, against the counter the chain holds
 * the contract at now; the new authority carries the next counter, so a
 * signature over it is worthless against any other counter, contract or list.
 * Every party builds the update with this - this wallet when it signs, a
 * device when it counts signatures, the service when it sends - so all of
 * them mean the same bytes. Refuses an address that is not a contract's and a
 * counter the chain cannot carry past. Which committee may be installed is the
 * caller's to check first.
 */
export function committeeUpdateOf<P extends CommitteeUpdateLedger>(
  P: P,
  input: { readonly address: string; readonly counter: bigint; readonly to: { readonly committee: readonly Key[]; readonly threshold: number } },
): InstanceType<P['MaintenanceUpdate']> {
  const address = input.address.toLowerCase();
  if (!HEX64.test(address)) throw new Error('a contract is named by its sixty-four character address, and this is not one.');
  if (typeof input.counter !== 'bigint' || input.counter < 0n) throw new Error('a maintenance counter is never below zero.');
  if (input.counter >= LARGEST_COUNTER) throw new Error(largestCounterRefusal(input.counter));
  const committee = input.to.committee.map((k) => ({ tag: k.tag, value: k.value }));
  const authority = new P.ContractMaintenanceAuthority(committee as never[], input.to.threshold, input.counter + 1n);
  return new P.MaintenanceUpdate(address, [new P.ReplaceAuthority(authority as never) as never], input.counter) as InstanceType<P['MaintenanceUpdate']>;
}

/* ── WHAT THIS WALLET READ FROM THE CHAIN ── */

/** One contract as this wallet read it at its own indexer. */
export type ContractOnTheChain =
  | {
    readonly of: 'read';
    readonly committee: readonly Key[];
    readonly threshold: number;
    readonly counter: bigint;
    /** The account a vault's constructor pinned it to; null for the company's account itself. */
    readonly pinnedTo: string | null;
    /** On the account only, where this wallet read them: every vault it lists, adopted and retired. */
    readonly vaults?: readonly string[];
  }
  | { readonly of: 'unreadable'; readonly why: string };

/** Every contract an ask names, and the company's account, as this wallet read them, by address in lower case. */
export type ChainRead = ReadonlyMap<string, ContractOnTheChain>;

/** The contracts this wallet must read before it shows an ask: the company's account first, then each contract the ask names. */
export function contractsToRead(request: CommitteeRequest): readonly string[] {
  const named = request.press === 'join' ? request.change.contracts : request.contracts;
  return [...new Set([request.account as string, ...named.map((c) => c.address.toLowerCase())])];
}

export class CommitteeSignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitteeSignError';
  }
}

const refuse = (why: string): never => { throw new CommitteeSignError(`${why} Nothing has been signed.`); };

/* ── WHAT THE SCREEN SHOWS ── */

/** What the screen shows for one contract, every part of it read from the chain. */
export interface ContractChangeShown {
  readonly contract: 'account' | 'vault';
  readonly address: string;
  /** The counter the chain holds the contract at, in decimal: the one signed against. */
  readonly counter: string;
  /** Keys on the new committee and not on this contract's committee on the chain. */
  readonly joins: readonly CommitteeKeyOnTheWire[];
  /** Keys on this contract's committee on the chain and not on the new one. They lose their place. */
  readonly leaves: readonly CommitteeKeyOnTheWire[];
  readonly keysNow: number;
  readonly thresholdNow: number;
  readonly thresholdAfter: number;
  /** The places this person's key holds on the contract's committee on the chain, in order. Empty only for a joining key. */
  readonly seats: readonly number[];
}

/** What the screen shows for the whole ask. */
export interface CommitteeChangeShown {
  readonly press: CommitteeRequest['press'];
  readonly mine: CommitteeKeyOnTheWire;
  /** Whether this person's own key is on the new committee. When it is not, they are signing themselves off. */
  readonly staysOn: boolean;
  readonly to: CommitteeOnTheWire;
  readonly contracts: readonly ContractChangeShown[];
}

const named = (address: string, account: string): string => (address === account ? 'the company\'s account' : `vault ${address}`);

/** One contract read off the chain and judged: readable, the kind its address says, and a vault pinned to this account. */
function onTheChain(chain: ChainRead, account: string, address: string): Extract<ContractOnTheChain, { of: 'read' }> {
  const read = chain.get(address.toLowerCase());
  if (read === undefined || read.of !== 'read') {
    const why = read !== undefined && read.of === 'unreadable' ? ` (${read.why.replace(/\.$/u, '')})` : '';
    return refuse(`this wallet could not read who holds ${named(address, account)} on the chain through its own indexer${why}.`);
  }
  if (address === account && read.pinnedTo !== null) return refuse('what this wallet read at the account\'s address is not the company\'s account.');
  if (address !== account && read.pinnedTo !== account) {
    return refuse(`vault ${address} is pinned to another account on the chain, not this company's, so this wallet will not sign for it.`);
  }
  if (address === account && read.counter < 1n) {
    return refuse('the company\'s account is not finished being created on the chain, so who holds it cannot be changed yet.');
  }
  return read;
}

/**
 * **WHAT THIS PERSON IS ASKED TO SIGN, IN THE TERMS THEY DECIDE ON, FROM THE
 * CHAIN**, or a refusal naming the first thing this wallet will not sign. Every
 * committee, counter and pinned account comes from `chain`; `L` checks the
 * joining keys' signatures.
 */
export function committeeChangeShown(L: SignatureCheck, identity: Identity, request: CommitteeRequest, chain: ChainRead): CommitteeChangeShown {
  const mine = committeeKeyFor(identity, request.company) as unknown as CommitteeKeyOnTheWire;
  const account = onTheChain(chain, request.account, request.account);
  if (request.press === 'hand-over') {
    if (!sameCommittee(request.to, account)) {
      refuse('the committee this asks to install is not the committee holding the company\'s account on the chain, and a hand-over '
        + 'only ever brings a contract to that one: a key joins the company only through a change of its super admins that the key signs itself.');
    }
  } else {
    const rebuilt = hexOf(superAdminChangeBytes(request.company, request.account, request.salt, request.change));
    if (rebuilt !== request.changeBytes) refuse('the bytes the page sent are not the change it asks to be signed, as this wallet rebuilt it.');
    /*
     * The account counter the change was raised at is in its bytes. The change
     * is the account's next one only while the account still sits there, held
     * by the committee it replaces, or has just taken it, one counter on: a
     * change that ran or was turned down is never signed again, whatever
     * committee the account has come back to since.
     */
    const raisedAt = BigInt(request.change.contracts[0]!.counter);
    const atFrom = sameCommittee(account, request.change.from) && account.counter === raisedAt;
    const atTo = sameCommittee(account, request.to) && account.counter === raisedAt + 1n;
    if (!atFrom && !atTo) {
      refuse(`this change was raised when the account was at counter ${raisedAt}, held by the committee it replaces, and the account on the chain `
        + `is at counter ${account.counter}, neither there nor one step on held by the committee it installs: a change that ran or was turned `
        + 'down is never signed again.');
    }
    /* Every change names every contract of the company, so landing it moves every counter and voids every older signature. */
    const named = new Set(request.change.contracts.map((c) => c.address.toLowerCase()));
    const left = (account.vaults ?? []).find((v) => !named.has(v.toLowerCase()));
    if (left !== undefined) {
      refuse(`this change leaves out vault ${left}, which the company's account lists on the chain. Every change names every contract of the `
        + 'company, so that no update signed for an earlier change can still land on one it leaves out.');
    }
    if (request.press === 'join' && !keyIn(request.to.committee, mine)) {
      refuse('your key for this company is not one this change installs, so there is nothing for you to sign as a joining key.');
    }
  }
  const asked = request.press === 'join' ? request.change.contracts : request.contracts;
  const contracts = asked.map((c) => {
    const address = c.address.toLowerCase();
    const read = onTheChain(chain, request.account, address);
    if (request.press !== 'join' && c.counter !== read.counter.toString()) {
      refuse(`the page names counter ${c.counter} for ${named(address, request.account)}, and the chain holds it at ${read.counter}, so the change would be signed against the wrong counter.`);
    }
    const seats = read.committee.flatMap((k, i) => (sameKey(k, mine) ? [i] : []));
    if (request.press !== 'join' && seats.length === 0) {
      refuse(`your key for this company is not on the committee that holds ${named(address, request.account)} on the chain, so this wallet cannot sign a change to it.`);
    }
    return Object.freeze({
      contract: c.contract,
      address,
      counter: read.counter.toString(),
      joins: Object.freeze(request.to.committee.filter((k) => !keyIn(read.committee, k)).map(wireKey)),
      leaves: Object.freeze(read.committee.filter((k) => !keyIn(request.to.committee, k)).map(wireKey)),
      keysNow: read.committee.length,
      thresholdNow: read.threshold,
      thresholdAfter: request.to.threshold,
      seats: Object.freeze(seats),
    });
  });
  if (request.press === 'super-admins') {
    const bytes = bytesOfHex(request.changeBytes);
    for (const c of contracts) {
      for (const k of c.joins) {
        const signed = request.joined.find((j) => sameKey(j.key, k));
        if (signed === undefined || !joinedBy(L, bytes, k, signed.signature)) {
          refuse(`key ${k.value} joins ${named(c.address, request.account)} and has not signed the change with its own key, so no key nobody holds `
            + 'is put on the company\'s contracts.');
        }
      }
    }
  }
  return Object.freeze({
    press: request.press, mine, staysOn: keyIn(request.to.committee, mine), to: request.to, contracts: Object.freeze(contracts),
  });
}

/* ── THE PRESS ── */

/** The ledger classes a committee change is built and signed with. `@midnightntwrk/ledger-v9` satisfies it. */
export interface CommitteeSigningLedger extends CommitteeUpdateLedger, SignatureCheck {
  signData(signingKey: never, data: Uint8Array): { tag: string; value: string };
}

/** One signature, for one contract, at one place on the committee that holds it on the chain. */
export interface CommitteeSeatSignature {
  readonly address: string;
  /** The counter it was signed against, in decimal. */
  readonly counter: string;
  readonly seat: number;
  readonly signature: { readonly tag: string; readonly value: string };
}

/** What a person's press on a hand-over or a change of the super admins hands back to the page. */
export interface CommitteeUpdateSignatures {
  readonly schema: typeof COMMITTEE_SIGNATURES_SCHEMA;
  /** OBSERVED. A convenience for the requester, never an authority. */
  readonly origin: string;
  /** The company's label, and the account the page named as carrying it. Echoed. */
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
  readonly nonce: string;
  readonly at: number;
  /** This person's committee key for the company: the key every signature below verifies against. */
  readonly signer: CommitteeKeyOnTheWire;
  /** The committee the signatures install, exactly as it was shown. */
  readonly to: CommitteeOnTheWire;
  readonly signatures: readonly CommitteeSeatSignature[];
}

/** What a joining key's press hands back: its own signature over the change's bytes. */
export interface CommitteeJoinSignature {
  readonly schema: typeof COMMITTEE_JOIN_SCHEMA;
  readonly origin: string;
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
  readonly nonce: string;
  readonly at: number;
  /** The joining key: this person's committee key for the company. */
  readonly signer: CommitteeKeyOnTheWire;
  /** Its signature over the change's bytes, sixty-four bytes in hex. */
  readonly signature: string;
}

/** Any answer a committee ask's press hands back. */
export type CommitteeSignatures = CommitteeUpdateSignatures | CommitteeJoinSignature;

/**
 * **THE PRESS ON A HAND-OVER OR A CHANGE OF THE SUPER ADMINS.** Builds each
 * contract's update at the counter the chain holds and signs it at every
 * place this person's key holds on that contract's committee on the chain, in
 * order. The signing key is worked out here, used, and not kept or returned.
 */
export function committeeSignaturesFor(
  L: CommitteeSigningLedger, identity: Identity, request: CommitteeRequest, chain: ChainRead, at: number,
): CommitteeUpdateSignatures {
  if (!usableOrigin(request.requester.origin)) {
    throw new CommitteeSignError('this wallet could not tell who asked, so nothing has been signed.');
  }
  if (request.press === 'join') refuse('this asks for a joining key\'s own signature over the change, not for a signature on any contract.');
  const shown = committeeChangeShown(L, identity, request, chain);
  const signingKey = committeeSigningKeyFor(identity, request.company);
  const signatures: CommitteeSeatSignature[] = [];
  for (const c of shown.contracts) {
    const update = committeeUpdateOf(L, { address: c.address, counter: BigInt(c.counter), to: request.to });
    const signature = L.signData(signingKey as never, update.dataToSign);
    for (const seat of c.seats) {
      signatures.push(Object.freeze({
        address: c.address, counter: c.counter, seat, signature: Object.freeze({ tag: signature.tag, value: signature.value }),
      }));
    }
  }
  return Object.freeze({
    schema: COMMITTEE_SIGNATURES_SCHEMA,
    origin: request.requester.origin,
    company: request.company,
    account: request.account,
    nonce: request.nonce,
    at,
    signer: shown.mine,
    to: request.to,
    signatures: Object.freeze(signatures),
  });
}

/**
 * **THE PRESS ON A JOINING KEY'S ASK**: after every check `committeeChangeShown`
 * makes, this person's committee key for the company signs the change's bytes
 * as rebuilt here, with the ledger's own signer, so `joinedBy` takes it.
 */
export function committeeJoinFor(
  L: CommitteeSigningLedger, identity: Identity, request: CommitteeRequest, chain: ChainRead, at: number,
): CommitteeJoinSignature {
  if (!usableOrigin(request.requester.origin)) {
    throw new CommitteeSignError('this wallet could not tell who asked, so nothing has been signed.');
  }
  if (request.press !== 'join') refuse('this asks for signatures on contracts, not for a joining key\'s own signature.');
  const shown = committeeChangeShown(L, identity, request, chain);
  const join = request as Extract<CommitteeRequest, { press: 'join' }>;
  const bytes = superAdminChangeBytes(join.company, join.account, join.salt, join.change);
  const signature = L.signData(committeeSigningKeyFor(identity, join.company) as never, bytes);
  return Object.freeze({
    schema: COMMITTEE_JOIN_SCHEMA,
    origin: join.requester.origin,
    company: join.company,
    account: join.account,
    nonce: join.nonce,
    at,
    signer: shown.mine,
    signature: signature.value.toLowerCase(),
  });
}

export type CommitteeSignaturesRead =
  | { readonly ok: true; readonly signer: CommitteeKeyOnTheWire; readonly signatures: readonly CommitteeSeatSignature[] }
  | {
    readonly ok: false;
    readonly code: 'not-an-answer' | 'origin-mismatch' | 'nonce-mismatch' | 'other-change';
    readonly says: string;
  };

/** Whether a list of signatures has no gap and, on each contract, places in strictly increasing order: what the chain counts. */
const placesInOrder = (list: readonly unknown[]): boolean => {
  const last = new Map<string, number>();
  for (let i = 0; i < list.length; i += 1) {
    if (!(i in list)) return false;
    const s = list[i] as { address?: unknown; seat?: unknown } | null;
    if (typeof s !== 'object' || s === null || typeof s.seat !== 'number') return false;
    const at = String(s.address).toLowerCase();
    const before = last.get(at);
    if (before !== undefined && s.seat <= before) return false;
    last.set(at, s.seat);
  }
  return true;
};

/**
 * THE PAGE'S SIDE. Every expectation is the page's own: where it is, the nonce
 * it chose, the company, the committee it asked to install and the contracts
 * and counters it named. An answer signing anything else is refused, and so is
 * a list of signatures with a gap, or places on one contract out of order.
 */
export function readCommitteeSignatures(
  message: unknown,
  expecting: {
    readonly atOrigin: string;
    readonly expectingNonce: string;
    /** The company's label, and the account the page named as carrying it. */
    readonly company: CompanyLabel;
    readonly account: AccountAddress;
    readonly to: CommitteeOnTheWire;
    readonly contracts: ReadonlyArray<{ readonly address: string; readonly counter: string }>;
  },
): CommitteeSignaturesRead {
  const body = message as Partial<CommitteeUpdateSignatures> | null;
  if (typeof body !== 'object' || body === null || body.schema !== COMMITTEE_SIGNATURES_SCHEMA) {
    return { ok: false, code: 'not-an-answer', says: 'that is not a signed committee change.' };
  }
  if (body.origin !== expecting.atOrigin) {
    return { ok: false, code: 'origin-mismatch', says: `this was signed for ${String(body.origin)} and arrived at ${expecting.atOrigin}. It is refused.` };
  }
  if (body.nonce !== expecting.expectingNonce) {
    return { ok: false, code: 'nonce-mismatch', says: 'this answers a different request from the one that was sent.' };
  }
  const to = body.to;
  const sameTo = typeof to === 'object' && to !== null && to.threshold === expecting.to.threshold
    && Array.isArray(to.committee) && to.committee.length === expecting.to.committee.length
    && to.committee.every((k, i) => same(k, expecting.to.committee[i]!));
  if (readCompanyLabel(body.company) !== expecting.company
    || readAccountAddress(body.account) !== expecting.account || !sameTo) {
    return { ok: false, code: 'other-change', says: 'this signs a change to a different company or committee from the one asked about. It is refused.' };
  }
  const signer = body.signer;
  if (typeof signer !== 'object' || signer === null || signer.tag !== 'schnorr' || !HEX64.test(String(signer.value))) {
    return { ok: false, code: 'not-an-answer', says: 'this answer does not say which key signed.' };
  }
  const asked = new Map(expecting.contracts.map((c) => [c.address.toLowerCase(), c.counter]));
  if (!Array.isArray(body.signatures) || body.signatures.length === 0 || !placesInOrder(body.signatures) || !body.signatures.every((s) =>
    typeof s === 'object' && s !== null
    && asked.get(String(s.address).toLowerCase()) === s.counter && DIGITS.test(String(s.counter))
    && Number.isInteger(s.seat) && s.seat >= 0
    && typeof s.signature === 'object' && s.signature !== null
    && typeof s.signature.tag === 'string' && HEX.test(String(s.signature.value)))) {
    return { ok: false, code: 'other-change', says: 'this answer carries a signature for a contract or counter that was not asked about, or a list out of order. It is refused.' };
  }
  if (typeof body.at !== 'number' || !Number.isSafeInteger(body.at)) {
    return { ok: false, code: 'not-an-answer', says: 'that is not a signed committee change.' };
  }
  return {
    ok: true,
    signer: { tag: 'schnorr', value: signer.value.toLowerCase() },
    signatures: body.signatures.map((s) => ({
      address: s.address.toLowerCase(), counter: s.counter, seat: s.seat,
      signature: { tag: s.signature.tag, value: s.signature.value },
    })),
  };
}
