import type { Identity } from '../keys/derivation.js';
import { committeeKeyFor, committeeSigningKeyFor } from './committee-key.js';
import { usableOrigin } from './origin.js';
import type { CommitteeKeyOnTheWire, CommitteeOnTheWire, CommitteeRequest } from './request.js';

/**
 * WHAT THIS WALLET SHOWS, AND THEN SIGNS, WHEN A PAGE ASKS IT TO SIGN A CHANGE
 * TO WHO HOLDS A COMPANY'S RULES.
 *
 * **ONE CHANGE, AND THE WALLET MAKES IT.** For every contract named, the wallet
 * builds the one maintenance update that replaces the contract's whole list of
 * keys with the committee the screen showed, against the counter the page
 * named, and signs that update's bytes with this person's committee key for the
 * company. No bytes to sign arrive from the page, and no other kind of change
 * can be built from what does arrive, so the wallet can sign nothing it did not
 * show.
 *
 * **WHAT THE SCREEN SHOWS IS WORKED OUT HERE**, from the ask and from this
 * wallet's own key: for each contract, who joins, who leaves, the threshold
 * before and after, and the seat this person signs at. A contract this person
 * holds no seat on is refused before anything is shown, rather than silently
 * left out: a page asking for a signature this wallet cannot give is asking for
 * something other than what it says.
 *
 * **THIS FILE LOADS NO WEBASSEMBLY.** The ledger's classes are handed in by the
 * screen, which loads them; the arithmetic of the key itself is
 * `committee-key.ts`'s.
 */

export const COMMITTEE_SIGNATURES_SCHEMA = 'midnight-identity/committee-signatures/v1';

/** One signature, for one contract, at one seat of the committee that holds it now. */
export interface CommitteeSeatSignature {
  readonly address: string;
  /** The counter it was signed against, in decimal. */
  readonly counter: string;
  readonly seat: number;
  readonly signature: { readonly tag: string; readonly value: string };
}

/** What a person's press hands back to the page. */
export interface CommitteeSignatures {
  readonly schema: typeof COMMITTEE_SIGNATURES_SCHEMA;
  /** OBSERVED. A convenience for the requester, never an authority. */
  readonly origin: string;
  readonly company: string;
  readonly nonce: string;
  readonly at: number;
  /** This person's committee key for the company: the key every signature below verifies against. */
  readonly signer: CommitteeKeyOnTheWire;
  /** The committee the signatures install, exactly as it was shown. */
  readonly to: CommitteeOnTheWire;
  readonly signatures: readonly CommitteeSeatSignature[];
}

export class CommitteeSignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitteeSignError';
  }
}

/** What the screen shows for one contract. */
export interface ContractChangeShown {
  readonly contract: 'account' | 'vault';
  readonly address: string;
  readonly counter: string;
  /** Keys on the new committee and not on this contract's now. */
  readonly joins: readonly CommitteeKeyOnTheWire[];
  /** Keys on this contract's committee now and not on the new one. They lose their seat. */
  readonly leaves: readonly CommitteeKeyOnTheWire[];
  /** How many keys the page says hold this contract now. */
  readonly keysNow: number;
  readonly thresholdNow: number;
  readonly thresholdAfter: number;
  /** The seats this person's key holds on the committee now, in order. Never empty. */
  readonly seats: readonly number[];
}

/** What the screen shows for the whole ask. */
export interface CommitteeChangeShown {
  readonly mine: CommitteeKeyOnTheWire;
  /** Whether this person's own key is on the new committee. When it is not, they are signing themselves off. */
  readonly staysOn: boolean;
  readonly contracts: readonly ContractChangeShown[];
}

const same = (a: { value: string }, b: { value: string }): boolean => a.value.toLowerCase() === b.value.toLowerCase();

/**
 * **WHAT THIS PERSON IS ASKED TO SIGN, IN THE TERMS THEY DECIDE ON**, or a
 * refusal naming the first contract they cannot sign for.
 */
export function committeeChangeShown(identity: Identity, request: CommitteeRequest): CommitteeChangeShown {
  const mine = committeeKeyFor(identity, request.company) as unknown as CommitteeKeyOnTheWire;
  const contracts = request.contracts.map((c) => {
    const seats = c.now.committee.flatMap((k, i) => (same(k, mine) ? [i] : []));
    if (seats.length === 0) {
      throw new CommitteeSignError(
        `your key for this company is not on the committee that holds ${c.contract === 'account' ? 'its account' : `vault ${c.address}`} `
        + 'now, so this wallet cannot sign a change to it. Nothing has been signed.');
    }
    return Object.freeze({
      contract: c.contract,
      address: c.address,
      counter: c.counter,
      joins: request.to.committee.filter((k) => !c.now.committee.some((n) => same(n, k))),
      leaves: c.now.committee.filter((k) => !request.to.committee.some((n) => same(n, k))),
      keysNow: c.now.committee.length,
      thresholdNow: c.now.threshold,
      thresholdAfter: request.to.threshold,
      seats: Object.freeze(seats),
    });
  });
  return Object.freeze({ mine, staysOn: request.to.committee.some((k) => same(k, mine)), contracts: Object.freeze(contracts) });
}

/** The ledger classes a committee change is built and signed with. `@midnightntwrk/ledger-v9` satisfies it. */
export interface CommitteeSigningLedger {
  ContractMaintenanceAuthority: new (committee: never[], threshold: number, counter?: bigint) => object;
  ReplaceAuthority: new (authority: never) => object;
  MaintenanceUpdate: new (address: string, updates: never[], counter: bigint) => { readonly dataToSign: Uint8Array };
  signData(signingKey: never, data: Uint8Array): { tag: string; value: string };
}

/**
 * **THE PRESS.** Builds each contract's update from what was shown and signs it
 * at every seat this person holds. The signing key is worked out here, used,
 * and not kept or returned.
 */
export function committeeSignaturesFor(
  L: CommitteeSigningLedger, identity: Identity, request: CommitteeRequest, at: number,
): CommitteeSignatures {
  if (!usableOrigin(request.requester.origin)) {
    throw new CommitteeSignError('this wallet could not tell who asked, so nothing has been signed.');
  }
  const shown = committeeChangeShown(identity, request);
  const signingKey = committeeSigningKeyFor(identity, request.company);
  const committee = request.to.committee.map((k) => ({ tag: k.tag, value: k.value }));
  const signatures: CommitteeSeatSignature[] = [];
  for (const c of shown.contracts) {
    const counter = BigInt(c.counter);
    const authority = new L.ContractMaintenanceAuthority(committee as never[], request.to.threshold, counter + 1n);
    const update = new L.MaintenanceUpdate(c.address, [new L.ReplaceAuthority(authority as never) as never], counter);
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
    nonce: request.nonce,
    at,
    signer: shown.mine,
    to: request.to,
    signatures: Object.freeze(signatures),
  });
}

export type CommitteeSignaturesRead =
  | { readonly ok: true; readonly signer: CommitteeKeyOnTheWire; readonly signatures: readonly CommitteeSeatSignature[] }
  | {
    readonly ok: false;
    readonly code: 'not-an-answer' | 'origin-mismatch' | 'nonce-mismatch' | 'other-change';
    readonly says: string;
  };

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX = /^[0-9a-f]+$/u;
const DIGITS = /^[0-9]{1,20}$/u;

/**
 * THE PAGE'S SIDE. Every expectation is the page's own: where it is, the nonce
 * it chose, the company, the committee it asked to install and the contracts
 * and counters it named. An answer signing anything else is refused.
 */
export function readCommitteeSignatures(
  message: unknown,
  expecting: {
    readonly atOrigin: string;
    readonly expectingNonce: string;
    readonly company: string;
    readonly to: CommitteeOnTheWire;
    readonly contracts: ReadonlyArray<{ readonly address: string; readonly counter: string }>;
  },
): CommitteeSignaturesRead {
  const body = message as Partial<CommitteeSignatures> | null;
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
  if (String(body.company).toLowerCase() !== expecting.company.toLowerCase() || !sameTo) {
    return { ok: false, code: 'other-change', says: 'this signs a change to a different company or committee from the one asked about. It is refused.' };
  }
  const signer = body.signer;
  if (typeof signer !== 'object' || signer === null || signer.tag !== 'schnorr' || !HEX64.test(String(signer.value))) {
    return { ok: false, code: 'not-an-answer', says: 'this answer does not say which key signed.' };
  }
  const asked = new Map(expecting.contracts.map((c) => [c.address.toLowerCase(), c.counter]));
  if (!Array.isArray(body.signatures) || body.signatures.length === 0 || !body.signatures.every((s) =>
    typeof s === 'object' && s !== null
    && asked.get(String(s.address).toLowerCase()) === s.counter && DIGITS.test(String(s.counter))
    && Number.isInteger(s.seat) && s.seat >= 0
    && typeof s.signature === 'object' && s.signature !== null
    && typeof s.signature.tag === 'string' && HEX.test(String(s.signature.value)))) {
    return { ok: false, code: 'other-change', says: 'this answer carries a signature for a contract or counter that was not asked about. It is refused.' };
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
