import { base64 } from '@scure/base';
import type { Identity } from '../keys/derivation.js';
import { committeeKeyFor, committeeSigningKeyFor } from './committee-key.js';
import { usableOrigin } from './origin.js';
import { readAccountAddress, readCompanyLabel } from './company-label.js';
import type { AccountAddress, CompanyLabel } from './company-label.js';
import type { CommitteeKeyOnTheWire, CreationRequest } from './request.js';
import {
  buildCreationInsert, compareVerifierKeys, operationsFromContractState,
  type CreationInsertPrimitives, type OnChainOperation,
} from './contract-keys.js';

/**
 * WHAT THE FOUNDING SIGNER'S WALLET SHOWS, CHECKS AND SIGNS WHEN A PAGE ASKS IT
 * TO FINISH CREATING A COMPANY'S ACCOUNT.
 *
 * **NOTHING IS SENT UNTIL THIS IS SIGNED.** The account is created in two
 * transactions: the deploy, and one update that inserts the rest of its
 * circuits. The deploy is held from its first transaction by this person's own
 * committee key for the label this wallet drew, at a threshold of one, so the
 * update needs exactly one signature, this one.
 *
 * **THE WALLET READS THE DEPLOY ITSELF AND BUILDS WHAT IT SIGNS.** From the
 * unsent deploy: its address, worked out by the ledger from the deploy itself;
 * that it is held by this wallet's own key and nothing else, at a threshold of
 * one, never changed; that it carries the label this wallet drew; and that it
 * runs exactly this build's first circuits. From the keys the page names: that
 * they are exactly this build's other circuits. Only then does it build the one
 * update that inserts those keys into that address and nothing else, and sign
 * it. The address is what the person's wallet pins as the company's account.
 *
 * **WHAT "THIS BUILD'S" MEANS HERE**: digests of this build's compiled verifier
 * keys, taken when the wallet was built from the same files the page and the
 * service compile against, handed in by the screen. This file computes nothing
 * about keys on its own authority.
 *
 * **THIS FILE LOADS NO WEBASSEMBLY.** The ledger's classes and the label reader
 * are handed in by the screen, which loads them.
 */

export const CREATION_SIGNATURE_SCHEMA = 'midnight-identity/creation-signature/v1';

/** What a person's press hands back to the page: one signature, over the update this wallet built. */
export interface CreationSignature {
  readonly schema: typeof CREATION_SIGNATURE_SCHEMA;
  /** OBSERVED. A convenience for the requester, never an authority. */
  readonly origin: string;
  readonly company: CompanyLabel;
  /** The account the deploy creates, as this wallet worked it out from the deploy. */
  readonly account: AccountAddress;
  readonly nonce: string;
  readonly at: number;
  /** This person's committee key for the company, which holds the account. */
  readonly signer: CommitteeKeyOnTheWire;
  /** The signature over the second step, which installs the circuits named and nothing else. */
  readonly signature: { readonly tag: string; readonly value: string };
}

export class CreationSignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreationSignError';
  }
}

/** Digests of this build's compiled verifier keys, by circuit, in the order each step lists them. */
export interface ThisBuildsAccountKeys {
  readonly first: ReadonlyMap<string, Uint8Array>;
  readonly second: ReadonlyMap<string, Uint8Array>;
}

/** The ledger pieces this needs. `@midnightntwrk/ledger-v9` satisfies it. */
export interface CreationLedger extends CreationInsertPrimitives {
  Transaction: { deserialize(s: 'signature', p: 'proof', b: 'pre-binding', bytes: Uint8Array): unknown };
  signData(signingKey: never, data: Uint8Array): { tag: string; value: string };
}

/** What the screen shows: worked out by this wallet, never taken from the page. */
export interface CreationShown {
  readonly company: CompanyLabel;
  /** The account the deploy creates, worked out from the deploy. */
  readonly account: AccountAddress;
  readonly mine: CommitteeKeyOnTheWire;
  /** The circuits the deploy runs and the circuits the update adds, each this build's. */
  readonly deployed: readonly string[];
  readonly inserted: readonly string[];
}

const NOTHING = 'Nothing has been signed.';
const refuse = (why: string): never => { throw new CreationSignError(`${why} ${NOTHING}`); };

interface DeployShape {
  intents?: unknown;
  guaranteedOffer?: unknown;
  fallibleOffer?: unknown;
}
interface DeployAction {
  address?: unknown;
  initialState?: {
    maintenanceAuthority?: { committee?: Array<{ tag: string; value: string }>; threshold?: number; counter?: bigint };
    serialize?: () => Uint8Array;
  };
  entryPoint?: unknown;
}

/** The one deploy an unsent transaction carries, or a refusal. Read off the ledger's own objects. */
function theOneDeploy(L: CreationLedger, deploy: string): DeployAction {
  let tx: DeployShape;
  try {
    tx = L.Transaction.deserialize('signature', 'proof', 'pre-binding', base64.decode(deploy)) as DeployShape;
  } catch {
    return refuse('What the page sent as the deploy is not a transaction this wallet can read.');
  }
  const intents = tx.intents instanceof Map ? [...tx.intents.values()] : null;
  const actions = intents?.length === 1 ? (intents[0] as { actions?: unknown }).actions : null;
  if (!Array.isArray(actions) || actions.length !== 1 || tx.guaranteedOffer || tx.fallibleOffer) {
    return refuse('What the page sent does one thing more than deploy one contract, or moves coins.');
  }
  const action = actions[0] as DeployAction;
  if (action.initialState === undefined || action.address === undefined || action.entryPoint !== undefined) {
    return refuse('What the page sent does something other than deploy a contract.');
  }
  return action;
}

/** A key set compared over digests: the same verdicts `compareVerifierKeys` gives over bytes. */
function keysAreThisBuilds(
  operations: readonly OnChainOperation[], expected: ReadonlyMap<string, Uint8Array>, digest: (b: Uint8Array) => Uint8Array,
  address: string, what: string,
): void {
  const verdict = compareVerifierKeys(
    { state: 'read', address, operations: operations.map((o) => ({ name: o.name, verifierKey: digest(o.verifierKey) })) },
    expected,
  );
  if (verdict.verdict !== 'agree') refuse(`${what} are not this build's: ${verdict.why}`);
}

/**
 * **WHAT THIS PERSON IS ASKED TO SIGN, IN THE TERMS THEY DECIDE ON**, or a
 * refusal naming the first thing wrong with what the page sent.
 */
export function creationShown(
  L: CreationLedger, identity: Identity, request: CreationRequest, build: ThisBuildsAccountKeys,
  digest: (b: Uint8Array) => Uint8Array, labelIn: (serializedState: Uint8Array) => CompanyLabel | null,
): CreationShown {
  const action = theOneDeploy(L, request.deploy);
  const account = readAccountAddress(String(action.address).toLowerCase());
  if (account === null || account !== request.account) {
    return refuse('The page names an account the deploy it sent does not create.');
  }
  const mine = committeeKeyFor(identity, request.company) as unknown as CommitteeKeyOnTheWire;
  const authority = action.initialState!.maintenanceAuthority;
  const keys = authority?.committee ?? [];
  if (keys.length !== 1 || String(keys[0]!.tag) !== 'schnorr' || String(keys[0]!.value).toLowerCase() !== mine.value
    || authority?.threshold !== 1 || authority?.counter !== 0n) {
    return refuse('The deploy is not held by your own key for this company alone, from its first transaction.');
  }
  let label: CompanyLabel | null;
  try {
    label = labelIn(action.initialState!.serialize!());
  } catch {
    label = null;
  }
  if (label === null || label !== request.company) {
    return refuse('The deploy does not carry the label this wallet drew for the company.');
  }
  const deployed = operationsFromContractState(action.initialState, account);
  if (deployed.state !== 'read') return refuse(`The circuits the deploy runs cannot be read: ${deployed.why}`);
  keysAreThisBuilds(deployed.operations, build.first, digest, account, 'The circuits the deploy runs');
  const inserted = request.insert.map((k) => ({ name: k.circuit, verifierKey: base64.decode(k.key) }));
  keysAreThisBuilds(inserted, build.second, digest, account, 'The keys the page asks to add');
  return Object.freeze({
    company: request.company,
    account,
    mine,
    deployed: Object.freeze([...build.first.keys()]),
    inserted: Object.freeze([...build.second.keys()]),
  });
}

/**
 * **THE PRESS.** Builds the second step from what was checked and signs it.
 * The signing key is worked out here, used, and not kept or returned.
 */
export function creationSignatureFor(
  L: CreationLedger, identity: Identity, request: CreationRequest, at: number, build: ThisBuildsAccountKeys,
  digest: (b: Uint8Array) => Uint8Array, labelIn: (serializedState: Uint8Array) => CompanyLabel | null,
): CreationSignature {
  if (!usableOrigin(request.requester.origin)) {
    throw new CreationSignError(`This wallet could not tell who asked. ${NOTHING}`);
  }
  const shown = creationShown(L, identity, request, build, digest, labelIn);
  const keys = new Map(request.insert.map((k) => [k.circuit, base64.decode(k.key)] as [string, Uint8Array]));
  const built = buildCreationInsert(L, {
    address: shown.account, counter: 0n, onChain: shown.deployed, keys,
    steps: { first: shown.deployed, second: shown.inserted },
  });
  const signature = L.signData(committeeSigningKeyFor(identity, request.company) as never, built.update.dataToSign);
  return Object.freeze({
    schema: CREATION_SIGNATURE_SCHEMA,
    origin: request.requester.origin,
    company: request.company,
    account: shown.account,
    nonce: request.nonce,
    at,
    signer: shown.mine,
    signature: Object.freeze({ tag: signature.tag, value: signature.value }),
  });
}

export type CreationSignatureRead =
  | { readonly ok: true; readonly signer: CommitteeKeyOnTheWire; readonly signature: { readonly tag: string; readonly value: string } }
  | { readonly ok: false; readonly code: 'not-an-answer' | 'origin-mismatch' | 'nonce-mismatch' | 'other-company'; readonly says: string };

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX = /^[0-9a-f]+$/u;

/**
 * THE PAGE'S SIDE. Every expectation is the page's own: where it is, the nonce
 * it chose, the label the wallet drew, the account it built and the committee
 * key the wallet gave when it drew the label. An answer for anything else is
 * refused.
 */
export function readCreationSignature(
  message: unknown,
  expecting: {
    readonly atOrigin: string;
    readonly expectingNonce: string;
    readonly company: CompanyLabel;
    readonly account: AccountAddress;
    readonly signer: CommitteeKeyOnTheWire;
  },
): CreationSignatureRead {
  const body = message as Partial<CreationSignature> | null;
  if (typeof body !== 'object' || body === null || body.schema !== CREATION_SIGNATURE_SCHEMA) {
    return { ok: false, code: 'not-an-answer', says: 'that is not a signed creation.' };
  }
  if (body.origin !== expecting.atOrigin) {
    return { ok: false, code: 'origin-mismatch', says: `this was signed for ${String(body.origin)} and arrived at ${expecting.atOrigin}. It is refused.` };
  }
  if (body.nonce !== expecting.expectingNonce) {
    return { ok: false, code: 'nonce-mismatch', says: 'this answers a different request from the one that was sent.' };
  }
  if (readCompanyLabel(body.company) !== expecting.company || readAccountAddress(body.account) !== expecting.account) {
    return { ok: false, code: 'other-company', says: 'this signs the creation of a different company or account from the one asked about. It is refused.' };
  }
  const signer = body.signer;
  if (typeof signer !== 'object' || signer === null || signer.tag !== 'schnorr' || !HEX64.test(String(signer.value))
    || signer.value !== expecting.signer.value) {
    return { ok: false, code: 'other-company', says: 'this was signed by a key other than the one your wallet gave for this company. It is refused.' };
  }
  const sig = body.signature;
  if (typeof sig !== 'object' || sig === null || typeof sig.tag !== 'string' || !HEX.test(String(sig.value))
    || typeof body.at !== 'number' || !Number.isSafeInteger(body.at)) {
    return { ok: false, code: 'not-an-answer', says: 'that is not a signed creation.' };
  }
  return { ok: true, signer: { tag: 'schnorr', value: signer.value }, signature: { tag: sig.tag, value: sig.value } };
}
