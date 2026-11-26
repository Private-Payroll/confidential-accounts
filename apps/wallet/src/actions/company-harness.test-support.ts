/*
 * A company of a chosen size, held by the service's own routes in memory, and every wallet action run against it
 * with each call it makes counted. The company is the two-seat company that changes its signers on the chain, grown
 * to the size asked: its people and vendors are filed as invitations, its vaults named and given their nonce
 * secrets, each through the functions the product files them with, and the records anchored in as many batches as
 * asked; its runs, one-off payments, spending policies and open proposals are raised by the founding seat's own
 * wallet actions, and its runs' payments recorded paid as the chain records them. An action is the one the wallet
 * registers for its name, so what is counted is what the wallet does.
 *
 * Each step's calls to the service are counted by the route the runner matches them to, and logged in order with
 * the records each answer carried; a call the intent does not declare is refused as the runner refuses it. Payees
 * waiting to be admitted are filed on asking, by invitation and their own wallet's acceptance. The chain, builder and indexer reads go through doubles
 * and are counted too, by the door they come through: the holders, the chain's anchors and state, the builder,
 * and the indexer. A person's own wallet pays a call's fee from the DUST it holds and sends the call to the chain double.
 */
import { afterAll, beforeAll, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { x25519 } from '@noble/curves/ed25519.js';
import { IDBFactory } from 'fake-indexeddb';
import { ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import { addressFor } from 'midnight-identity';
import { identityFromSecret, type Identity } from 'midnight-identity/keys/derivation';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { checkShieldedAddress } from 'midnight-identity/wallet/address-shape';
import { fromHex, toHex, wrapKey, type Hex } from '../../../../src/core/crypto.js';
import { NIGHT } from '../../../../src/core/assets.js';
import { storedSignerLeaf } from '../../../../src/core/signer-leaf.js';
import { MidnightCommitments } from '../../../../src/midnight/commitments.js';
import { theNetwork } from '../../../../src/midnight/network.js';
import { startNonceSecret } from '../../../../src/midnight/company-nonce-secret.js';
import { SealedNotePool } from '../../../../src/midnight/vault-pool.js';
import { vaultRecordsRoutes, VAULT_RECORD_BODY_LIMIT } from '../../../../src/server/vault-records-route.js';
import { runRoutes } from '../../../../src/server/run-routes.js';
import { decideList } from '../../../../src/core/provenance.js';
import { directoryOf as directoryNowOf } from '../../../../src/server/seat-directory-route.js';
import { chainRead } from '../../../../src/server/a-company-of-two-seats.test-support.js';
import { recordsReaderOf } from '../../../../packages/web-shared/src/deposit-on-device.js';
import type { Keyring } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { InvitedSeatOnTheWire, VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { inviteHere } from '../../../../packages/web-shared/src/invitation-on-device.js';
import { acceptAsPayeeHere, openInvitationHere } from '../../../../packages/web-shared/src/invitation-taken-on-device.js';
import { signJoinCode } from 'midnight-identity/profile/join-code';
import { unshieldedPayeeFor } from '../../../../src/testing/payees.js';
import { fileVaultInfoHere } from '../../../../packages/web-shared/src/vault-info-filed-here.js';
import { vaultInfoRecordsFor } from '../../../../packages/web-shared/src/vault-info-here.js';
import { judgeIn } from '../../../../packages/web-shared/src/vault-page-doors.js';
import { spendingPolicyKeysOf } from '../../../../packages/web-shared/src/governed-call-arguments.js';
import { anchorTheRecordsHere } from '../../../../packages/web-shared/src/records-anchored-here.js';
import { throughAView, type AnchorDoorsBare } from '../../../../src/testing/anchor-doors-through-a-view.js';
import { anchorFunctions, anchorSentInATest } from '../../../../src/testing/record-tree-double.js';
import { writesOver, storeReachOver } from '../../../../src/testing/writes-over-a-send.js';
import { pureCircuits } from '../../../../contracts/managed/contract/index.js';
import { ACME, acmeChain, acmeReads, ORIGIN, vaultRecords } from '../../../../src/server/a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, ADDRESS, anchorDoorsOf, BO, chains, CO, committeeKeyOfLeaf, CY, deviceOf, directoryOf, events,
  KEY, LABEL, aRunPaidOnTheChain, openOnTheChain, paidOnChain, paidWholeOnTheChain, policiesSetOnTheChain, recoveryBuiltBy, rolesOnTheChain, seatOf, sendAs, store, takenFromTheOwnWallet, theChain, theInviteeTakesTheSeatHere, vaultBuiltBy, vaultsAdoptedOnTheChain, type Seat,
} from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { ownWalletOver } from './own-wallet-double.test-support.js';
import type { CompanyChain } from './company-reach.js';
import { companyKeyOf, companyReachFor, keptReach } from './company-reach.js';
import { StepRefused, type ActionDefinition, type ActionStep, type StepContext, type Words } from './definition.js';
import type { AnsweredCall } from '../../../../packages/web-shared/src/records-source.js';
import type { SealedRun } from '../../../../src/core/types.js';
import { rebuildDoorsIn, upkeepSteps } from './upkeep.js';
import { stepOverItsCall } from './step-views.test-support.js';
import { carriedNotAsHeld, recordsCarried } from './records-carried.test-support.js';
import { madeByTheWords, pinnedIn } from './seats-the-words-make.test-support.js';

/** Vaults whose state the indexer cannot give: an ask of the builder that names one fails, as one undecodable vault fails its ask. */
export const VAULTS_UNREADABLE = new Set<string>();

/* The wallet's chain, builder and own wallet are the company's doubles here; which seat's builder answers is the acting wallet's. */
const doubles = vi.hoisted(() => ({ chain: null as unknown, builder: null as unknown, uncounted: null as unknown, ownWallet: null as unknown }));
vi.mock('../chain/company-chain.js', () => ({ liveCompanyChain: () => doubles.chain }));
vi.mock('../chain/vault-builder-client.js', () => ({ walletVaultBuilder: () => doubles.builder }));
vi.mock('../chain/balance-doors.js', () => ({ liveBalanceDoors: () => (doubles.ownWallet as () => unknown)() }));
/* Each seated wallet's words make the company's seat it holds. */
vi.mock('midnight-identity/profile/seat-keys', async (real) => {
  const { seatKeysAsSeated } = await import('./seats-the-words-make.test-support.js');
  const { committeeKeyFor: keyFor } = await import('midnight-identity/profile/committee-key');
  return seatKeysAsSeated(await real<typeof import('midnight-identity/profile/seat-keys')>(), keyFor as never);
});
/*
 * A seat of this company signed its directory entry for a records key made from a fixed secret, not from its wallet's
 * own key for the company; so the key a seat's wallet holds for the company is the one its entry attests, and the
 * records sealed to that entry open on its own device. Any other wallet holds the key its identity gives.
 */
const keysOfSeats = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('midnight-identity/profile/unlock', async (real) => {
  const actual = await real<typeof import('midnight-identity/profile/unlock')>();
  const { committeeKeyFor: committeeKeyOf } = await import('midnight-identity/profile/committee-key');
  return {
    ...actual,
    unlockKeyFor: (identity: Identity, ask: Parameters<typeof actual.unlockKeyFor>[1]) => {
      const seat = keysOfSeats.get(committeeKeyOf(identity, ask.company as never).value);
      return seat === undefined ? actual.unlockKeyFor(identity, ask) : Uint8Array.from(seat);
    },
  };
});
vi.mock('./vault-secret-kept.js', async (real) => {
  const actual = await real<typeof import('./vault-secret-kept.js')>();
  const kept = new Map<string, string>();
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); }, removeItem: (k: string) => { kept.delete(k); } };
  return { ...actual, vaultSecretsKeptFor: (person: string) => actual.vaultSecretsKeptFor(person, storage) };
});

/* The wallet keeps what it holds in the browser's own storage; where the tests run without one, it is kept in memory. */
const stored = new Map<string, string>();
(globalThis as { localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage ??= {
  getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => { stored.set(k, v); }, removeItem: (k) => { stored.delete(k); },
};

/* The wallet's settings read the page's address as it loads; this company is served at one fixed address. */
const g = globalThis as { window?: unknown };
const hadAWindow = 'window' in g;
if (!hadAWindow) g.window = { location: { hostname: 'wallet.example', origin: 'https://wallet.example' } };
const { actionFor } = await import('./registry.js');
if (!hadAWindow) delete g.window;

const NETWORK = theNetwork();

/*
 * A person's own wallet in this company: it holds the DUST to pay a call's fee, pays it with one spend, and sends the
 * call to the company's chain, as the doors to a wallet's own funds give it.
 */
doubles.ownWallet = () => {
  const own = ownWalletOver({ takes: takenFromTheOwnWallet }, [], { account: ADDRESS });
  return {
    ...own, dustKeys: () => ({}),
    facade: async () => { const f = await own.facade(); return { ...f, dust: { ...f.dust, start: async () => {} } }; },
  };
};

/**
 * How many of each kind of record the company holds. People are invited and not yet admitted; seats count the founding
 * seat and the two it starts with. Runs are raised from the first vault, each paying a payee admitted for it and every
 * one admitted before; payments are the runs, oldest first, whose payments the chain records as paid; one-off payments
 * are raised from the first vault and left open; spending policies are set and carried out, one for each vault after the
 * first.
 */
export interface CompanySize {
  readonly people: number;
  readonly vendors?: number;
  readonly vaults?: number;
  readonly proposals?: number;
  readonly runs?: number;
  readonly payments?: number;
  readonly oneOffs?: number;
  readonly policies?: number;
  readonly seats?: number;
  readonly anchoredBatches?: number;
}

/** One person's wallet: who they are, and the keys it keeps for the company, the company's pin among them. */
export interface Wallet {
  readonly person: string;
  readonly identity: Identity;
  readonly secret: Uint8Array;
  kept: Keyring;
}

/** The door a chain, builder or indexer read came through. */
export type Door = 'holders' | 'onChain' | 'builder' | 'indexer';

/** One counted call: the step it was made in (from 1), and the route or the door and what was asked of it. */
export interface Counted { readonly step: number; readonly route: string }
export interface DoorCounted { readonly step: number; readonly door: Door; readonly ask: string }

/**
 * One answered call, as the service was asked it: the step, the route it matched, its path and body, the records its
 * answer carried, each named, and how it broke the rule what it carries is held to, or null.
 */
export interface Logged extends Counted {
  readonly method: 'GET' | 'PUT' | 'POST';
  readonly path: string;
  readonly body: string | undefined;
  readonly records: readonly string[];
  readonly carried: number;
  readonly notAsHeld: string | null;
}

/**
 * What one action did, step by step: each step's title, its service calls by route, its door reads by door, and the
 * records the service's answers to it carried.
 */
export interface StepCount {
  readonly step: number;
  readonly title: string;
  readonly routes: Readonly<Record<string, number>>;
  readonly doors: Readonly<Record<Door, number>>;
  readonly asks: Readonly<Record<string, number>>;
  readonly carried: number;
}
/** What one action did: what it told, its counts step by step, and every call it made, in the order it made them. */
export interface IntentCount { readonly told: Record<string, string | number>; readonly steps: readonly StepCount[]; readonly log: readonly Logged[] }

/** The company as the counts run against it. */
export interface Company {
  readonly size: () => Required<CompanySize>;
  readonly wallet: (person: string) => Wallet;
  readonly seats: () => readonly Seat[];
  readonly vaults: () => readonly Hex[];
  readonly fields: { readonly record: string; readonly company: string; readonly account: string };
  /**
   * Files more people, vendors and vaults until the company holds the size asked, and anchors them; then raises more
   * runs, records their payments paid, raises more one-off payments and sets more spending policies, and raises more
   * open proposals, each as the founding seat does it. Seats are fixed when the company is made. Each batch is anchored by
   * `anchored`, given the founding seat's doors before the step's view is opened over them, or as the product anchors
   * (through that view) when none is given. Refuses when the service and the chain do not then hold every run, paid
   * run, open one-off payment, spending policy and open proposal it raised.
   */
  readonly growTo: (size: CompanySize, anchored?: (doors: AnchorDoorsBare) => Promise<unknown>) => Promise<void>;
  /** The service as `person`'s device reaches it, each call counted in `served`. */
  readonly call: (person: string) => AnsweredCall;
  /** The company's key, which every member's device holds. */
  readonly companyKey: Hex;
  /** How many of the company's proposals the service holds open. */
  readonly openProposals: () => number;
  /** Every call the service was asked, by any person, since the company was made. */
  readonly served: () => number;
  /** The newest invitation link a wallet showed. */
  readonly lastLink: () => string;
  /** Files one more payee waiting to be admitted, as `payeeWaitingIn` files them, and anchors it. */
  readonly payeeWaiting: () => Promise<PayeeWaiting>;
  /** Raises one more one-off payment as `oneOffRaisedIn` raises it, counted, left open for the approvals it waits for. */
  readonly oneOffRaised: () => Promise<IntentCount>;
  /**
   * What the company holds now, as its pages read it: the people and the vendors invited, the vaults it was grown to and
   * those its account adopted, and the proposals the service holds, every one and those open.
   */
  readonly held: () => CompanyHeldOnItsPages;
}

/** What a company holds of each kind its pages read more of as it grows. */
export type CompanyHeldOnItsPages = Readonly<Record<'people' | 'vendors' | 'vaults' | 'proposals' | 'open proposals' | 'policies', number>>;

/** A payee invited by link and accepted with their own wallet's code, waiting for a seat to admit them. */
export interface PayeeWaiting { readonly id: string; readonly name: string; readonly fingerprint: string }

const ROUTE_REFUSED = 'not declared';
const DOOR_OF: Readonly<Record<string, Door>> = {
  holders: 'holders', callState: 'onChain', anchorsOnChain: 'onChain',
  roles: 'indexer', payments: 'indexer', roundsOnChain: 'indexer', invitedSeats: 'indexer', runsOutrun: 'indexer', vouchedRunIdentity: 'indexer',
  vaultOnChain: 'indexer', vaultsOnChain: 'indexer', eventsOf: 'indexer', createdBy: 'indexer', accountCallChain: 'indexer',
  chainAtOneBlock: 'indexer', vaultAsDeployed: 'indexer',
};
const doorOf = (ask: string): Door => DOOR_OF[ask] ?? 'builder';

/*
 * The step running now, so a door read lands on it; no step between actions. A door asked while no step is open is kept in
 * `late`, to be refused (`refuseLateDoorAsks`); `inFlight` is the door asks started and not yet answered.
 */
const tally: { step: number | null; doors: DoorCounted[]; late: string[]; inFlight: number } = { step: null, doors: [], late: [], inFlight: 0 };

/** How many door asks the open step has counted so far. */
export const doorsAsked = (): number => tally.doors.length;
/** How many door asks have started and not yet answered. */
export const doorsInFlight = (): number => tally.inFlight;
/** Refuses, naming each, any door asked while no step was open since the last call: a read that started after its step ended is in no count. */
export const refuseLateDoorAsks = (): void => {
  const late = tally.late.splice(0);
  if (late.length > 0) throw new Error(`a door was asked while no step was open, so the ask is in no count: ${late.join(', ')}`);
};

/** The route a call matches for the named intent, written as its method and pattern, or `not declared`. */
export const routeNameOf = (intent: string, method: string, path: string): string => {
  const shape = intentShapeOf(intent);
  const route = shape === undefined ? null : routeOf(shape, method, path);
  return route === null ? ROUTE_REFUSED : `${route.method} ${route.path}`;
};

/**
 * Wraps a step's transport so every call is counted under the route the runner would match it to, and, with `log`,
 * written to it with the records its answer carried and how they break the rule they are held to. A call the intent
 * does not declare is counted and then refused, as the runner refuses it, so an action that strays fails.
 */
export const countedCalls = (intent: string, step: number, call: AnsweredCall, into: Counted[], log?: Logged[]): AnsweredCall =>
  async (method, path, body) => {
    const route = routeNameOf(intent, method, path);
    into.push({ step, route });
    if (route === ROUTE_REFUSED) throw new Error(`the ${intent} act called ${method} ${path}, which it does not declare`);
    const answered = await call(method, path, body);
    if (log !== undefined) {
      const records = answered.status < 300 ? recordsCarried(method, path, body, answered.body) : [];
      log.push({ step, route, method, path, body, records, carried: records.length, notAsHeld: await carriedNotAsHeld(method, path, body, records) });
    }
    return answered;
  };

/**
 * Counts each ask of a double by its door while a step is running, and passes it on. The double answering is
 * looked up at each ask, so the acting wallet's own builder answers; its asks are listed as its own, so a copy of
 * it made by spreading it still counts.
 */
const countedDoors = <T extends object>(over: () => T): T => {
  const counted = (ask: string): unknown => {
    const real = (over() as Record<string, unknown>)[ask];
    if (typeof real !== 'function') return real;
    return (...a: unknown[]) => {
      if (tally.step !== null) tally.doors.push({ step: tally.step, door: doorOf(ask), ask });
      else tally.late.push(`${doorOf(ask)} ${ask}`);
      const answer = (real as (...x: unknown[]) => unknown).apply(over(), a);
      if (typeof (answer as { then?: unknown } | null)?.then !== 'function') return answer;
      tally.inFlight += 1;
      return (answer as Promise<unknown>).then((v) => { tally.inFlight -= 1; return v; }, (e: unknown) => { tally.inFlight -= 1; throw e; });
    };
  };
  return new Proxy({} as T, {
    get: (_t, ask) => (typeof ask === 'string' ? counted(ask) : undefined),
    has: (_t, ask) => ask in over(),
    ownKeys: () => Reflect.ownKeys(over()),
    getOwnPropertyDescriptor: (_t, ask) => (typeof ask === 'string' && ask in over()
      ? { configurable: true, enumerable: true, writable: false, value: counted(ask) } : undefined),
  });
};

const walletWith = (person: string, fill: number, kept: Keyring = { accounts: {} }): Wallet => {
  const secret = new Uint8Array(32).fill(fill);
  return { person, identity: identityFromSecret(secret as never), secret, kept };
};
const wrappingSecretOf = (s: Seat): Hex => toHex(new Uint8Array(32).fill(s.n + 40)) as Hex;
/*
 * A seat of the company in its signer's wallet: the seat their words make for the company (`madeByTheWords`), kept in
 * their saved keys with the company pinned to its account, as the founding seat's creation or a seat taken pins it.
 */
const seatedWallet = (s: Seat): Wallet => {
  const w = walletWith(s.person, s.n, pinnedIn({
    accounts: {
      [CO]: {
        signerId: `sgn_${s.person}`, signingSecret: s.signingSecret as Hex, wrappingSecret: wrappingSecretOf(s),
        blinding: s.opening.blinding as Hex, scope: s.opening.scope as Hex, opening: s.opening as never,
      },
    },
  }, LABEL, ADDRESS, s === ADA ? 'created' : 'invited'));
  madeByTheWords(w.identity, LABEL, s.signingSecret);
  return w;
};
const coinKeyOf = (w: Wallet): Hex => String(checkShieldedAddress(addressFor(w.identity.moneyAt(0).zswap, NETWORK as never).bech32, NETWORK as never).coinPublicKey).toLowerCase() as Hex;
const coinSecretOf = (w: Wallet): Hex => {
  const raw = ZswapSecretKeys.fromSeed(w.identity.moneyAt(0).zswap).coinSecretKey.yesIKnowTheSecurityImplicationsOfThis_serialize();
  return toHex(raw.slice(raw.length - 32)) as Hex;
};

/** The shielded address a wallet of this company is invited at. */
export const addressOfWallet = (w: Wallet): string => addressFor(w.identity.moneyAt(0).zswap, NETWORK as never).bech32;

/* The proof the invitee's wallet hands the chain to take a seat: here, the facts the chain double checks. */
const seatProofFrom = (invitees: () => readonly Wallet[]) => async (input: InvitedSeatOnTheWire): Promise<string> => {
  const invitee = invitees().find((w) => coinSecretOf(w).toLowerCase() === input.invite.coinSecretKey.toLowerCase());
  if (invitee === undefined) throw new Error('the proof was built with a coin key the address does not hold');
  const leaf = storedSignerLeaf(input.material as never, MidnightCommitments).toLowerCase();
  committeeKeyOfLeaf.set(leaf, committeeKeyFor(invitee.identity, LABEL) as never);
  return Buffer.from(JSON.stringify({
    proposal: input.proposal, leaf, threshold: input.newThreshold, coinPublicKey: coinKeyOf(invitee), addressSalt: input.invite.addressSalt,
  })).toString('base64');
};

const builderFor = (s: Seat | null, seated: () => Map<string, string>, invitees: () => readonly Wallet[]): VaultBuilderClient => ({
  ...(s === null ? {} : { ...deviceOf(s).builder, ...recoveryBuiltBy(s), ...vaultBuiltBy(s) }),
  ...anchorFunctions,
  anchor: anchorSentInATest,
  ownSeat: async (m: { signingSecret: string; blinding: string; scope: string }) =>
    seated().get(m.signingSecret.toLowerCase()) ?? storedSignerLeaf(m as never, MidnightCommitments).toLowerCase(),
  anchorsOnChain: async () => acmeChain.read(),
  invitedSeats: async ({ proposals }: { proposals: readonly string[] }) => acmeReads.invitedSeats(proposals),
  proposalIdentity: acmeReads.proposalIdentity,
  roundsOnChain: async ({ chainIds, seat }: { chainIds: readonly string[]; seat?: string }) =>
    theChain(chainIds, seat === undefined ? undefined : seated().get(seat.toLowerCase()) ?? s?.seat),
  companyWide: async () => toHex(pureCircuits.companyWide()).toLowerCase(),
  /* The keys a spending policy is kept under, made with the account's own functions, as the device's worker makes them. */
  spendingPolicyKeys: async (input: Parameters<VaultBuilderClient['spendingPolicyKeys']>[0]) => spendingPolicyKeysOf({ accountPure: pureCircuits as never }, input),
  spendingPolicyKeysOfEach: async (pairs: Parameters<VaultBuilderClient['spendingPolicyKeysOfEach']>[0]) => pairs.map((input) => ({ status: 'fulfilled', value: spendingPolicyKeysOf({ accountPure: pureCircuits as never }, input) })),
  vaultOnChain: async () => vaultAsTheIndexerHoldsIt(),
  vaultsOnChain: async ({ vaults }: { vaults: readonly string[] }) => {
    const unreadable = vaults.find((v) => VAULTS_UNREADABLE.has(v.toLowerCase()));
    if (unreadable !== undefined) throw new Error(`the indexer could not read vault ${unreadable}`);
    return vaults.map(() => vaultAsTheIndexerHoldsIt());
  },
  eventsOf: async () => [],
  createdBy: async () => null,
  runsOutrun: async () => ({}),
  vouchedRunIdentity: async () => null,
  seatInvited: seatProofFrom(invitees),
  /* The account's own list of the vaults it retired: this company retires none. */
  superAdmins: { reads: () => ({ accountAt: async () => ({ authority: {}, vaults: { adopted: [], retired: [] } }) }) },
}) as unknown as VaultBuilderClient;

/*
 * Each vault as the indexer holds it: this account's, on this build's circuits, holding no notes and no nonce secret yet,
 * with nothing in its journals, and enough Night in public to pay a run.
 */
const vaultAsTheIndexerHoldsIt = () => ({
  onChain: true, state: '', notes: [], notesFromThisBuild: true, retired: false, everCreated: [], account: ADDRESS, started: true, nonceCommitment: '00'.repeat(32), splitJournal: [],
  circuits: null, accountCircuits: null, publicBalances: [{ token: NIGHT, amount: '1000000000000' }],
});

/* The vault service is reached over the machine's own network with the fetch this file loaded with, whatever a page has put in its place. */
const ownFetch = globalThis.fetch.bind(globalThis);

/* The service as a wallet reaches it: the chain's own sends are taken by the chain double, a vault's records by the vault service. */
const serviceFor = (vaultBase: () => string) => (person: string): AnsweredCall => async (method, path, body) => {
  if (method === 'POST' && /^\/api\/invites\/[^/]+\/seat$/u.test(path)) {
    const { tx } = JSON.parse(body!) as { tx: string };
    const { proposal, leaf, threshold, coinPublicKey, addressSalt } = JSON.parse(Buffer.from(tx, 'base64').toString('utf8')) as {
      proposal: string; leaf: string; threshold: string; coinPublicKey: string; addressSalt: string;
    };
    try {
      theInviteeTakesTheSeatHere(proposal, { coinPublicKey, addressSalt }, leaf);
    } catch (e) {
      return { status: 409, body: { error: (e as Error).message } };
    }
    if (threshold !== '0') { const h = chains.get(CO)!; chains.set(CO, { ...h, approvals: Number(threshold), seatBar: Math.max(h.seatBar, Number(threshold)) }); }
    return { status: 200, body: { sent: true } };
  }
  if (method === 'POST' && path === `/api/accounts/${CO}/proven`) {
    const { previous, batch, held, tag } = JSON.parse((JSON.parse(body!) as { tx: string }).tx) as { previous: Hex; batch: Hex; held: never; tag: Hex };
    try {
      acmeChain.move(previous, batch, held, tag);
    } catch (e) {
      return { status: 409, body: { error: (e as Error).message } };
    }
    events.push('anchored');
    return { status: 200, body: {} };
  }
  /* The vault records, one by one or many in one read, and the company's runs, are the vault service's. */
  if (path.startsWith('/api/vaults/') || /^\/api\/accounts\/[^/]+\/(vault-records\/read|runs)(\?|$)/u.test(path)) {
    const r = await ownFetch(vaultBase() + path, {
      method, ...(body === undefined ? {} : { body }), headers: { 'content-type': 'application/json', 'x-test-person': person },
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  return sendAs(person)(path, { method, ...(body === undefined ? {} : { body }) } as never);
};

const databases = new Map<string, IDBFactory>();
/* Each wallet keeps what its device has checked in its own browser storage, kept between its actions. */
const inItsOwnBrowser = (w: Wallet): void => {
  if (!databases.has(w.person)) databases.set(w.person, new IDBFactory());
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = databases.get(w.person);
};

const contextFor = (w: Wallet, intent: ActIntent, at: { step: number; steps: number }, call: AnsweredCall, told: Record<string, string | number>): StepContext => {
  inItsOwnBrowser(w);
  return stepOverItsCall({
    intent, asker: { origin: ORIGIN, name: 'Payroll', rdns: 'example.payroll' }, person: w.person,
    held: {
      identity: w.identity, secret: w.secret as never, account: 0,
      wallet: { drewTheLabel: () => false },
    },
    at: at as never, signal: new AbortController().signal,
    relay: async () => { throw new Error('an action of this company sends through its calls, never a bare relay'); },
    call,
    tell: (o: Readonly<Record<string, string | number>>) => { Object.assign(told, o); },
    show: (words: Words) => { const link = words.values?.['link']; if (typeof link === 'string') linksShown.push(link); },
    confirm: async () => {},
    releaseReadKeys: () => {},
    sentByTheWallet: () => {}, seenOnTheChain: () => {},
    keyring: { open: () => ({ read: () => w.kept }) as never, keep: async (change: (k: Keyring) => Keyring) => { w.kept = change(w.kept); } },
  }) as unknown as StepContext;
};

/* The invitation links the wallets showed, newest last. */
const linksShown: string[] = [];

/* Who is acting: the builder that answers is their seat's, or the bare builder of a wallet that holds no seat yet. */
const actor: { is: Wallet | null } = { is: null };
let serviceAs: (person: string) => AnsweredCall = () => { throw new Error('the company is not made yet'); };

const countsOf = (steps: readonly { readonly title: { readonly key: string } }[], calls: readonly Counted[], doors: readonly DoorCounted[], log: readonly Logged[]): StepCount[] =>
  steps.map((s, i) => {
    const routes: Record<string, number> = {};
    for (const c of calls) if (c.step === i + 1) routes[c.route] = (routes[c.route] ?? 0) + 1;
    const byDoor: Record<Door, number> = { holders: 0, onChain: 0, builder: 0, indexer: 0 };
    const asks: Record<string, number> = {};
    for (const d of doors) {
      if (d.step !== i + 1) continue;
      byDoor[d.door] += 1;
      asks[`${d.door} ${d.ask}`] = (asks[`${d.door} ${d.ask}`] ?? 0) + 1;
    }
    const carried = log.filter((c) => c.step === i + 1).reduce((n, c) => n + c.carried, 0);
    return { step: i + 1, title: s.title.key, routes, doors: byDoor, asks, carried };
  });

/* Runs steps as `w`'s wallet, with every service call and door read counted against the step that made it. */
async function countedSteps(name: string, intent: ActIntent, steps: readonly ActionStep[], w: Wallet, told: Record<string, string | number>): Promise<IntentCount> {
  refuseLateDoorAsks();
  const calls: Counted[] = [];
  const log: Logged[] = [];
  const doors: DoorCounted[] = [];
  actor.is = w;
  const service = serviceAs(w.person);
  try {
    for (const [i, s] of steps.entries()) {
      if (s.notNeeded?.(told) === true) continue;
      tally.step = i + 1;
      tally.doors = doors;
      try {
        await s.run(contextFor(w, intent, { step: i + 1, steps: steps.length }, countedCalls(name, i + 1, service, calls, log), told));
      } catch (e) {
        if (e instanceof StepRefused) throw new Error(`the ${name} act stopped at step ${i + 1}: ${e.words.key} ${JSON.stringify(e.words.values ?? {})}`);
        throw e;
      }
    }
  } finally {
    tally.step = null;
  }
  return { told, steps: countsOf(steps, calls, doors, log), log };
}

/**
 * Runs the intent the wallet registers under `name` as `by`'s wallet, step by step, with every service call and
 * every door read counted against the step that made it. Refuses, naming the step, when the action refuses.
 */
export async function runIntent(name: string, intent: ActIntent, company: Company, by: string): Promise<IntentCount> {
  return runIntentAs(name, intent, company, by, (steps) => steps);
}

/**
 * Runs the intent the wallet registers under `name` as `runIntent` does, over the steps `stepsOf` makes of the action's
 * own: so a check can be watched to fail on a step list one change away from the action's.
 */
export async function runIntentAs(
  name: string, intent: ActIntent, company: Company, by: string, stepsOf: (steps: readonly ActionStep[]) => readonly ActionStep[],
): Promise<IntentCount> {
  const def: ActionDefinition | null = actionFor(name);
  if (def === null) throw new Error(`the wallet registers no ${name} act`);
  const w = company.wallet(by);
  const told: Record<string, string | number> = {};
  const refused = await def.check(intent, contextFor(w, intent, { step: 0, steps: 0 }, serviceAs(w.person), told).held);
  if (refused !== null) throw new Error(`the ${name} act refused before it ran: ${refused.key}`);
  return countedSteps(name, intent, stepsOf(def.steps(intent)), w, told);
}

/**
 * Runs, counted, the upkeep a seat's wallet does at the start and end of its next act: what folds a newly admitted
 * signer's keys into the roster and gives them each vault's secret. Counted under the routes of giving vault keys,
 * the act that is upkeep and nothing else.
 */
export async function runUpkeep(company: Company, by: string): Promise<IntentCount> {
  const intent = { name: 'give-vault-keys', fields: company.fields } as unknown as ActIntent;
  const w = company.wallet(by);
  const read = keptReach((c) => companyReachFor(c, doubles.chain as CompanyChain, doubles.builder as VaultBuilderClient, why));
  const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
  return countedSteps('give-vault-keys', intent, [upkeep.first, upkeep.last], w, {});
}

const why = (key: string) => ({ key });
/**
 * Runs `open` as `by`'s device, with every read of the chain, builder and indexer doubles counted against it, and hands
 * back what it came to with those reads. A screen's opening is counted this way; an action's steps by `runIntent`.
 */
export async function doorsCountedWhile<T>(company: Company, by: string, open: () => Promise<T>): Promise<{ readonly value: T; readonly doors: readonly DoorCounted[] }> {
  refuseLateDoorAsks();
  const doors: DoorCounted[] = [];
  actor.is = company.wallet(by);
  tally.step = 1;
  tally.doors = doors;
  try {
    return { value: await open(), doors };
  } finally {
    tally.step = null;
  }
}

/**
 * The company's chain and the acting device's builder, each ask counted by its door while one is being counted; and
 * the same chain uncounted, as a person's own wallet reads it to answer what the page asks it.
 */
export const companyDoors = (): { readonly chain: CompanyChain; readonly builder: VaultBuilderClient; readonly walletReads: CompanyChain } =>
  ({ chain: doubles.chain as CompanyChain, builder: doubles.builder as VaultBuilderClient, walletReads: doubles.uncounted as CompanyChain });

const vaultIdOf = (i: number): Hex => (0xa0 + i).toString(16).repeat(32) as Hex;
const sizeOf = (s: CompanySize, seats: number): Required<CompanySize> => ({
  people: s.people, vendors: s.vendors ?? 0, vaults: s.vaults ?? 0, proposals: s.proposals ?? 0, runs: s.runs ?? 0,
  payments: s.payments ?? 0, oneOffs: s.oneOffs ?? 0, policies: s.policies ?? 0, seats, anchoredBatches: Math.max(1, s.anchoredBatches ?? 1),
});
/** Refuses a size whose records `growTo` cannot file, naming why. */
export const refuseWhatIsNotFiled = (s: CompanySize): void => {
  const want = sizeOf(s, 0);
  if (want.runs > 0 && want.people > 0) throw new Error('this company raises no run beside people only invited: a run is drawn only when everyone on the roster is admitted');
  if ((want.runs > 0 || want.oneOffs > 0) && want.vaults === 0) throw new Error('a run or a one-off payment is paid from the company\'s first vault, and this size holds none');
  if (want.payments > want.runs) throw new Error('payments are the payments of runs raised, so a size holds no more of them than runs');
  if (want.policies > Math.max(0, want.vaults - 1)) throw new Error('a spending policy is set for each vault after the first, so a size holds fewer of them than vaults');
};

/* What `growTo` raises through the founding seat's actions, by what each is counted as. */
const RAISED = ['runs', 'runs open', 'payments', 'oneOffs', 'policies', 'proposals'] as const;
type Raised = Readonly<Record<(typeof RAISED)[number], number>>;
/*
 * What the company holds now of what `growTo` raises, as the service and the test's chain hold it: the runs the service
 * lists, those of them whose proposal the chain holds open, and those the chain records every payment of as paid; the
 * one-off payments the chain holds open (its open payments that are no run's); the vaults the account holds a spending
 * policy set on; and the proposals of every other kind the chain holds open.
 */
const raisedHeld = (): Raised => {
  const runs = store.listRuns(CO);
  const chainIdsOf = (r: SealedRun): string[] => Object.values(r.proposalIds ?? {}).map((id) => String(store.getProposal(id)?.chainId ?? '').toLowerCase());
  const open = openOnTheChain();
  const openIds = new Set(open.map((o) => o.id));
  const ofRuns = new Set(runs.flatMap(chainIdsOf));
  return {
    runs: runs.length, 'runs open': runs.filter((r) => chainIdsOf(r).some((id) => openIds.has(id))).length,
    payments: runs.filter(paidWholeOnTheChain).length, oneOffs: open.filter((o) => o.change === 'run' && !ofRuns.has(o.id)).length,
    policies: policiesSetOnTheChain(), proposals: open.filter((o) => o.change !== 'run').length,
  };
};
/*
 * Refuses, naming each, what `growTo` was to raise and the company does not hold as raised: what it holds of each now,
 * less what it held `before`, must be the number `raising` says was raised, so a step of the growth skipped, or a raise
 * left in another state than the one asked, is found.
 */
const refuseWhatWasNotRaised = (before: Raised, raising: Raised): void => {
  const now = raisedHeld();
  const asked = (k: keyof Raised): number => Math.max(0, raising[k]);
  const short = RAISED.filter((k) => now[k] - before[k] !== asked(k));
  if (short.length > 0) {
    throw new Error(`the company grown does not hold what was raised: ${short.map((k) => `${k} ${now[k] - before[k]} more, where ${asked(k)} were raised`).join('; ')}`);
  }
};

/* One filing of the company's records as the founding seat files it, through the function the product files it with. */
type Filing = () => Promise<unknown>;
const personFiled = (i: number): Filing => () => inviteHere(ACME, ADA, 'employee', {
  name: `Person ${i}`, email: `person${i}@acme.co`, title: 'Engineer', asset: 'TEST', baseAmount: 1000n, classification: 'full-time', startDate: '2026-10-01',
} as never, ORIGIN, writesOver(sendAs(ADA.person)));
const vendorFiled = (i: number): Filing => () => inviteHere(ACME, ADA, 'vendor', {
  name: `Vendor ${i}`, email: null, startDate: '2026-10-01', terms: { kind: 'one-off' }, network: NETWORK,
} as never, ORIGIN, writesOver(sendAs(ADA.person)));
const vaultNamed = (vault: Hex, i: number): Filing => () => fileVaultInfoHere({
  accountId: CO, companyKeys: KEY as never, signingSecret: ADA.signingSecret as Hex, directory: directoryOf(ADA), entered: ADA.entered,
  records: vaultInfoRecordsFor(CO, ADA.signingSecret as Hex, async (asked) => judgeIn(await directoryOf(ADA)(asked)),
    storeReachOver((path, init) => sendAs(ADA.person)(path, init as never), CO)),
}, { vault, name: `Vault ${i}`, description: '', over: null });

/*
 * Payee `n`, invited by the founding seat through the function the product invites with, and accepted from their own
 * wallet with the code it signs for the company; then the company's records are anchored, so no action finds it unanchored.
 */
const payeeWaitingIn = async (n: number): Promise<PayeeWaiting> => {
  const wallet = new Uint8Array(32).fill(60 + n);
  const name = `Payee ${n}`;
  const made = await inviteHere(ACME, ADA, 'employee', {
    name, email: `payee${n}@acme.co`, title: 'Engineer', asset: NIGHT, baseAmount: 1000n, classification: 'full-time', startDate: '2026-10-01',
  } as never, ORIGIN, writesOver(sendAs(ADA.person)));
  const code = signJoinCode(identityFromSecret(wallet as never), LABEL, `usr_payee${n}`, {
    kind: 'payee', address: unshieldedPayeeFor(toHex(wallet) as Hex, NETWORK as never).bech32, payslipKey: 'cd'.repeat(32),
  });
  const accepted = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs(`usr_payee${n}`));
  await anchorTheRecordsHere(throughAView(anchorDoorsOf(ADA)));
  return { id: made.person!, name, fingerprint: accepted.fingerprint };
};

/*
 * The chain as the wallet reads it: the seats the test chain holds, the vaults filed and those its account adopted, its
 * anchor's head, the spending policies its roles hold, and its record of payments.
 */
const chainHolding = (vaults: readonly Hex[]): CompanyChain => ({
  holders: async () => ({ ...(await acmeReads.holders()), adoptedVaults: [...vaults, ...vaultsAdoptedOnTheChain()] }) as never,
  callState: async () => ({ blockHash: 'b', accountState: acmeChain.head(), parameters: 'PP' }),
  roles: async (_a, _l, keys) => rolesOnTheChain(keys) as never,
  /* The account's record of payments as the test's chain holds it: the entries paid, and the rounds it holds open of the proposals the company filed. */
  payments: async (_a, _l, entries) => {
    const rounds = await theChain(store.listProposals(CO).map((p) => String(p.chainId).toLowerCase()));
    return {
      payKeyCommitment: null, held: entries.filter((e) => paidOnChain.has(e.toLowerCase())),
      openRounds: Object.keys(rounds).filter((id) => rounds[id]!.held === 'open').sort(), entries: paidOnChain.size,
    };
  },
  indexer: { indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' },
});

/* Each seat's wallet is handed the company's key, wrapped to the wrapping key it keeps. */
const keysWrappedTo = (seats: readonly Seat[]): void => {
  store.putAccount({
    ...store.getAccount(CO)!,
    wrappedKeys: seats.map((s) => ({ signerId: `sgn_${s.person}`, ...wrapKey(KEY, toHex(x25519.getPublicKey(fromHex(wrappingSecretOf(s)))) as Hex) })),
  } as never);
};

/* The service's vault records and the company's runs, served on their own, to the company's members only. */
const vaultService = async (): Promise<ReturnType<express.Express['listen']>> => {
  const app = express();
  app.use((req, _res, next) => { const p = req.headers['x-test-person']; if (typeof p === 'string') (req as { userId?: string }).userId = p; next(); });
  const userOf = (req: express.Request): string | undefined => (req as { userId?: string }).userId;
  const signedIn: express.RequestHandler = (req, res, next) => (userOf(req) !== undefined ? next() : res.status(401).json({ error: 'sign in' }));
  const member: express.RequestHandler = (req, res, next) => (store.getAccount(String(req.params['id']))?.memberUserIds.includes(userOf(req)!)
    ? next() : res.status(403).json({ error: 'not a member' }));
  /*
   * The list of the company's runs is a route the service defines in its own entry file, not in a set of routes; here it
   * answers what the store holds by the same verdict that route gives a list on a chain: refused when a run no chain wrote
   * is listed beside one a chain did.
   */
  app.get('/api/accounts/:id/runs', signedIn, member, (req, res) => {
    const verdict = decideList('chain', store.listRuns(String(req.params['id'])));
    if (verdict.listed) res.json(verdict.rows);
    else res.status(409).json({ error: verdict.message, code: verdict.refusal, counts: verdict.counts });
  });
  app.use(runRoutes({ signedIn, member, store: store as never, directoryOf: (id) => directoryNowOf(store, chainRead, id), wiring: () => null }));
  app.use(express.json({ limit: VAULT_RECORD_BODY_LIMIT }));
  app.use(vaultRecordsRoutes({ records: vaultRecords, mayTouch: async (person) => store.getAccount(CO)?.memberUserIds.includes(person) ?? false }));
  return new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
};

/* A vault's start as the founding seat's device files it: its nonce secret, and its record of notes, empty. */
const vaultStartedBy = (ada: Wallet, call: AnsweredCall, chain: CompanyChain, builder: VaultBuilderClient, vault: Hex): Filing => async () => {
  const fields = { record: CO, company: LABEL as string, account: ADDRESS as string };
  const ctx = contextFor(ada, { name: 'invite', fields } as unknown as ActIntent, { step: 1, steps: 1 }, call, {});
  const r = await keptReach((c) => companyReachFor(c, chain, builder, why)).at(ctx);
  const key = companyKeyOf({ held: { identity: ada.identity, secret: ada.secret }, asker: ctx.asker } as never, LABEL, ADDRESS);
  const doors = rebuildDoorsIn(ctx, r, {});
  await doors.records('nonce-secret').put(vault, startNonceSecret(vault, [recordsReaderOf(fromHex(key))]));
  await new SealedNotePool(doors.records('pool'), { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers).create(vault, { notes: [] });
};

/*
 * The open proposals a company can be grown by, raised as the founding seat raises them: changes of the approvals the
 * company asks for, then the retiring of each vault. A change already raised is the same proposal, so each raise asks
 * for another.
 */
const raisableIn = (company: Company): readonly (readonly [string, Record<string, string>])[] => [
  ...Array.from({ length: company.seats().length }, (_, i) => String(i + 1)).filter((t) => t !== '2').map((threshold) => ['change-threshold', { threshold }] as const),
  ...company.vaults().map((vault) => ['retire-vault', { vault }] as const),
];

/* The wallet action `name` run as the founding seat's wallet, on the company's own fields and `more`. */
const byTheFoundingSeat = (company: Company, name: string, more: Readonly<Record<string, string>>): Promise<IntentCount> =>
  runIntent(name, { name, fields: { ...company.fields, ...more } } as never, company, ADA.person);

/*
 * In a company that asks for one approval, raises a change to two, which one seat carries out, so every raise after it
 * waits for a second seat.
 */
async function twoApprovalsAsked(company: Company): Promise<void> {
  if (chains.get(CO)!.approvals < 2) await byTheFoundingSeat(company, 'change-threshold', { threshold: '2' });
}

/* Raises the company's open proposal number `at` (from 0), after two approvals are asked, so it waits for a second seat. */
async function proposalRaisedIn(company: Company, at: number): Promise<void> {
  await twoApprovalsAsked(company);
  const next = raisableIn(company)[at];
  if (next === undefined) throw new Error(`this company raises at most ${raisableIn(company).length} open proposals: one for each other count of approvals and one for each vault`);
  const state = (await byTheFoundingSeat(company, ...next)).told['state'];
  if (state !== 'waiting-for-approvals') throw new Error(`a ${next[0]} raised to grow the company was ${String(state)}, not left open`);
}

/*
 * The company's run number `n` (from 0), raised as the founding seat raises one: a payee waiting is admitted first, then
 * the run of the employees admitted is drawn on the device for a month of its own, from the first vault in Night paid in
 * public, its window opening an hour from now. Hands back the run as the service keeps it.
 */
async function runRaisedIn(company: Company, n: number): Promise<SealedRun> {
  const p = await company.payeeWaiting();
  await byTheFoundingSeat(company, 'admit-person', { kind: 'employee', person: p.id, personName: p.name, fingerprint: p.fingerprint });
  const now = Math.floor(Date.now() / 1000);
  const raised = await byTheFoundingSeat(company, 'raise-run', {
    period: `2027-${String(3 + n).padStart(2, '0')}`, vault: company.vaults()[0]!, token: NIGHT, form: 'public', opensAt: String(now + 3600), closesAt: String(now + 86_400),
  });
  const run = store.listRuns(CO).find((r) => r.id === raised.told['run']);
  if (raised.told['state'] !== 'raised' || run === undefined) throw new Error(`a run raised to grow the company was left at ${JSON.stringify(raised.told)}, not raised`);
  return run;
}

/*
 * A one-off payment of the first vault's public Night to a public payee of its own, the `n`th (from 0), raised from the
 * founding seat's own wallet; the company asks two approvals, so it is left open, waiting for a second seat.
 */
async function oneOffRaisedIn(company: Company, n: number): Promise<IntentCount> {
  const payee = unshieldedPayeeFor(toHex(new Uint8Array(32).fill(90 + n)) as Hex, NETWORK as never).bech32;
  const raised = await byTheFoundingSeat(company, 'one-off-payment', { vault: company.vaults()[0]!, token: NIGHT, amount: String(10 + n), payee, reason: `One-off ${n}` });
  if (raised.told['state'] !== 'awaiting-approvals') throw new Error(`a one-off payment raised was left at ${JSON.stringify(raised.told)}, not waiting for its approvals`);
  return raised;
}

/*
 * The spending policy number `n` (from 0) set for the vault after it in Night: raised from the founding seat's wallet,
 * then approved and carried out from the second seat's.
 */
async function policySetIn(company: Company, n: number): Promise<void> {
  const vault = company.vaults()[1 + n]!;
  const raised = await byTheFoundingSeat(company, 'set-spending-policy', {
    vault, token: NIGHT, bands: '100:1,500:2,900:2,1000:3', periodLimit: '1000', periodStart: '0', periodLength: '2592000',
  });
  const approved = await runIntent('approve-proposal', { name: 'approve-proposal', fields: {
    ...company.fields, kind: 'spending-policy', vault, proposal: String(raised.told['proposal']),
  } } as never, company, BO.person);
  if (approved.told['state'] !== 'carried-out') throw new Error(`a spending policy set to grow the company was left at ${JSON.stringify(approved.told)}, not carried out`);
}

/**
 * Makes the company and seeds it to `records` before the tests of the file run: the seats are made with it and
 * fixed; people, vendors and vaults are filed, and anchored in `anchoredBatches` batches; then its runs, their payments,
 * its one-off payments and its spending policies are filed, and `proposals` open proposals are raised. Call it where the file's tests are declared, once. With `vaultRows`, the service also lists each
 * vault it adopts, as the service's own list of a company's vaults answers it; without, it lists none.
 */
export function aCompanyOf(records: CompanySize, served: { readonly vaultRows?: boolean } = {}): Company {
  refuseWhatIsNotFiled(records);
  const extra = Array.from({ length: Math.max(0, (records.seats ?? 3) - 3) }, (_, i) => seatOf(`seat${i + 4}`, 20 + i, LABEL, ADDRESS, CO, ADA));
  aCompanyWhoseSignersChange(2, extra, served);
  const seats = (): readonly Seat[] => [ADA, BO, CY, ...extra];
  for (const s of seats()) keysOfSeats.set(s.committeeKey.value, new Uint8Array(32).fill(s.n + 100));
  const wallets = new Map<string, Wallet>();
  const invitees: Wallet[] = [];
  const vaults: Hex[] = [];
  const held = { people: 0, vendors: 0, vaults: 0, proposals: 0, runs: 0, payments: 0, oneOffs: 0, policies: 0 };
  const runsRaised: SealedRun[] = [];
  let oneOffsRaised = 0;
  let size = sizeOf({ people: 0 }, seats().length);
  let received = 0;
  let payees = 0;
  let vaultBase = '';
  let vaultServer: ReturnType<express.Express['listen']> | null = null;

  const seated = (): Map<string, string> => new Map(seats().map((s) => [s.signingSecret.toLowerCase(), s.seat]));
  const builders = new Map<string, VaultBuilderClient>();
  const builderOf = (s: Seat | null): VaultBuilderClient => {
    const key = s?.person ?? '';
    if (!builders.has(key)) builders.set(key, builderFor(s, seated, () => invitees));
    return builders.get(key)!;
  };
  const chain = chainHolding(vaults);
  const service = serviceFor(() => vaultBase);
  const wallet = (person: string): Wallet => {
    const seat = seats().find((s) => s.person === person);
    if (!wallets.has(person)) {
      if (seat !== undefined) wallets.set(person, seatedWallet(seat));
      else { const w = walletWith(person, 81 + invitees.length); invitees.push(w); wallets.set(person, w); }
    }
    return wallets.get(person)!;
  };
  const fields = { record: CO, company: LABEL as string, account: ADDRESS as string };

  const vaultStarted = (vault: Hex): Filing => vaultStartedBy(wallet(ADA.person), service(ADA.person), chain, builderOf(ADA), vault);
  /* Raises the runs, records their payments paid, raises the one-off payments and sets the spending policies `want` holds, after two approvals are asked. */
  const moneyFiledTo = async (want: Required<CompanySize>): Promise<void> => {
    if (want.runs > held.runs || want.oneOffs > held.oneOffs || want.policies > held.policies) await twoApprovalsAsked(company);
    for (; held.runs < want.runs; held.runs += 1) runsRaised.push(await runRaisedIn(company, held.runs));
    for (; held.payments < want.payments; held.payments += 1) await aRunPaidOnTheChain(runsRaised[held.payments]!);
    for (; held.oneOffs < want.oneOffs; held.oneOffs += 1) await oneOffRaisedIn(company, oneOffsRaised++);
    for (; held.policies < want.policies; held.policies += 1) await policySetIn(company, held.policies);
  };
  const growTo = async (asked: CompanySize, anchored: (doors: AnchorDoorsBare) => Promise<unknown> = (d) => anchorTheRecordsHere(throughAView(d))): Promise<void> => {
    refuseWhatIsNotFiled(asked);
    const want = sizeOf(asked, seats().length);
    const before = raisedHeld();
    const raising: Raised = {
      runs: want.runs - held.runs, 'runs open': want.runs - held.runs, payments: want.payments - held.payments,
      oneOffs: want.oneOffs - held.oneOffs, policies: want.policies - held.policies, proposals: want.proposals - held.proposals,
    };
    const filings: Filing[] = [];
    for (; held.people < want.people; held.people += 1) filings.push(personFiled(held.people));
    for (; held.vendors < want.vendors; held.vendors += 1) filings.push(vendorFiled(held.vendors));
    for (; held.vaults < want.vaults; held.vaults += 1) {
      const vault = vaultIdOf(held.vaults);
      vaults.push(vault);
      if (served.vaultRows === true) store.putCompanyVault({ accountId: CO, vault, deployedAt: `2026-10-01T00:00:${String(held.vaults).padStart(2, '0')}.000Z`, deployRef: `ref${held.vaults}`, intended: { committee: [], threshold: 1 }, bornHeld: true });
      filings.push(vaultNamed(vault, held.vaults), vaultStarted(vault));
    }
    const per = Math.ceil(filings.length / want.anchoredBatches);
    for (let at = 0; at < filings.length; at += per) {
      for (const f of filings.slice(at, at + per)) await f();
      await anchored(anchorDoorsOf(ADA));
    }
    await moneyFiledTo(want);
    for (; held.proposals < want.proposals; held.proposals += 1) await proposalRaisedIn(company, held.proposals);
    refuseWhatWasNotRaised(before, raising);
    size = want;
  };
  const company: Company = {
    size: () => size, wallet, seats, vaults: () => [...vaults], fields, growTo, served: () => received, lastLink: () => linksShown.at(-1) ?? '',
    call: (person) => serviceAs(person), companyKey: KEY as Hex,
    openProposals: () => store.listProposals(CO).filter((p) => (p as { readonly status?: string }).status === 'open').length,
    payeeWaiting: () => payeeWaitingIn(payees += 1),
    oneOffRaised: () => oneOffRaisedIn(company, oneOffsRaised++),
    held: () => ({
      people: store.listInvites(CO).filter((i) => i.kind === 'employee').length, vendors: store.listInvites(CO).filter((i) => i.kind === 'vendor').length,
      vaults: new Set([...vaults, ...vaultsAdoptedOnTheChain()].map((v) => v.toLowerCase())).size,
      proposals: store.listProposals(CO).length, 'open proposals': company.openProposals(), policies: policiesSetOnTheChain(),
    }),
  };

  beforeAll(async () => {
    serviceAs = (person) => { const s = service(person); return async (m, p, b) => { received += 1; return s(m, p, b); }; };
    doubles.chain = countedDoors(() => chain);
    doubles.uncounted = chain;
    /*
     * Each device has a builder of its own: what one device's builder has kept is never what another device's first asks
     * find. The wallet keeps the first builder it is given for as long as it runs, as one person's wallet does, and every
     * person's wallet runs here in one process, so each builder answers as the seat of the person acting when it is asked.
     */
    const proxies = new Map<string, VaultBuilderClient>();
    const acting = (): Seat | null => seats().find((s) => s.person === (actor.is?.person ?? '')) ?? null;
    Object.defineProperty(doubles, 'builder', {
      configurable: true,
      get: () => {
        const person = actor.is?.person ?? '';
        if (!proxies.has(person)) proxies.set(person, countedDoors(() => builderOf(acting())));
        return proxies.get(person)!;
      },
    });
    keysWrappedTo(seats());
    vaultServer = await vaultService();
    vaultBase = `http://127.0.0.1:${(vaultServer.address() as AddressInfo).port}`;
    await growTo(records);
    events.length = 0;
  }, 170_000);
  afterAll(() => new Promise<void>((resolve) => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (vaultServer === null) resolve(); else vaultServer.close(() => resolve());
  }));

  return company;
}
